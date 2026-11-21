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

import {Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {removeAtomic, writeAtomic} from './atomic.mjs'
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

function slotAt(schedule, from, forward) {
	if (!schedule || schedule.frequency === 'off') return null
	const base = new Date(from)
	const y = base.getFullYear()
	const m = base.getMonth()
	const d = base.getDate()
	const step = schedule.frequency === 'weekly' ? 7 : 1
	let offset =
		schedule.frequency === 'weekly'
			? forward
				? (schedule.weekday - base.getDay() + 7) % 7
				: -((base.getDay() - schedule.weekday + 7) % 7)
			: 0
	let t = new Date(y, m, d + offset, schedule.hour, 0, 0, 0).getTime()
	while (forward ? t <= from : t > from) {
		offset += forward ? step : -step
		t = new Date(y, m, d + offset, schedule.hour, 0, 0, 0).getTime()
	}
	return t
}

// When the next scheduled backup is due, in the server's local time.
export const nextRun = (schedule, from = Date.now()) => slotAt(schedule, from, true)

// The latest time the schedule said "back up" (at or before now).
export const latestSlot = (schedule, at = Date.now()) => slotAt(schedule, at, false)

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
	if (/HOST_UNREACHABLE|CONNECTION_REFUSED|IO_TIMEOUT|NETWORK_UNREACHABLE|BAD_NETWORK_PATH|INVALID_ADDRESS|NOT_FOUND$/.test(e) && !/OBJECT_(NAME|PATH)_NOT_FOUND/.test(e)) return `Couldn’t reach the NAS. Check its name or address, and that it’s on. (${e})`
	if (/OBJECT_(NAME|PATH)_NOT_FOUND/.test(e)) return `A folder on the NAS couldn’t be made or found (${e}).`
	if (/DISK_FULL/.test(e)) return 'The NAS share is full.'
	return `The NAS said ${e || 'no'}.`
}

export function defaultSpawn(cmd, args, {env, input, onLine, timeout = 6 * 60 * 60_000, split = /\n/} = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		let out = ''
		let err = ''
		let buf = ''
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
		child.stdout.on('data', (s) => {
			out += s
			if (out.length > 64 * 1024 * 1024) out = out.slice(-32 * 1024 * 1024)
			if (onLine) {
				buf += s
				const lines = buf.split(split)
				buf = lines.pop()
				for (const l of lines) onLine(l)
			}
		})
		child.stderr.on('data', (d) => (err = (err + d).slice(-64 * 1024)))
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

export function createBackups({dataDir, home = os.homedir(), serverDataDir = join(home, '.config', 'omarchy-server'), files, apps, swarm = null, run = defaultSpawn, fetchImpl = globalThis.fetch, arch = os.arch() === 'arm64' ? 'arm64' : 'amd64', resticPath = null, unshare = true, now = () => Date.now(), timers = true}) {
	const dir = join(dataDir, 'backups')
	const configFile = join(dir, 'config.json')
	const secretFile = join(dir, 'secrets.json')
	const historyFile = join(dir, 'history.json')
	const pausedFile = join(dir, 'paused-apps.json')
	const keyFile = join(dir, 'recovery-key')
	const binDir = join(dir, 'bin')
	let config = structuredClone(DEFAULTS)
	let secrets = {} // {nasPassword}
	let history = []
	const pausedApps = new Set()
	let job = null // {step, progress, startedAt}
	let engine = null // {path, version}
	let engineInstall = null
	let timer = null
	let startedAt = 0

	const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
	// A missing file stays the default. Empty, invalid, or wrong-shaped JSON is left on disk
	// (secrets.json is the NAS password) and the log names the file only.
	const readBackupFile = async (file, fallback, accept) => {
		const text = await readFile(file, 'utf8').catch(() => null)
		if (text === null) return fallback
		try {
			const value = JSON.parse(text)
			if (accept(value)) return value
		} catch {
			/* not JSON */
		}
		console.error('[omarchyd] backups: damaged file', file)
		return fallback
	}

	const ready = (async () => {
		startedAt = now()
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700).catch(() => {})
		config = {...structuredClone(DEFAULTS), ...(await readBackupFile(configFile, {}, plainObject))}
		secrets = await readBackupFile(secretFile, {}, plainObject)
		history = await readBackupFile(historyFile, [], Array.isArray)
		// Runs that were going when the server stopped (the server's own and any computer's at once).
		// (Not written back here: startup leaves the files as they are, and the next run saves it.)
		for (const h of history) if (h && typeof h === 'object' && !h.endedAt) Object.assign(h, {endedAt: h.startedAt, ok: false, error: 'Stopped when the server restarted'})
		const leftover = await readBackupFile(pausedFile, null, Array.isArray)
		if (leftover) {
			for (const id of leftover) {
				if (typeof id === 'string' && APP_ID.test(id)) {
					await apps?.resumeAfterBackup?.(id).catch((e) => console.error('[omarchyd] backups: resume paused app', id, e.message))
				}
			}
			await removeAtomic(pausedFile)
		}
	})()

	// Factory reset bumps this so a password write queued before the reset does not recreate the file.
	let epoch = 0
	const passwordWrites = new Map()
	const isPasswordFile = (file) => {
		if (file === keyFile) return true
		const rel = relative(dir, file)
		if (rel.startsWith(`smb-auth-`) && !rel.includes(sep)) return true
		const parts = rel.split(sep)
		return parts.length === 2 && parts[0] === 'computers' && parts[1].endsWith('.key')
	}
	const trackPassword = (file) => passwordWrites.set(file, (passwordWrites.get(file) ?? 0) + 1)
	const untrackPassword = (file) => {
		const n = (passwordWrites.get(file) ?? 1) - 1
		if (n <= 0) passwordWrites.delete(file)
		else passwordWrites.set(file, n)
	}
	const remember = (file) => {
		if (isPasswordFile(file)) trackPassword(file)
		return epoch
	}
	const privateText = (file, seen, text) => {
		if (seen !== epoch && isPasswordFile(file)) return null
		return typeof text === 'function' ? text() : text
	}
	const writePrivate = (file, text) => writeAtomic(file, ((seen) => () => privateText(file, seen, text))(remember(file)), {mode: 0o600}).finally(() => {
		if (isPasswordFile(file)) untrackPassword(file)
	})
	const saveConfig = () => writePrivate(configFile, () => JSON.stringify(config, null, '\t'))
	const saveSecrets = () => writePrivate(secretFile, () => JSON.stringify(secrets))
	const saveHistory = () => writePrivate(historyFile, () => JSON.stringify(history.slice(0, 40), null, '\t'))
	const savePaused = () => (pausedApps.size ? writePrivate(pausedFile, () => JSON.stringify([...pausedApps])) : removeAtomic(pausedFile))
	const markPaused = (id) => (pausedApps.add(id), savePaused())
	const unmarkPaused = (id) => (pausedApps.delete(id), savePaused())
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
	async function repoReal({create = true} = {}) {
		if (!create) return (await files.resolve(config.repo, {mustExist: false})).real
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
	// The backup folder holds one restic store per source: server/ for this server, and
	// computers/<id>/ for each computer in the local swarm.
	const serverRepo = async () => join(await repoReal(), 'server')
	const computerRepo = async (id) => join(await repoReal(), 'computers', id)
	const computerKey = (id) => join(dir, 'computers', `${id}.key`)
	async function restic(args, {inside = false, onLine, timeout, repo = null, passwordFile = keyFile} = {}) {
		const {path} = await ensureEngine()
		const env = {...baseEnv(), RESTIC_REPOSITORY: repo ?? (await serverRepo()), RESTIC_PASSWORD_FILE: passwordFile, RESTIC_CACHE_DIR: join(dir, 'cache'), RESTIC_PROGRESS_FPS: '0.5'}
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
		await writePrivate(auth, `username=${nas.username}\npassword=${password}\n${nas.domain ? `domain=${nas.domain}\n` : ''}`)
		if (!(await exists(auth))) throw new RpcError('PRECONDITION_FAILED', 'Backups were reset')
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
			await removeAtomic(auth)
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

	async function smbGetFile(nas, password, remotePath) {
		const tmp = join(dir, `nas-get-${randomBytes(4).toString('hex')}`)
		try {
			const r = await smb(nas, password, {lines: [...intoFolder(nas.folder), `get ${q(remotePath)} ${q(tmp)}`], timeout: 60_000})
			if (r.errors.length) throw new RpcError('PRECONDITION_FAILED', smbMessage(r.errors))
			return await readFile(tmp).catch(() => {
				throw new RpcError('PRECONDITION_FAILED', 'Couldn’t read the backup details from the NAS')
			})
		} finally {
			await rm(tmp, {force: true})
		}
	}

	const remoteComputerConfigs = (remote) => [...remote.keys()].filter((p) => /^computers\/[^/]+\/config$/.test(p))
	const hasRemoteStore = (remote) => remote.has('server/config') || remote.has('config') || remoteComputerConfigs(remote).length > 0
	const localConfigBytes = (root) => readFile(join(root, 'server', 'config')).catch(() => null)
	async function nasMatchesLocal(nas, password, remote, root) {
		const localCfg = root ? await localConfigBytes(root) : null
		if (!localCfg) return false
		if (remote.has('server/config')) return (await smbGetFile(nas, password, 'server/config')).equals(localCfg)
		if (remote.has('config')) return (await smbGetFile(nas, password, 'config')).equals(localCfg)
		for (const p of remoteComputerConfigs(remote)) {
			const localComp = await readFile(join(root, p)).catch(() => null)
			if (!localComp || !(await smbGetFile(nas, password, p)).equals(localComp)) return false
		}
		return true
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
	// A path inside one of the stores: server/<part>/… or computers/<id>/<part>/…
	const part = (p) => {
		const seg = p.split('/')
		return seg[0] === 'server' ? seg[1] : seg[0] === 'computers' ? seg[2] : null
	}
	const rank = (p) => {
		const i = ORDER.indexOf(part(p))
		return i < 0 ? ORDER.length : i
	}
	async function mirror(onProgress = () => {}) {
		const nas = config.nas
		const root = await repoReal({create: false}).catch(() => null)
		const local = root ? await localFiles(root) : new Map()
		for (const k of [...local.keys()]) if (!ORDER.includes(part(k))) local.delete(k)
		const remote = await remoteFiles(nas, secrets.nasPassword)
		if (hasRemoteStore(remote) && !local.has('server/config')) {
			throw new RpcError('PRECONDITION_FAILED', 'The local backup store is missing, so the NAS copy wasn’t touched.')
		}
		if (hasRemoteStore(remote) && !(await nasMatchesLocal(nas, secrets.nasPassword, remote, root))) {
			throw new RpcError('PRECONDITION_FAILED', 'That NAS folder holds a different backup. Choose another folder or use “Restore from an existing backup”.')
		}
		const send = [...local].filter(([p, size]) => remote.get(p) !== size).sort((a, b) => rank(a[0]) - rank(b[0]))
		const drop = [...remote.keys()].filter((p) => !local.has(p) && ORDER.includes(part(p))).sort((a, b) => rank(b) - rank(a))
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
		let stdout = ''
		let warning
		try {
			stdout = (await restic(args, {inside: tags.some((t) => t.startsWith('app:')), onLine: progressLine(base, span, step)})).stdout
		} catch (e) {
			if (e?.code !== 3) throw e
			stdout = e.stdout ?? ''
			warning = 'Saved, but some files couldn’t be read'
		}
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
		return {added: summary?.data_added ?? 0, files: summary?.total_files_processed ?? 0, ...(warning ? {warning} : {})}
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
				await ensureRepo({allowInit: false})
				const targets = config.include.apps ? await apps.backupTargets() : []
				const steps = targets.length + (config.include.settings ? 1 : 0) + (config.include.machineBackups ? 1 : 0)
				const span = 0.7 / Math.max(1, steps)
				let n = 0
				for (const app of targets) {
					if (!(await exists(app.dir))) continue
					const pause = config.pauseApps && app.running
					if (pause) {
						await markPaused(app.id)
						await apps.pauseForBackup(app.id).catch(() => {})
					}
					try {
						const r = await backupOne([app.dir], [`app:${app.id}`], [], `Saving ${app.name}`, n * span, span)
						entry.items.push({kind: 'app', id: app.id, name: app.name, ok: true, added: r.added, ...(r.warning ? {warning: r.warning} : {})})
						entry.added += r.added
					} catch (e) {
						entry.items.push({kind: 'app', id: app.id, name: app.name, ok: false, error: e.message})
					} finally {
						if (pause) {
							await apps.resumeAfterBackup(app.id).catch((e) => entry.items.push({kind: 'app', id: app.id, name: app.name, ok: false, error: `Didn’t start again: ${e.message}`}))
							await unmarkPaused(app.id).catch(() => {})
						}
					}
					n++
				}
				if (config.include.settings) {
					try {
						const paths = [dataDir, ...((await exists(serverDataDir)) ? [serverDataDir] : [])]
						const r = await backupOne(paths, ['settings'], settingsExcludes().flatMap((x) => ['--exclude', x]), 'Saving server settings', n * span, span)
						entry.items.push({kind: 'settings', name: 'Server settings', ok: true, added: r.added, ...(r.warning ? {warning: r.warning} : {})})
						entry.added += r.added
					} catch (e) {
						entry.items.push({kind: 'settings', name: 'Server settings', ok: false, error: e.message})
					}
					n++
				}
				if (config.include.machineBackups) {
					try {
						const {real} = await files.resolve('/Home/Backups/Machines', {mustExist: false})
						if (await exists(real)) {
							const r = await backupOne([real], ['machines'], [], 'Saving VM backups', n * span, span)
							entry.items.push({kind: 'machines', name: 'VM backups', ok: true, added: r.added, ...(r.warning ? {warning: r.warning} : {})})
							entry.added += r.added
						}
					} catch (e) {
						entry.items.push({kind: 'machines', name: 'VM backups', ok: false, error: e.message})
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
					const m = await mirrorOnce((f) => (job = {...job, progress: 0.8 + 0.2 * f}))
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

	async function ensureRepo({allowInit = true} = {}) {
		if (!allowInit) {
			const real = await repoReal({create: false}).catch(() => null)
			if (!real || !(await exists(join(real, 'server', 'config')))) throw new RpcError('PRECONDITION_FAILED', 'The backup folder is empty or missing. Is the drive connected?')
			return
		}
		const real = await repoReal()
		const repo = join(real, 'server')
		if (await exists(join(repo, 'config'))) return
		await mkdir(real, {recursive: true, mode: 0o700})
		if ((await readdir(real)).some((n) => n !== 'server' && n !== 'computers')) throw new RpcError('PRECONDITION_FAILED', `${config.repo} isn’t empty. Choose an empty folder for the backups.`)
		await mkdir(repo, {recursive: true, mode: 0o700})
		await restic(['init'], {repo})
	}
	// A computer's own store: its own password (which it's sent for each backup, never kept), plus
	// the recovery key as a second key, so the one recovery key opens everything.
	async function ensureComputerRepo(id, {allowInit = true} = {}) {
		if (!allowInit) {
			const real = await repoReal({create: false}).catch(() => null)
			if (!real || !(await exists(join(real, 'server', 'config'))) || !(await exists(join(real, 'computers', id, 'config')))) throw new RpcError('PRECONDITION_FAILED', 'The backup folder is empty or missing. Is the drive connected?')
		}
		const repo = await computerRepo(id)
		if ((await exists(join(repo, 'config'))) && (await exists(computerKey(id)))) return repo
		await mkdir(join(dir, 'computers'), {recursive: true, mode: 0o700})
		const fresh = !(await exists(computerKey(id)))
		if (fresh) await writePrivate(computerKey(id), `${randomBytes(24).toString('base64url')}\n`)
		if (!(await exists(join(repo, 'config')))) {
			await mkdir(repo, {recursive: true, mode: 0o700})
			await restic(['init'], {repo, passwordFile: computerKey(id)})
			await restic(['key', 'add', '--new-password-file', keyFile, '--host', 'omarchy-server'], {repo, passwordFile: computerKey(id)})
		} else if (fresh) {
			// Its store is here but its key isn't (a rebuilt server): open it with the recovery key and add one.
			await restic(['key', 'add', '--new-password-file', computerKey(id), '--host', 'omarchy-server'], {repo, passwordFile: keyFile})
		}
		return repo
	}

	// ---- computers in the local swarm -----------------------------------------------------------
	// Each computer backs up the folders chosen here, on its own schedule. The server starts each run:
	// it sends the computer its store's password and the folders, and the computer's restic uploads
	// through its connector to /connector/backup (add-only, see handleUpload). If a computer is off at
	// the time, it catches up when it next connects. Pruning and the NAS copy happen here, afterwards.
	const FOLDER = /^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\x00-\x1f/][^\x00-\x1f]{0,199}$/
	const computerJobs = new Map() // id -> {step, progress, startedAt}
	let mirrorChain = Promise.resolve()
	// One NAS copy at a time; a run that finishes while another copy is going waits for it.
	const mirrorOnce = (onProgress) => (mirrorChain = mirrorChain.catch(() => {}).then(() => mirror(onProgress)))
	const DEFAULT_COMPUTER = {enabled: false, folders: [], schedule: {frequency: 'daily', hour: 1, weekday: 0}, lastSuccessAt: 0, lastAttemptAt: 0, failures: 0, failedSlot: 0}
	const computerConfig = (id) => ({...structuredClone(DEFAULT_COMPUTER), ...(config.computers?.[id] ?? {})})
	const COMPUTER_RETRY_DELAYS = [0, 30 * 60_000, 2 * 60 * 60_000]
	function computerDue(c, slot, at) {
		if (!slot || c.lastSuccessAt >= slot) return false
		const fails = c.failedSlot === slot ? c.failures || 0 : 0
		if (fails >= COMPUTER_RETRY_DELAYS.length) return false
		if (fails === 0) return c.lastAttemptAt === 0 || at - c.lastAttemptAt >= 30 * 60_000
		return at - c.lastAttemptAt >= COMPUTER_RETRY_DELAYS[fails]
	}

	function cleanFolders(list) {
		if (!Array.isArray(list) || list.length > 32) throw new RpcError('BAD_REQUEST', 'Choose up to 32 folders')
		const out = [...new Set(list.map((f) => String(f).trim().replace(/\/+$/, '')))]
		for (const f of out) if (!FOLDER.test(f)) throw new RpcError('BAD_REQUEST', `“${f.slice(0, 60)}” isn’t a folder in the home folder`)
		return out
	}

	async function computers() {
		await ready
		if (!swarm) return []
		const agents = await swarm.agents()
		return agents.map((a) => {
			const c = computerConfig(a.id)
			const last = history.find((h) => h.computer === a.id && h.endedAt)
			const sc = c.schedule
			return {
				id: a.id,
				name: a.name,
				online: a.online,
				allowed: a.allowed,
				on: a.on,
				enabled: c.enabled,
				folders: c.folders,
				schedule: sc,
				running: computerJobs.get(a.id) ?? null,
				last: last ? {at: last.endedAt, ok: last.ok, error: last.error, added: last.added} : null,
				nextRunAt: c.enabled && sc.frequency !== 'off' ? nextRun(sc, Math.max(now(), c.lastSuccessAt)) : null,
				lastRestore: c.lastRestore ?? null,
			}
		})
	}

	async function agentOf(id) {
		const a = (await swarm?.agents())?.find((x) => x.id === String(id ?? ''))
		if (!a) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		return a
	}

	async function computerFolders(input = {}) {
		await ready
		const a = await agentOf(input.id)
		if (!a.on) throw new RpcError('FORBIDDEN', `Backups aren’t switched on for ${a.name}. Add it to the swarm again with Backups allowed.`)
		if (!a.online) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
		return swarm.call(a.id, 'backup-folders', {}, 30_000)
	}

	async function setComputer(input = {}) {
		await ready
		const a = await agentOf(input.id)
		if (!config.nas || !(await hasKey())) throw new RpcError('PRECONDITION_FAILED', 'Set up backups for this server first')
		const c = computerConfig(a.id)
		if (input.folders !== undefined) c.folders = cleanFolders(input.folders)
		if (input.schedule) c.schedule = cleanOptions({schedule: input.schedule}).schedule
		if (input.enabled !== undefined) {
			if (input.enabled === true && !a.on) throw new RpcError('FORBIDDEN', `Backups aren’t switched on for ${a.name}. Add it to the swarm again with Backups allowed.`)
			c.enabled = input.enabled === true
		}
		if (c.enabled && !c.folders.length) throw new RpcError('BAD_REQUEST', 'Choose at least one folder to back up')
		if (c.enabled) await ensureComputerRepo(a.id)
		if (input.folders !== undefined || input.schedule || input.enabled === true) {
			c.lastAttemptAt = 0
			c.failures = 0
			c.failedSlot = 0
		}
		config.computers = {...(config.computers ?? {}), [a.id]: c}
		await saveConfig()
		return (await computers()).find((x) => x.id === a.id)
	}

	async function runComputer(id, reason = 'manual') {
		await ready
		const a = await agentOf(id)
		const c = computerConfig(a.id)
		if (computerJobs.has(a.id)) throw new RpcError('CONFLICT', `${a.name} is already backing up`)
		if (!c.enabled || !c.folders.length) throw new RpcError('PRECONDITION_FAILED', `Choose ${a.name}’s folders first`)
		if (!a.on) throw new RpcError('FORBIDDEN', `Backups aren’t switched on for ${a.name}`)
		if (!a.online) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
		const entry = {id: randomBytes(4).toString('hex'), computer: a.id, name: a.name, reason, startedAt: now(), endedAt: null, ok: false, error: null, items: [], added: 0, nas: null}
		history.unshift(entry)
		c.lastAttemptAt = now()
		config.computers = {...(config.computers ?? {}), [a.id]: c}
		await saveConfig()
		await saveHistory()
		computerJobs.set(a.id, {step: 'Getting ready', progress: 0, startedAt: entry.startedAt})
		const poll = setInterval(() => {
			const p = swarm.progress(a.id)
			if (p && computerJobs.has(a.id) && now() - p.at < 30_000) computerJobs.set(a.id, {...computerJobs.get(a.id), step: p.step || 'Backing up', progress: 0.85 * p.percent})
		}, 1000)
		poll.unref?.()
		const done = (async () => {
			try {
				const repo = await ensureComputerRepo(a.id, {allowInit: false})
				const password = (await readFile(computerKey(a.id), 'utf8')).trim()
				computerJobs.set(a.id, {...computerJobs.get(a.id), step: 'Backing up'})
				const r = await swarm.call(a.id, 'backup-run', {password, folders: c.folders}, 12 * 60 * 60_000)
				entry.added = Number(r?.added) || 0
				entry.items.push({kind: 'computer', id: a.id, name: a.name, ok: true, added: entry.added, files: Number(r?.files) || 0, skipped: Array.isArray(r?.skipped) ? r.skipped.slice(0, 20).map(String) : []})
				clearInterval(poll)
				computerJobs.set(a.id, {...computerJobs.get(a.id), step: 'Tidying old backups', progress: 0.88})
				const k = config.keep
				await restic(['forget', '--group-by', 'host,paths', '--keep-daily', String(k.daily), '--keep-weekly', String(k.weekly), '--keep-monthly', String(k.monthly), '--keep-last', '1', '--prune'], {repo, passwordFile: computerKey(a.id)})
				computerJobs.set(a.id, {...computerJobs.get(a.id), step: 'Copying to the NAS', progress: 0.92})
				try {
					entry.nas = {ok: true, ...(await mirrorOnce())}
				} catch (e) {
					entry.nas = {ok: false, error: e.message}
				}
				entry.ok = !!entry.nas?.ok
				entry.error = entry.ok ? null : `Saved on this server, but not copied to the NAS: ${entry.nas.error}`
				const cc = computerConfig(a.id)
				cc.lastSuccessAt = entry.startedAt
				cc.failures = 0
				cc.failedSlot = 0
				config.computers = {...(config.computers ?? {}), [a.id]: cc}
				await saveConfig()
			} catch (e) {
				entry.ok = false
				entry.error = e.message
				if (reason === 'scheduled') {
					const cc = computerConfig(a.id)
					const slot = latestSlot(cc.schedule, entry.startedAt) ?? 0
					cc.failures = cc.failedSlot === slot ? (cc.failures || 0) + 1 : 1
					cc.failedSlot = slot
					config.computers = {...(config.computers ?? {}), [a.id]: cc}
					await saveConfig().catch(() => {})
				}
			} finally {
				clearInterval(poll)
				entry.endedAt = now()
				computerJobs.delete(a.id)
				if (!entry.ok && entry.error) {
					const prev = history.find((h) => h !== entry && h.computer === a.id && h.endedAt)
					if (prev && !prev.ok && prev.error === entry.error && prev.reason === entry.reason) {
						entry.attempts = (prev.attempts ?? 1) + 1
						const idx = history.indexOf(prev)
						if (idx >= 0) history.splice(idx, 1)
					}
				}
				await saveHistory().catch(() => {})
			}
		})()
		return {id: entry.id, done}
	}

	async function computerSnapshots(input = {}) {
		await ready
		const a = await agentOf(input.id)
		const repo = await computerRepo(a.id)
		if (!(await exists(join(repo, 'config'))) || !(await exists(computerKey(a.id)))) return []
		const {stdout} = await restic(['snapshots', '--json'], {repo, passwordFile: computerKey(a.id), timeout: 120_000})
		return JSON.parse(stdout || '[]')
			.map((sn) => ({id: sn.id, shortId: sn.short_id ?? sn.id.slice(0, 8), time: Date.parse(sn.time), paths: sn.paths ?? [], size: sn.summary?.total_bytes_processed ?? null}))
			.sort((x, y) => y.time - x.time)
	}

	// Files from a backup go back onto the computer in a new folder (~/Restored/<date>), never over
	// what's there now.
	async function restoreComputer(input = {}) {
		await ready
		const a = await agentOf(input.id)
		const snapshotId = String(input.snapshotId ?? '')
		if (!SNAPSHOT.test(snapshotId)) throw new RpcError('BAD_REQUEST', 'Bad restore')
		if (!(await computerSnapshots({id: a.id})).some((x) => x.id === snapshotId)) throw new RpcError('NOT_FOUND', 'That backup isn’t there')
		if (computerJobs.has(a.id)) throw new RpcError('CONFLICT', `${a.name} is busy`)
		if (!a.online) throw new RpcError('PRECONDITION_FAILED', `${a.name} is offline right now`)
		computerJobs.set(a.id, {step: 'Restoring', progress: 0, startedAt: now()})
		// Big folders take a while: it runs in the background, and the result shows on the computer.
		const poll = setInterval(() => {
			const p = swarm.progress(a.id)
			if (p && computerJobs.has(a.id) && now() - p.at < 30_000) computerJobs.set(a.id, {...computerJobs.get(a.id), step: 'Restoring', progress: p.percent})
		}, 1000)
		poll.unref?.()
		const done = (async () => {
			const c = computerConfig(a.id)
			try {
				const password = (await readFile(computerKey(a.id), 'utf8')).trim()
				const r = await swarm.call(a.id, 'backup-restore', {password, snapshot: snapshotId}, 12 * 60 * 60_000)
				c.lastRestore = {at: now(), ok: true, folder: String(r?.folder ?? '').slice(0, 300)}
			} catch (e) {
				c.lastRestore = {at: now(), ok: false, error: e.message}
			} finally {
				clearInterval(poll)
				computerJobs.delete(a.id)
				config.computers = {...(config.computers ?? {}), [a.id]: {...computerConfig(a.id), lastRestore: c.lastRestore}}
				await saveConfig().catch(() => {})
			}
		})()
		return {started: true, done}
	}

	// The store's HTTP side for computers: restic's REST protocol, scoped to the asking computer's own
	// store, and add-only (only lock files can be removed), so a computer can never delete or rewrite
	// its backups. Pruning happens here, with the server's own copy of the password.
	const TYPES = new Set(['data', 'keys', 'locks', 'snapshots', 'index'])
	const OBJECT = /^[0-9a-f]{64}$/
	const MAX_OBJECT = 1024 * 1024 * 1024
	async function handleUpload(req, res, agentId, sub) {
		const send = (code, body = '', type = 'text/plain') => {
			res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'})
			res.end(body)
		}
		const repo = await computerRepo(agentId)
		if (!(await exists(join(repo, 'config')))) return send(404, 'No backup store for this computer yet')
		const parts = sub.split('/').filter(Boolean)
		const method = req.method
		if (parts.length === 0 && method === 'POST') return send(403, 'This store already exists')
		if (parts.length === 1 && parts[0] === 'config') {
			if (method === 'HEAD' || method === 'GET') return serveFile(req, res, join(repo, 'config'))
			return send(403, 'Read-only')
		}
		const type = parts[0]
		if (!TYPES.has(type) || parts.length > 2) return send(404)
		const folderOf = (name) => (type === 'data' ? join(repo, 'data', name.slice(0, 2)) : join(repo, type))
		if (parts.length === 1) {
			if (method !== 'GET') return send(405)
			const out = []
			const dirs = type === 'data' ? (await readdir(join(repo, 'data')).catch(() => [])).map((d) => join(repo, 'data', d)) : [join(repo, type)]
			for (const d of dirs) for (const name of await readdir(d).catch(() => [])) if (OBJECT.test(name)) out.push({name, size: (await stat(join(d, name))).size})
			const v2 = String(req.headers.accept ?? '').includes('application/vnd.x.restic.rest.v2')
			return send(200, JSON.stringify(v2 ? out : out.map((o) => o.name)), v2 ? 'application/vnd.x.restic.rest.v2' : 'application/vnd.x.restic.rest.v1')
		}
		const name = parts[1]
		if (!OBJECT.test(name)) return send(404)
		const file = join(folderOf(name), name)
		if (method === 'HEAD' || method === 'GET') return serveFile(req, res, file)
		if (method === 'DELETE') {
			if (type !== 'locks') return send(403, 'Backups can only be added from a computer')
			await rm(file, {force: true})
			return send(200)
		}
		if (method !== 'POST') return send(405)
		if (type !== 'locks' && (await exists(file))) return send(403, 'Already stored')
		const length = Number(req.headers['content-length'])
		if (Number.isFinite(length) && length > MAX_OBJECT) return send(413)
		await mkdir(folderOf(name), {recursive: true, mode: 0o700})
		const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
		const {createWriteStream} = await import('node:fs')
		const out = createWriteStream(tmp, {mode: 0o600})
		let size = 0
		try {
			const limit = new Transform({
				transform(chunk, _enc, cb) {
					size += chunk.length
					if (size > MAX_OBJECT) return cb(new Error('Too large'))
					cb(null, chunk)
				},
			})
			await pipeline(req, limit, out)
			if (type !== 'locks' && (await exists(file))) {
				await rm(tmp, {force: true})
				return send(403, 'Already stored')
			}
			await rename(tmp, file)
			return send(200)
		} catch (e) {
			out.destroy()
			await rm(tmp, {force: true})
			if (!res.headersSent) e?.message === 'Too large' ? send(413) : send(400, 'Upload failed')
		}
	}
	async function serveFile(req, res, file) {
		const st = await stat(file).catch(() => null)
		if (!st?.isFile()) {
			res.writeHead(404, {'content-type': 'text/plain'})
			return res.end()
		}
		const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
		let start = 0
		let end = st.size - 1
		if (range) {
			start = Number(range[1])
			end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
			if (start > end || start >= st.size) {
				res.writeHead(416, {'content-range': `bytes */${st.size}`})
				return res.end()
			}
		}
		res.writeHead(range ? 206 : 200, {'content-type': 'application/octet-stream', 'content-length': end - start + 1, ...(range ? {'content-range': `bytes ${start}-${end}/${st.size}`} : {})})
		if (req.method === 'HEAD') return res.end()
		const {createReadStream} = await import('node:fs')
		// pipeline closes the file when the computer's connection goes away mid-download.
		pipeline(createReadStream(file, {start, end}), res).catch(() => {})
	}

	// ---- schedule ------------------------------------------------------------------------------
	function lastServerActivity() {
		const last = history.find((h) => h && !h.computer)?.startedAt ?? 0
		const since = Number(config.scheduleSince) || 0
		if (last || since) return Math.max(last, since)
		return startedAt
	}
	async function tick() {
		await ready
		// Computers: due if a scheduled time has passed since its last good backup (so one that was
		// off or asleep catches up when it's back), and it hasn't been tried in the last half hour.
		if (swarm && config.nas && (await hasKey())) {
			const started = []
			for (const a of await swarm.agents().catch(() => [])) {
				const c = computerConfig(a.id)
				if (!c.enabled || !a.on || !a.online || computerJobs.has(a.id)) continue
				const slot = latestSlot(c.schedule, now())
				if (computerDue(c, slot, now())) started.push(runComputer(a.id, 'scheduled').catch(() => {}))
			}
			await Promise.all(started)
		}
		if (!config.nas || job || !(await hasKey())) return
		const slot = latestSlot(config.schedule, now())
		if (!slot || lastServerActivity() >= slot) return
		await runBackup('scheduled').catch(() => {})
	}
	ready.then(() => {
		if (timers) {
			timer = setInterval(() => tick().catch(() => {}), 60_000)
			timer.unref?.()
		}
	}).catch((e) => console.error('[omarchyd] backups', e.message))

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
			computersRunning: computerJobs.size,
			nextRunAt: configured ? nextRun(config.schedule, now()) : null,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
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

	async function checkNasFolder(nas, password) {
		const remote = await remoteFiles(nas, password)
		if (!hasRemoteStore(remote)) return
		if (await hasKey()) {
			const root = await repoReal({create: false}).catch(() => null)
			if (await nasMatchesLocal(nas, password, remote, root)) return
		}
		throw new RpcError('PRECONDITION_FAILED', 'That folder already has backups. Use “Restore from an existing backup”, or choose another folder.')
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
		if (before.nas && (await hasKey()) && (input.repo === undefined || String(input.repo) === before.repo)) await ensureRepo({allowInit: false})
		if (input.nas) {
			const nas = cleanNas(input.nas)
			const password = input.nas.password ? String(input.nas.password) : config.nas?.host === nas.host && config.nas?.username === nas.username ? secrets.nasPassword : ''
			if (!password) throw new RpcError('BAD_REQUEST', 'Enter the NAS account’s password')
			await testNas(nas, password)
			await checkNasFolder(nas, password)
			nasPassword = password
			config.nas = nas
		}
		const opts = cleanOptions(input)
		let newKey = false
		try {
			if (opts.repo && opts.repo !== config.repo && (await hasKey()) && (await exists(join(await serverRepo(), 'config')))) throw new RpcError('CONFLICT', 'The backup folder can’t move once backups exist')
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
			if (e instanceof RpcError) throw e
			throw new RpcError('INTERNAL_SERVER_ERROR', `Couldn’t set up the backup folder (${config.repo}): ${e.message}`)
		}
		if (nasPassword !== secrets.nasPassword) {
			secrets.nasPassword = nasPassword
			await saveSecrets()
		}
		if (!before.nas || (opts.schedule && (opts.schedule.frequency !== before.schedule.frequency || opts.schedule.hour !== before.schedule.hour || opts.schedule.weekday !== before.schedule.weekday))) {
			config.scheduleSince = now()
		}
		await saveConfig()
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
		if (!(await hasKey()) || !(await exists(join(await serverRepo(), 'config')))) return []
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
				await markPaused(app.id)
				try {
					await apps.pauseForBackup(app.id)
					stopped = true
				} catch (e) {
					await unmarkPaused(app.id).catch(() => {})
					throw e
				}
			}
			await rename(app.dir, aside)
			moved = true
			await rename(restored, app.dir)
			moved = false
			if (stopped) {
				await apps.resumeAfterBackup(app.id)
				await unmarkPaused(app.id).catch(() => {})
			}
			stopped = false
			await wipe(aside)
			return {restored: app.name, from: snap.time}
		} catch (e) {
			if (moved) await rename(aside, app.dir).catch(() => {})
			if (stopped) {
				await apps.resumeAfterBackup(app.id).catch(() => {})
				await unmarkPaused(app.id).catch(() => {})
			}
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
			if (!remote.has('server/config')) throw new RpcError('NOT_FOUND', 'There’s no Omarchy Server backup in that folder')
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

	// Factory reset: NAS address, password and recovery key are forgotten. A missing file is the
	// default on the next start, and the copy in memory must match so a later save cannot put them back.
	async function clearSettings() {
		await ready
		epoch++
		config = structuredClone(DEFAULTS)
		secrets = {}
		const pending = [...passwordWrites.keys()]
		await removeAtomic(configFile)
		await removeAtomic(secretFile)
		await removeAtomic(keyFile)
		for (const file of pending) await removeAtomic(file)
		for (const name of await readdir(join(dir, 'computers')).catch(() => [])) {
			if (name.endsWith('.key')) await removeAtomic(join(dir, 'computers', name))
		}
		for (const name of await readdir(dir).catch(() => [])) {
			if (name.startsWith('smb-auth-')) await removeAtomic(join(dir, name))
		}
	}

	return {
		ready,
		clearSettings,
		runBackup,
		runComputer,
		handleUpload,
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
			'backups.computers': {kind: 'query', run: computers},
			'backups.computerFolders': {kind: 'mutation', run: computerFolders},
			'backups.setComputer': {kind: 'mutation', run: setComputer},
			'backups.runComputer': {kind: 'mutation', run: async (input) => ({id: (await runComputer(String(input?.id ?? ''), 'manual')).id})},
			'backups.computerSnapshots': {kind: 'query', run: computerSnapshots},
			'backups.restoreComputer': {kind: 'mutation', run: async (input) => ({started: (await restoreComputer(input)).started})},
		},
	}
}
