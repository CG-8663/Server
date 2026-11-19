// Backups: this server's apps and settings, saved with restic into a store on the server's own drives,
// then copied to a NAS share over SMB on a schedule.
//
// - restic does the work: only changed data is saved after the first run, every backup is a point in
//   time you can go back to, and everything is encrypted with one recovery key. A system restic is used
//   when it's new enough; otherwise its official build is downloaded once and checked against a pinned
//   SHA-256 (no installer run, no root).
// - The NAS copy uses smbclient (already on every server, from Samba): the store is a folder of files that
//   never change once written, so copying it is "upload what the NAS doesn't have yet, then remove what
//   was pruned". The NAS password is kept in a file only this server's user can read, and handed to
//   smbclient through a short-lived file, never on a command line.
// - App files are often owned by the container's own users, so restic runs inside `podman unshare`
//   (the same user namespace the apps use) to read and restore them with the right owners.
// - Everything here is owner-only (server.mjs wraps the procedures).
import {spawn} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join, relative, sep} from 'node:path'

import {RpcError} from './rpc.mjs'

export const RESTIC_VERSION = '0.18.1'
// From restic's SHA256SUMS for 0.18.1 (https://github.com/restic/restic/releases/tag/v0.18.1).
export const RESTIC_SHA256 = {
	amd64: '680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d',
	arm64: '87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45',
}
const resticUrl = (arch) => `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2`

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*|\d{1,3}(?:\.\d{1,3}){3})$/
// Share and folder names go into smbclient's command lines, so quotes, control characters and the
// characters SMB forbids are refused (that also rules out command injection through them).
const NAME = /^[^\\/:*?"<>|\x00-\x1f]{1,80}$/
const USER = /^[^\x00-\x1f"]{1,128}$/
const SNAPSHOT = /^[0-9a-f]{8,64}$/
const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

const DEFAULTS = {
	nas: null, // {host, port?, share, folder, username, domain?}
	repo: '/Home/Backups/Omarchy Server',
	include: {apps: true, settings: true, machineBackups: false},
	pauseApps: true,
	schedule: {frequency: 'daily', hour: 3, weekday: 0},
	keep: {daily: 7, weekly: 4, monthly: 6},
	keySaved: false,
	lastCheckAt: 0,
}

const exists = (p) => access(p).then(() => true, () => false)
const clampInt = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)

export function recoveryKey(bytes = randomBytes(20)) {
	// 32 characters from an alphabet without look-alikes, in groups of four: easy to write down.
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
	let out = ''
	let acc = 0n
	for (const b of bytes) acc = (acc << 8n) | BigInt(b)
	for (let i = 0; i < 32; i++) {
		out += alphabet[Number(acc % BigInt(alphabet.length))]
		acc /= BigInt(alphabet.length)
	}
	return out.match(/.{4}/g).join('-')
}

// When the next scheduled backup is due, in the server's local time.
export function nextRun(schedule, from = Date.now()) {
	if (!schedule || schedule.frequency === 'off') return null
	const at = new Date(from)
	at.setSeconds(0, 0)
	at.setMinutes(0)
	at.setHours(schedule.hour)
	if (schedule.frequency === 'weekly') {
		const add = (schedule.weekday - at.getDay() + 7) % 7
		at.setDate(at.getDate() + add)
		if (at.getTime() <= from) at.setDate(at.getDate() + 7)
	} else if (at.getTime() <= from) {
		at.setDate(at.getDate() + 1)
	}
	return at.getTime()
}

// smbclient's recursive `ls`: entries, with "\dir\sub" headers (share-absolute) before each folder.
export function parseSmbListing(text, base = '') {
	const files = new Map()
	const root = base ? `\\${base.split('/').join('\\')}` : ''
	let dir = ''
	for (const line of String(text).split('\n')) {
		const head = /^\\(.*)$/.exec(line)
		if (head) {
			const full = `\\${head[1]}`
			dir = root && (full === root || full.startsWith(root + '\\')) ? full.slice(root.length).replace(/^\\/, '').split('\\').join('/') : head[1].split('\\').join('/')
			continue
		}
		const m = /^ {2}(\S+)\s+([A-Z]*)\s+(\d+)\s+\w{3} \w{3}\s+\d+ [\d:]+ \d{4}\s*$/.exec(line)
		if (!m || m[1] === '.' || m[1] === '..' || m[2].includes('D')) continue
		files.set(dir ? `${dir}/${m[1]}` : m[1], Number(m[3]))
	}
	return files
}

function smbErrors(text) {
	return [...String(text).matchAll(/NT_STATUS_[A-Z_]+/g)].map((m) => m[0]).filter((s) => s !== 'NT_STATUS_OBJECT_NAME_COLLISION')
}

function smbMessage(errors) {
	const e = errors[0] ?? ''
	if (/LOGON_FAILURE|WRONG_PASSWORD|ACCOUNT_RESTRICTION/.test(e)) return 'The NAS didn’t accept that username and password.'
	if (/ACCESS_DENIED/.test(e)) return 'The NAS account can’t write to that share. Give it write access on the NAS.'
	if (/BAD_NETWORK_NAME/.test(e)) return 'That share doesn’t exist on the NAS.'
	if (/HOST_UNREACHABLE|CONNECTION_REFUSED|IO_TIMEOUT|NETWORK_UNREACHABLE|NOT_FOUND|RESOLVE/.test(e)) return 'Couldn’t reach the NAS. Check its name or address, and that it’s on.'
	if (/DISK_FULL/.test(e)) return 'The NAS share is full.'
	return `The NAS said ${e || 'no'}.`
}

function defaultSpawn(cmd, args, {env, input, onLine, timeout = 6 * 60 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
		let out = ''
		let err = ''
		let buf = ''
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
		child.stdout.on('data', (d) => {
			const s = d.toString()
			out += s
			if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024)
			if (onLine) {
				buf += s
				const lines = buf.split('\n')
				buf = lines.pop()
				for (const l of lines) onLine(l)
			}
		})
		child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-64 * 1024)))
		child.on('error', (e) => (clearTimeout(timer), reject(e)))
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) return resolve({stdout: out, stderr: err})
			const e = new Error(`${cmd}: ${(err || out).trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`)
			e.code = code
			e.stdout = out
			e.stderr = err
			reject(e)
		})
		child.stdin.on('error', () => {})
		child.stdin.end(input ?? '')
	})
}

export function createBackups({dataDir, home = os.homedir(), serverDataDir = join(home, '.config', 'omarchy-server'), files, apps, run = defaultSpawn, fetchImpl = globalThis.fetch, arch = os.arch() === 'arm64' ? 'arm64' : 'amd64', resticPath = null, unshare = true, now = () => Date.now(), timers = true}) {
	const dir = join(dataDir, 'backups')
	const configFile = join(dir, 'config.json')
	const secretFile = join(dir, 'secrets.json')
	const historyFile = join(dir, 'history.json')
	const keyFile = join(dir, 'recovery-key')
	const binDir = join(dir, 'bin')
	let config = structuredClone(DEFAULTS)
	let secrets = {} // {nasPassword}
	let history = []
	let job = null // {step, progress, startedAt}
	let engine = null // {path, version}
	let engineInstall = null
	let timer = null

	const ready = (async () => {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700).catch(() => {})
		config = {...structuredClone(DEFAULTS), ...JSON.parse((await readFile(configFile, 'utf8').catch(() => null)) ?? '{}')}
		secrets = JSON.parse((await readFile(secretFile, 'utf8').catch(() => null)) ?? '{}')
		history = JSON.parse((await readFile(historyFile, 'utf8').catch(() => null)) ?? '[]')
		// A run that was going when the server stopped.
		if (history[0] && !history[0].endedAt) Object.assign(history[0], {endedAt: history[0].startedAt, ok: false, error: 'Stopped when the server restarted'})
	})()

	const writePrivate = async (file, text) => {
		const tmp = `${file}.${process.pid}.tmp`
		await writeFile(tmp, text, {mode: 0o600})
		await rename(tmp, file)
	}
	const saveConfig = () => writePrivate(configFile, JSON.stringify(config, null, '\t'))
	const saveSecrets = () => writePrivate(secretFile, JSON.stringify(secrets))
	const saveHistory = () => writePrivate(historyFile, JSON.stringify(history.slice(0, 40), null, '\t'))
	const hasKey = () => exists(keyFile)

	// ---- the restic engine ----------------------------------------------------------------------
	async function versionOf(bin) {
		try {
			const {stdout} = await run(bin, ['version'], {env: baseEnv(), timeout: 20_000})
			const m = /restic (\d+)\.(\d+)\.(\d+)/.exec(stdout)
			return m ? {major: +m[1], minor: +m[2], text: `${m[1]}.${m[2]}.${m[3]}`} : null
		} catch {
			return null
		}
	}
	async function ensureEngine() {
		if (engine) return engine
		engineInstall ??= (async () => {
			if (resticPath) {
				const v = await versionOf(resticPath)
				if (!v) throw new RpcError('PRECONDITION_FAILED', 'The backup engine (restic) didn’t start.')
				return (engine = {path: resticPath, version: v.text})
			}
			const system = await versionOf('restic')
			if (system && (system.major > 0 || system.minor >= 16)) return (engine = {path: 'restic', version: system.text})
			const bin = join(binDir, `restic-${RESTIC_VERSION}`)
			const have = await versionOf(bin)
			if (have) return (engine = {path: bin, version: have.text})
			await mkdir(binDir, {recursive: true, mode: 0o700})
			const res = await fetchImpl(resticUrl(arch), {redirect: 'follow'})
			if (!res.ok) throw new RpcError('PRECONDITION_FAILED', `Couldn’t download the backup engine (restic): ${res.status}`)
			const packed = Buffer.from(await res.arrayBuffer())
			const sum = createHash('sha256').update(packed).digest('hex')
			if (sum !== RESTIC_SHA256[arch]) throw new RpcError('PRECONDITION_FAILED', 'The downloaded backup engine didn’t match its published checksum, so it wasn’t used.')
			const tmp = `${bin}-${process.pid}`
			await writeFile(`${tmp}.bz2`, packed, {mode: 0o600})
			await run('bzip2', ['-df', `${tmp}.bz2`], {env: baseEnv(), timeout: 120_000})
			await chmod(tmp, 0o700)
			await rename(tmp, bin)
			const v = await versionOf(bin)
			if (!v) throw new RpcError('PRECONDITION_FAILED', 'The backup engine (restic) didn’t start.')
			return (engine = {path: bin, version: v.text})
		})().finally(() => (engineInstall = null))
		return engineInstall
	}

	// Only what restic needs: no RESTIC_* or other secrets inherited from the service's environment.
	function baseEnv() {
		const keep = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CONTAINERS_CONF', 'TMPDIR']
		const env = {LC_ALL: 'C'}
		for (const k of keep) if (process.env[k]) env[k] = process.env[k]
		env.HOME ??= home
		return env
	}
	async function repoReal() {
		const {real} = await files.resolve(config.repo, {mustExist: false}).catch(async (e) => {
			// Its parent folder isn't there yet: make each level, checking every one stays inside Home.
			const parts = config.repo.split('/').filter(Boolean)
			for (let i = 2; i < parts.length; i++) {
				const level = await files.resolve(`/${parts.slice(0, i).join('/')}`, {mustExist: false})
				if (!(await exists(level.real))) await mkdir(level.real, {mode: 0o700})
			}
			return files.resolve(config.repo, {mustExist: false}).catch(() => {
				throw e
			})
		})
		return real
	}
	async function restic(args, {inside = false, onLine, timeout} = {}) {
		const {path} = await ensureEngine()
		const env = {...baseEnv(), RESTIC_REPOSITORY: await repoReal(), RESTIC_PASSWORD_FILE: keyFile, RESTIC_CACHE_DIR: join(dir, 'cache'), RESTIC_PROGRESS_FPS: '0.5'}
		if (inside && unshare) return run('podman', ['unshare', path, ...args], {env, onLine, timeout})
		return run(path, args, {env, onLine, timeout})
	}

	// ---- the NAS (SMB) -------------------------------------------------------------------------
	function cleanNas(input = {}, {needShare = true} = {}) {
		let host = String(input.host ?? '').trim().replace(/^smb:\/\//i, '').replace(/^\\\\/, '').replace(/[\\/].*$/, '')
		let port = input.port == null || input.port === '' ? null : Number(input.port)
		const hp = /^(.+):(\d{1,5})$/.exec(host)
		if (hp) [host, port] = [hp[1], Number(hp[2])]
		if (!HOST.test(host)) throw new RpcError('BAD_REQUEST', 'Enter the NAS’s name or address, like nas.local or 192.168.1.20')
		if (port != null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new RpcError('BAD_REQUEST', 'That port isn’t valid')
		const username = String(input.username ?? '').trim()
		if (!USER.test(username)) throw new RpcError('BAD_REQUEST', 'Enter the NAS account’s username')
		const domain = String(input.domain ?? '').trim()
		if (domain && !USER.test(domain)) throw new RpcError('BAD_REQUEST', 'That workgroup isn’t valid')
		const share = String(input.share ?? '').trim()
		if (needShare && !NAME.test(share)) throw new RpcError('BAD_REQUEST', 'Choose a share on the NAS')
		const folder = String(input.folder ?? 'Omarchy Server')
			.split('/')
			.map((p) => p.trim())
			.filter(Boolean)
		if (needShare && (!folder.length || folder.length > 6 || folder.some((p) => !NAME.test(p) || p === '.' || p === '..'))) throw new RpcError('BAD_REQUEST', 'Name the folder with letters, numbers and spaces')
		return {host, ...(port ? {port} : {}), share, folder: folder.join('/'), username, ...(domain ? {domain} : {})}
	}
	async function smb(nas, password, {share = nas.share, lines = [], list = false, timeout = 6 * 60 * 60_000} = {}) {
		if (typeof password !== 'string' || /[\r\n]/.test(password)) throw new RpcError('BAD_REQUEST', 'That password isn’t valid')
		const auth = join(dir, `smb-auth-${randomBytes(6).toString('hex')}`)
		await writeFile(auth, `username=${nas.username}\npassword=${password}\n${nas.domain ? `domain=${nas.domain}\n` : ''}`, {mode: 0o600})
		try {
			const args = list ? ['-L', `//${nas.host}`, '-g'] : [`//${nas.host}/${share}`]
			args.push('-A', auth, '-m', 'SMB3', '-t', '60')
			if (nas.port) args.push('-p', String(nas.port))
			let out
			try {
				out = await run('smbclient', args, {env: baseEnv(), input: lines.map((l) => `${l}\n`).join(''), timeout})
			} catch (e) {
				out = {stdout: e.stdout ?? '', stderr: e.stderr ?? e.message}
				if (e.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'smbclient isn’t installed on this server. Run Omarchy Server’s installer once more.')
			}
			const text = `${out.stdout}\n${out.stderr}`
			return {text, errors: smbErrors(text)}
		} finally {
			await rm(auth, {force: true})
		}
	}
	const q = (s) => `"${s}"`
	// cd into the backup folder, making each level as needed.
	const intoFolder = (folder) => folder.split('/').flatMap((p) => [`mkdir ${q(p)}`, `cd ${q(p)}`])

	async function remoteFiles(nas, password) {
		const r = await smb(nas, password, {lines: [...intoFolder(nas.folder), 'recurse ON', 'ls']})
		const bad = r.errors.filter((e) => e !== 'NT_STATUS_NO_SUCH_FILE')
		if (bad.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(bad))
		return parseSmbListing(r.text, nas.folder)
	}

	async function localFiles(root) {
		const out = new Map()
		async function walk(d) {
			for (const e of await readdir(d, {withFileTypes: true}).catch(() => [])) {
				const p = join(d, e.name)
				if (e.isDirectory()) await walk(p)
				else if (e.isFile()) out.set(relative(root, p).split(sep).join('/'), (await stat(p)).size)
			}
		}
		await walk(root)
		return out
	}

	// Copy the store to the NAS: new files first (pack data, then indexes, then the snapshots that point at
	// them), then remove what the NAS has that the store no longer does. Locks never leave the server.
	const ORDER = ['config', 'keys', 'data', 'index', 'snapshots']
	const rank = (p) => {
		const i = ORDER.indexOf(p.split('/')[0])
		return i < 0 ? ORDER.length : i
	}
	async function mirror(onProgress = () => {}) {
		const nas = config.nas
		const root = await repoReal()
		const local = await localFiles(root)
		for (const k of [...local.keys()]) if (k.startsWith('locks/')) local.delete(k)
		const remote = await remoteFiles(nas, secrets.nasPassword)
		const send = [...local].filter(([p, size]) => remote.get(p) !== size).sort((a, b) => rank(a[0]) - rank(b[0]))
		const drop = [...remote.keys()].filter((p) => !local.has(p) && ORDER.includes(p.split('/')[0])).sort((a, b) => rank(b) - rank(a))
		const total = send.reduce((t, [, s]) => t + s, 0) || 1
		let sent = 0
		const dirs = [...new Set(send.map(([p]) => dirname(p)).filter((d) => d !== '.'))]
		const mk = []
		for (const d of dirs.sort()) {
			const parts = d.split('/')
			for (let i = 1; i <= parts.length; i++) mk.push(`mkdir ${q(parts.slice(0, i).join('/'))}`)
		}
		const batches = []
		for (let i = 0; i < send.length; i += 200) batches.push(send.slice(i, i + 200))
		let first = true
		for (const batch of batches) {
			const r = await smb(nas, secrets.nasPassword, {lines: [...intoFolder(nas.folder), ...(first ? [...new Set(mk)] : []), ...batch.map(([p]) => `put ${q(join(root, p))} ${q(p)}`)]})
			first = false
			if (r.errors.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(r.errors))
			sent += batch.reduce((t, [, s]) => t + s, 0)
			onProgress(sent / total)
		}
		for (let i = 0; i < drop.length; i += 200) {
			const r = await smb(nas, secrets.nasPassword, {lines: [...intoFolder(nas.folder), ...drop.slice(i, i + 200).map((p) => `del ${q(p)}`)]})
			const bad = r.errors.filter((e) => e !== 'NT_STATUS_NO_SUCH_FILE' && e !== 'NT_STATUS_OBJECT_NAME_NOT_FOUND')
			if (bad.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(bad))
		}
		// Check: everything the store has is on the NAS, at the same size.
		const after = await remoteFiles(nas, secrets.nasPassword)
		const missing = [...local].filter(([p, size]) => after.get(p) !== size)
		if (missing.length) throw new RpcError('PRECONDITION_FAILED', `${missing.length} file${missing.length === 1 ? '' : 's'} didn’t reach the NAS`)
		return {uploaded: send.length, uploadedBytes: send.reduce((t, [, s]) => t + s, 0), removed: drop.length}
	}

	// ---- one backup run --------------------------------------------------------------------------
	const settingsExcludes = () => [
		join(dataDir, 'apps', 'installed'),
		join(dataDir, 'apps', 'stores'),
		join(dataDir, 'backups'),
		join(dataDir, 'machines', '**', '*.qcow2'),
		join(dataDir, 'machines', '**', '*.img'),
		join(dataDir, 'machines', '**', '*.iso'),
		join(dataDir, 'machines', '**', '*.raw'),
		join(dataDir, '**', '*.sock'),
		join(dataDir, '**', 'cache'),
	]

	function progressLine(base, span, step) {
		return (line) => {
			try {
				const m = JSON.parse(line)
				if (m.message_type === 'status' && typeof m.percent_done === 'number') job = {...job, step, progress: Math.min(1, base + span * m.percent_done)}
			} catch {
				/* not JSON */
			}
		}
	}
	async function backupOne(paths, tags, extra, step, base, span) {
		job = {...job, step, progress: base}
		const args = ['backup', '--json', '--host', 'omarchy-server', ...tags.flatMap((t) => ['--tag', t]), ...extra, ...paths]
		const {stdout} = await restic(args, {inside: tags.some((t) => t.startsWith('app:')), onLine: progressLine(base, span, step)})
		const summary = stdout
			.split('\n')
			.map((l) => {
				try {
					return JSON.parse(l)
				} catch {
					return null
				}
			})
			.find((m) => m?.message_type === 'summary')
		return {added: summary?.data_added ?? 0, files: summary?.total_files_processed ?? 0}
	}

	async function runBackup(reason = 'manual') {
		await ready
		if (job) throw new RpcError('CONFLICT', 'A backup is already running')
		if (!config.nas || !(await hasKey())) throw new RpcError('PRECONDITION_FAILED', 'Set up backups first')
		const entry = {id: randomBytes(4).toString('hex'), reason, startedAt: now(), endedAt: null, ok: false, error: null, items: [], added: 0, nas: null}
		history.unshift(entry)
		await saveHistory()
		job = {step: 'Getting ready', progress: 0, startedAt: entry.startedAt}
		const done = (async () => {
			try {
				await ensureRepo()
				const targets = config.include.apps ? await apps.backupTargets() : []
				const steps = targets.length + (config.include.settings ? 1 : 0) + (config.include.machineBackups ? 1 : 0)
				const span = 0.7 / Math.max(1, steps)
				let n = 0
				for (const app of targets) {
					if (!(await exists(app.dir))) continue
					const pause = config.pauseApps && app.running
					if (pause) await apps.pauseForBackup(app.id).catch(() => {})
					try {
						const r = await backupOne([app.dir], [`app:${app.id}`], [], `Saving ${app.name}`, n * span, span)
						entry.items.push({kind: 'app', id: app.id, name: app.name, ok: true, added: r.added})
						entry.added += r.added
					} catch (e) {
						entry.items.push({kind: 'app', id: app.id, name: app.name, ok: false, error: e.message})
					} finally {
						if (pause) await apps.resumeAfterBackup(app.id).catch((e) => entry.items.push({kind: 'app', id: app.id, name: app.name, ok: false, error: `Didn’t start again: ${e.message}`}))
					}
					n++
				}
				if (config.include.settings) {
					const paths = [dataDir, ...((await exists(serverDataDir)) ? [serverDataDir] : [])]
					const r = await backupOne(paths, ['settings'], settingsExcludes().flatMap((x) => ['--exclude', x]), 'Saving server settings', n * span, span)
					entry.items.push({kind: 'settings', name: 'Server settings', ok: true, added: r.added})
					entry.added += r.added
					n++
				}
				if (config.include.machineBackups) {
					const {real} = await files.resolve('/Home/Backups/Machines', {mustExist: false})
					if (await exists(real)) {
						const r = await backupOne([real], ['machines'], [], 'Saving VM backups', n * span, span)
						entry.items.push({kind: 'machines', name: 'VM backups', ok: true, added: r.added})
						entry.added += r.added
					}
					n++
				}
				job = {...job, step: 'Tidying old backups', progress: 0.72}
				const k = config.keep
				await restic(['forget', '--group-by', 'host,tags', '--keep-daily', String(k.daily), '--keep-weekly', String(k.weekly), '--keep-monthly', String(k.monthly), '--keep-last', '1', '--prune'], {inside: true})
				if (now() - (config.lastCheckAt ?? 0) > 7 * 86400_000) {
					job = {...job, step: 'Checking the backups', progress: 0.76}
					await restic(['check', '--read-data-subset=2%'], {inside: true})
					config.lastCheckAt = now()
					await saveConfig()
				}
				job = {...job, step: 'Copying to the NAS', progress: 0.8}
				try {
					const m = await mirror((f) => (job = {...job, progress: 0.8 + 0.2 * f}))
					entry.nas = {ok: true, ...m}
				} catch (e) {
					entry.nas = {ok: false, error: e.message}
				}
				const failed = entry.items.filter((i) => !i.ok)
				entry.ok = !failed.length && entry.nas?.ok
				entry.error = failed.length ? `${failed.map((i) => i.name).join(', ')}: ${failed[0].error}` : entry.nas?.ok ? null : `Saved on this server, but not copied to the NAS: ${entry.nas.error}`
			} catch (e) {
				entry.ok = false
				entry.error = e.message
			} finally {
				entry.endedAt = now()
				job = null
				await saveHistory().catch(() => {})
			}
		})()
		return {id: entry.id, done}
	}

	async function ensureRepo() {
		const real = await repoReal()
		if (await exists(join(real, 'config'))) return
		await mkdir(real, {recursive: true, mode: 0o700})
		if ((await readdir(real)).length) throw new RpcError('PRECONDITION_FAILED', `${config.repo} isn’t empty. Choose an empty folder for the backups.`)
		await restic(['init'])
	}

	// ---- schedule ------------------------------------------------------------------------------
	let nextAt = null
	function plan() {
		nextAt = config.nas ? nextRun(config.schedule, now()) : null
	}
	async function tick() {
		await ready
		if (!nextAt || job || now() < nextAt) return
		plan()
		await runBackup('scheduled').catch(() => {})
	}
	ready.then(() => {
		plan()
		if (timers) {
			timer = setInterval(() => tick().catch(() => {}), 60_000)
			timer.unref?.()
		}
	})

	// ---- procedures ----------------------------------------------------------------------------
	async function status() {
		await ready
		const configured = !!config.nas && (await hasKey())
		return {
			configured,
			nas: config.nas ? {...config.nas, hasPassword: !!secrets.nasPassword} : null,
			repo: config.repo,
			include: config.include,
			pauseApps: config.pauseApps,
			schedule: config.schedule,
			keep: config.keep,
			keySaved: !!config.keySaved,
			running: job,
			nextRunAt: configured ? nextAt : null,
			history: history.slice(0, 20),
			engine: engine ? {version: engine.version} : null,
		}
	}

	async function discover() {
		// Computers sharing files on the LAN that announce themselves (mDNS). Optional: needs avahi.
		try {
			const {stdout} = await run('avahi-browse', ['-tpr', '_smb._tcp'], {env: baseEnv(), timeout: 6000})
			const seen = new Map()
			for (const line of stdout.split('\n')) {
				const f = line.split(';')
				if (f[0] !== '=' || f[2] !== 'IPv4') continue
				const host = f[6]?.replace(/\.$/, '')
				if (host && HOST.test(host) && !seen.has(host)) seen.set(host, {host, name: f[3].replace(/\\032/g, ' '), address: f[7]})
			}
			return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
		} catch {
			return []
		}
	}

	async function shares(input = {}) {
		await ready
		const nas = cleanNas(input, {needShare: false})
		const password = input.password ? String(input.password) : nas.host === config.nas?.host && nas.username === config.nas?.username ? secrets.nasPassword : ''
		if (!password) throw new RpcError('BAD_REQUEST', 'Enter the NAS account’s password')
		const r = await smb(nas, password, {list: true, timeout: 30_000})
		if (r.errors.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(r.errors))
		return r.text
			.split('\n')
			.map((l) => l.split('|'))
			.filter((f) => f[0] === 'Disk' && f[1] && !f[1].endsWith('$') && NAME.test(f[1]))
			.map((f) => ({name: f[1], comment: f[2] ?? ''}))
	}

	// Check the folder can be written: make it, write a small file, list it, remove it.
	async function testNas(nas, password) {
		const probe = join(dir, `nas-check-${randomBytes(4).toString('hex')}`)
		await writeFile(probe, 'Omarchy Server backup check\n', {mode: 0o600})
		try {
			const name = '.omarchy-server-check'
			const r = await smb(nas, password, {lines: [...intoFolder(nas.folder), `put ${q(probe)} ${q(name)}`, 'ls', `del ${q(name)}`], timeout: 60_000})
			if (r.errors.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(r.errors))
			if (!r.text.includes(name)) throw new RpcError('PRECONDITION_FAILED', 'Couldn’t write to that folder on the NAS')
		} finally {
			await rm(probe, {force: true})
		}
	}

	function cleanOptions(input = {}) {
		const out = {}
		if (input.include) out.include = {apps: input.include.apps !== false, settings: input.include.settings !== false, machineBackups: input.include.machineBackups === true}
		if (input.pauseApps !== undefined) out.pauseApps = input.pauseApps !== false
		if (input.schedule) {
			const f = ['off', 'daily', 'weekly'].includes(input.schedule.frequency) ? input.schedule.frequency : 'daily'
			out.schedule = {frequency: f, hour: clampInt(input.schedule.hour, 0, 23, 3), weekday: clampInt(input.schedule.weekday, 0, 6, 0)}
		}
		if (input.keep) out.keep = {daily: clampInt(input.keep.daily, 1, 60, 7), weekly: clampInt(input.keep.weekly, 0, 52, 4), monthly: clampInt(input.keep.monthly, 0, 120, 6)}
		if (input.repo !== undefined) {
			const repo = String(input.repo)
			if (!repo.startsWith('/Home/') || repo.includes('"') || /[\x00-\x1f]/.test(repo)) throw new RpcError('BAD_REQUEST', 'Choose a folder in Home or on a storage pool')
			out.repo = repo
		}
		return out
	}

	// All or nothing: the NAS, options and a new recovery key are kept only once the NAS has been written
	// to and the backup store is ready, so a failed setup leaves things as they were.
	async function configure(input = {}) {
		await ready
		if (job) throw new RpcError('CONFLICT', 'Wait for the running backup to finish')
		const before = structuredClone(config)
		const out = {}
		let nasPassword = secrets.nasPassword
		if (input.nas) {
			const nas = cleanNas(input.nas)
			const password = input.nas.password ? String(input.nas.password) : config.nas?.host === nas.host && config.nas?.username === nas.username ? secrets.nasPassword : ''
			if (!password) throw new RpcError('BAD_REQUEST', 'Enter the NAS account’s password')
			await testNas(nas, password)
			nasPassword = password
			config.nas = nas
		}
		const opts = cleanOptions(input)
		let newKey = false
		try {
			if (opts.repo && opts.repo !== config.repo && (await hasKey()) && (await exists(join(await repoReal(), 'config')))) throw new RpcError('CONFLICT', 'The backup folder can’t move once backups exist')
			Object.assign(config, opts)
			if (!config.nas) throw new RpcError('BAD_REQUEST', 'Connect a NAS first')
			await ensureEngine()
			if (!(await hasKey())) {
				const key = recoveryKey()
				await writePrivate(keyFile, `${key}\n`)
				newKey = true
				config.keySaved = false
				out.recoveryKey = key
			}
			await ensureRepo()
		} catch (e) {
			config = before
			if (newKey) await rm(keyFile, {force: true})
			throw e
		}
		if (nasPassword !== secrets.nasPassword) {
			secrets.nasPassword = nasPassword
			await saveSecrets()
		}
		await saveConfig()
		plan()
		return {...(await status()), ...out}
	}

	async function showKey() {
		await ready
		if (!(await hasKey())) throw new RpcError('NOT_FOUND', 'Backups aren’t set up')
		return {recoveryKey: (await readFile(keyFile, 'utf8')).trim()}
	}
	async function keySaved() {
		await ready
		config.keySaved = true
		await saveConfig()
		return true
	}

	async function snapshots() {
		await ready
		if (!(await hasKey()) || !(await exists(join(await repoReal(), 'config')))) return []
		const {stdout} = await restic(['snapshots', '--json'], {timeout: 120_000})
		const list = JSON.parse(stdout || '[]')
		return list
			.map((s) => ({
				id: s.id,
				shortId: s.short_id ?? s.id.slice(0, 8),
				time: Date.parse(s.time),
				tags: s.tags ?? [],
				paths: s.paths ?? [],
				size: s.summary?.total_bytes_processed ?? null,
			}))
			.sort((a, b) => b.time - a.time)
	}

	// Put an app back the way it was in a backup: stop it, set its current files aside, restore, start.
	// The files set aside are removed only once the app is back; if anything fails they go back.
	async function restoreApp(input = {}) {
		await ready
		if (job) throw new RpcError('CONFLICT', 'Wait for the running backup to finish')
		const snapshotId = String(input.snapshotId ?? '')
		const appId = String(input.appId ?? '')
		if (!SNAPSHOT.test(snapshotId) || !APP_ID.test(appId)) throw new RpcError('BAD_REQUEST', 'Bad restore')
		const snap = (await snapshots()).find((s) => s.id === snapshotId || s.shortId === snapshotId)
		if (!snap || !snap.tags.includes(`app:${appId}`)) throw new RpcError('NOT_FOUND', 'That backup doesn’t have this app')
		const app = (await apps.backupTargets()).find((a) => a.id === appId)
		if (!app) throw new RpcError('NOT_FOUND', 'Install the app first, then restore its data')
		if (!snap.paths.includes(app.dir)) throw new RpcError('PRECONDITION_FAILED', 'That backup was made for a different folder')
		job = {step: `Restoring ${app.name}`, progress: 0, startedAt: now()}
		const stampNow = now()
		const aside = `${app.dir}.before-restore-${stampNow}`
		// Restored beside the app first (restic recreates the whole path under the target), then swapped in.
		const staging = `${app.dir}.restoring-${stampNow}`
		const wipe = (p) => run(unshare ? 'podman' : 'rm', unshare ? ['unshare', 'rm', '-rf', p] : ['-rf', p], {env: baseEnv(), timeout: 30 * 60_000}).catch(() => {})
		let moved = false
		let stopped = false
		try {
			await mkdir(staging, {mode: 0o700})
			await restic(['restore', snap.id, '--target', staging, '--include', app.dir, '--json'], {inside: true, onLine: progressLine(0, 0.9, `Restoring ${app.name}`)})
			const restored = join(staging, app.dir)
			if (!(await exists(restored))) throw new Error('The backup had no files for this app')
			if (app.running) {
				await apps.pauseForBackup(app.id)
				stopped = true
			}
			await rename(app.dir, aside)
			moved = true
			await rename(restored, app.dir)
			moved = false
			if (stopped) await apps.resumeAfterBackup(app.id)
			stopped = false
			await wipe(aside)
			return {restored: app.name, from: snap.time}
		} catch (e) {
			if (moved) await rename(aside, app.dir).catch(() => {})
			if (stopped) await apps.resumeAfterBackup(app.id).catch(() => {})
			throw new RpcError('INTERNAL_SERVER_ERROR', `Couldn’t restore ${app.name}: ${e.message}`)
		} finally {
			await wipe(staging)
			job = null
		}
	}

	// A new (or rebuilt) server: copy an existing backup down from the NAS and open it with its recovery key.
	async function connectExisting(input = {}) {
		await ready
		if (job) throw new RpcError('CONFLICT', 'Wait for the running backup to finish')
		if (await hasKey()) throw new RpcError('CONFLICT', 'Backups are already set up on this server')
		const nas = cleanNas(input.nas ?? {})
		const password = String(input.nas?.password ?? '')
		const key = String(input.recoveryKey ?? '').trim().toLowerCase()
		if (!/^[a-z0-9]{4}(?:-[a-z0-9]{4}){7}$/.test(key)) throw new RpcError('BAD_REQUEST', 'Enter the recovery key, like abcd-efgh-…')
		const opts = cleanOptions(input)
		Object.assign(config, opts)
		const real = await repoReal()
		await mkdir(real, {recursive: true, mode: 0o700})
		if ((await readdir(real)).length) throw new RpcError('PRECONDITION_FAILED', `${config.repo} isn’t empty. Choose an empty folder.`)
		job = {step: 'Copying the backup from the NAS', progress: 0, startedAt: now()}
		try {
			const remote = await remoteFiles(nas, password)
			if (!remote.has('config')) throw new RpcError('NOT_FOUND', 'There’s no Omarchy Server backup in that folder')
			const r = await smb(nas, password, {lines: [...intoFolder(nas.folder), 'recurse ON', 'prompt OFF', `lcd ${q(real)}`, 'mget *']})
			if (r.errors.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(r.errors))
			await writePrivate(keyFile, `${key}\n`)
			try {
				await ensureEngine()
				await restic(['cat', 'config'], {timeout: 60_000})
			} catch {
				await rm(keyFile, {force: true})
				throw new RpcError('FORBIDDEN', 'That recovery key doesn’t open this backup')
			}
			config.nas = nas
			config.keySaved = true
			secrets.nasPassword = password
			await saveSecrets()
			await saveConfig()
			plan()
			return status()
		} catch (e) {
			await rm(real, {recursive: true, force: true}).catch(() => {})
			throw e
		} finally {
			job = null
		}
	}

	async function runNow() {
		const {id} = await runBackup('manual')
		return {id}
	}

	return {
		ready,
		runBackup,
		mirror,
		close() {
			if (timer) clearInterval(timer)
		},
		procedures: {
			'backups.status': {kind: 'query', run: status},
			'backups.discover': {kind: 'query', run: discover},
			'backups.snapshots': {kind: 'query', run: snapshots},
			'backups.shares': {kind: 'mutation', run: shares},
			'backups.configure': {kind: 'mutation', run: configure},
			'backups.recoveryKey': {kind: 'mutation', run: showKey},
			'backups.keySaved': {kind: 'mutation', run: keySaved},
			'backups.runNow': {kind: 'mutation', run: runNow},
			'backups.restoreApp': {kind: 'mutation', run: restoreApp},
			'backups.connectExisting': {kind: 'mutation', run: connectExisting},
		},
	}
}
