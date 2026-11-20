// Move from Unraid: connect to an Unraid server over SSH, see its shares, Docker containers and VMs,
// and bring the chosen ones over. Unraid itself isn't changed, except that a container being moved
// stops for a moment (while the last of its files are copied) and then starts again.
//
// - SSH as root, with the password typed once. It's kept in memory only for the import, and handed to
//   ssh through a short-lived helper (SSH_ASKPASS), never on a command line or on disk. One
//   authenticated connection is reused (ControlMaster) for everything, rsync included.
// - Unraid's host key is recorded on first connect (its fingerprint is shown) and required after.
// - Shares: copied with rsync (resumable) into Home (or a storage pool) and shared on the network again.
// - Containers: each becomes an app, from how it actually runs (docker inspect): the same image,
//   settings, ports and folders. Its appdata is copied into the app's own folder; folders from shares
//   point at where those shares were copied. Its listing goes in an "Imported from Unraid" store on this
//   server, and it installs through the normal path (the same checks as any app).
// - VMs: their disks are copied (the VM must be shut down on Unraid) and become machines here.
// Owner only (server.mjs wraps the procedures).
import {randomBytes} from 'node:crypto'
import {access, chmod, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import YAML from 'yaml'

import {writeAtomic} from './atomic.mjs'
import {defaultSpawn} from './backups.mjs'
import {RpcError} from './rpc.mjs'

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*|\d{1,3}(?:\.\d{1,3}){3})$/
const SHARE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,79}$/
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,79}$/
const exists = (p) => access(p).then(() => true, () => false)
// Single-quoted for the remote shell (names are checked against the patterns above first).
export const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function slug(name) {
	return (
		String(name)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'app'
	)
}

// A path under a share. "." and ".." would copy or bind outside the folder chosen here.
function restStaysInside(rest) {
	return String(rest)
		.split('/')
		.every((p) => p !== '.' && p !== '..' && !p.includes('\\') && !p.includes('\0') && !/[\r\n]/.test(p))
}

// Where a path on Unraid is: in appdata, in a user share, or somewhere else.
export function unraidPath(p) {
	const m = /^\/mnt\/(?:user0?|cache|disk\d+|[A-Za-z0-9_-]+)\/([^/]+)(?:\/(.*))?$/.exec(String(p))
	if (!m || /^\/mnt\/(?:disks|remotes|addons|rootshare)\//.test(p)) return {kind: 'other'}
	const [, share, rest = ''] = m
	if (!restStaysInside(rest)) return {kind: 'other'}
	if (share === 'appdata') return {kind: 'appdata', rest}
	return {kind: 'share', share, rest}
}

// The web address an Unraid template shows, e.g. "http://[IP]:[PORT:8096]/web".
export function webuiPort(label) {
	const s = String(label ?? '')
	const m = /\[PORT:(\d{1,5})\]([^\s]*)/.exec(s)
	if (!m) return null
	return {port: Number(m[1]), path: m[2] && m[2] !== '/' ? m[2] : '', ...(/^\s*https:\/\//i.test(s) ? {https: true} : {})}
}

function imageVersion(image) {
	const name = String(image ?? '').split('@')[0]
	const last = name.slice(name.lastIndexOf('/') + 1)
	const colon = last.indexOf(':')
	const tag = colon >= 0 ? last.slice(colon + 1) : ''
	return (tag || 'latest').slice(0, 40)
}

// Compose would read "$" as one of its variables.
const escapeCompose = (s) => String(s).replace(/\$/g, '$$$$')

// One container (docker inspect) → an app listing (omarchy-app.yml + docker-compose.yml), what to copy
// for it, and anything that doesn't come across.
export function containerPlan(c, {imageEnv = [], imageCmd = null, shareDest = () => null, takenIds = new Set(), appdataFiles = new Set()} = {}) {
	const name = String(c?.Name ?? '').replace(/^\//, '')
	let id = `unraid-${slug(name)}`
	for (let n = 2; takenIds.has(id); n++) id = `unraid-${slug(name).slice(0, 44)}-${n}`
	const notes = []
	const problems = []
	const image = String(c?.Config?.Image ?? '')
	if (!image) problems.push('It has no image')
	const defaults = new Set(imageEnv)
	const env = {}
	for (const kv of c?.Config?.Env ?? []) {
		if (defaults.has(kv)) continue
		const i = kv.indexOf('=')
		if (i < 1) continue
		const k = kv.slice(0, i)
		const v = kv.slice(i + 1)
		if (k === 'PATH' || k === 'HOST_OS' || k === 'HOST_HOSTNAME' || k === 'HOST_CONTAINERNAME') continue
		// Unraid runs apps as nobody:users (99:100); here they run as the app user Omarchy Server sets.
		if (k === 'PUID' || k === 'PGID') env[k] = `\${${k}}`
		else env[k] = escapeCompose(v)
	}
	const hc = c?.HostConfig ?? {}
	if (hc.Privileged) notes.push('It ran with full access to the Unraid server (privileged). It’s brought over without that.')
	if ((hc.Devices ?? []).length) notes.push(`Hardware it used (${hc.Devices.map((d) => d.PathOnHost).join(', ')}) isn’t brought over.`)
	if ((hc.CapAdd ?? []).length) notes.push(`Extra permissions it had (${hc.CapAdd.join(', ')}) aren’t brought over.`)

	// Ports: what Unraid published, or (own IP / host network) the ports the image exposes.
	const ports = []
	const bindings = hc.PortBindings ?? {}
	for (const [key, list] of Object.entries(bindings)) {
		const [cport, proto = 'tcp'] = key.split('/')
		for (const b of list ?? []) if (b?.HostPort) ports.push({host: Number(b.HostPort), container: Number(cport), proto})
	}
	const mode = String(hc.NetworkMode ?? 'bridge')
	if (!ports.length && mode !== 'none') {
		for (const key of Object.keys(c?.Config?.ExposedPorts ?? {})) {
			const [cport, proto = 'tcp'] = key.split('/')
			ports.push({host: Number(cport), container: Number(cport), proto})
		}
		if (mode !== 'bridge' && ports.length) notes.push(`On Unraid it had its own network setting (${mode}). Here it’s reached at this server’s address.`)
	}
	const label = c?.Config?.Labels?.['net.unraid.docker.webui']
	const ui = webuiPort(label)
	const webPort = ui?.port ?? ports.find((p) => p.proto === 'tcp')?.container ?? null
	const webBinding = webPort ? ports.find((p) => p.container === webPort && p.proto === 'tcp') : null
	let publicPort = webBinding?.host ?? webPort ?? null
	if (publicPort && publicPort < 1024) publicPort = 10_000 + publicPort
	const service = slug(name)
	const extra = ports.filter((p) => p !== webBinding)
	const lowDropped = extra.filter((p) => p.host < 1024)
	if (lowDropped.length) notes.push(`Ports below 1024 (${lowDropped.map((p) => p.host).join(', ')}) aren’t opened.`)
	const kept = extra.filter((p) => p.host >= 1024 && p.host !== 22)

	// Folders.
	const volumes = []
	const copies = []
	const shares = new Set()
	for (const m of c?.Mounts ?? []) {
		if (m.Type !== 'bind') {
			if (m.Type === 'volume') notes.push(`Its Docker volume for ${m.Destination} starts empty here.`)
			continue
		}
		const ro = m.RW === false ? ':ro' : ''
		const src = String(m.Source ?? '')
		const dst = escapeCompose(m.Destination)
		if (src === '/etc/localtime') {
			volumes.push(`/etc/localtime:${dst}:ro`)
			continue
		}
		if (src === '/var/run/docker.sock' || src === '/run/docker.sock') {
			volumes.push(`/var/run/docker.sock:${dst}${ro}`)
			notes.push('It manages containers. Here it gets your own (rootless) container engine, not a root one.')
			continue
		}
		const where = unraidPath(src)
		if (where.kind === 'appdata') {
			const rel = where.rest.replace(/\/+$/, '') || 'appdata'
			copies.push({from: src, to: rel, ...(appdataFiles.has(src) ? {file: true} : {})})
			volumes.push(`\${APP_DATA_DIR:-.}/data/${escapeCompose(rel)}:${dst}${ro}`)
		} else if (where.kind === 'share') {
			shares.add(where.share)
			const dest = shareDest(where.share)
			if (dest) volumes.push(`${escapeCompose(join(dest, where.rest))}:${dst}${ro}`)
			else {
				volumes.push(`\${APP_DATA_DIR:-.}/data/shares/${slug(where.share)}${where.rest ? `/${escapeCompose(where.rest)}` : ''}:${dst}${ro}`)
				notes.push(`It uses the ${where.share} share. Bring that share over too, or it starts with an empty folder there.`)
			}
		} else if (src.startsWith('/tmp')) {
			continue
		} else {
			notes.push(`It used ${src} on Unraid, which isn’t brought over.`)
		}
	}
	const svc = {image, restart: 'unless-stopped'}
	if (Object.keys(env).length) svc.environment = env
	const user = String(c?.Config?.User ?? '')
	if (/^(99|nobody)(:(100|users))?$/.test(user)) svc.user = '${PUID}:${PGID}'
	else if (user) svc.user = escapeCompose(user)
	const cmd = c?.Config?.Cmd
	if (Array.isArray(cmd) && cmd.length && JSON.stringify(cmd) !== JSON.stringify(imageCmd)) svc.command = cmd.map(escapeCompose)
	if (volumes.length) svc.volumes = volumes
	const portLines = []
	if (webBinding || (publicPort && webPort)) portLines.push(`${publicPort}:${webPort}`)
	for (const p of kept) portLines.push(`${p.host}:${p.container}${p.proto === 'udp' ? '/udp' : ''}`)
	if (portLines.length) svc.ports = portLines
	const listing = {
		manifestVersion: 1,
		id,
		name,
		tagline: 'Brought over from Unraid',
		category: 'utilities',
		version: imageVersion(image),
		...(publicPort && webPort ? {port: publicPort, web: {service, port: webPort, ...(ui?.https ? {https: true} : {})}, path: ui?.path ?? ''} : {}),
		...(kept.length ? {openPorts: [...new Set(kept.map((p) => p.host))]} : {}),
		description: `${name}, moved from your Unraid server (${image}).`,
		developer: 'Imported',
		website: '',
	}
	return {
		id,
		name,
		image,
		running: !!c?.State?.Running,
		icon: c?.Config?.Labels?.['net.unraid.docker.icon'] ?? null,
		web: publicPort && webPort ? {port: publicPort} : null,
		copies,
		shares: [...shares],
		notes,
		problems,
		files: {'omarchy-app.yml': YAML.stringify(listing), 'docker-compose.yml': YAML.stringify({services: {[service]: svc}})},
	}
}

const XML_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}
function unescapeXml(s) {
	return String(s).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, named) => {
		if (named) return XML_ENTITIES[named]
		const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16)
		return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m
	})
}

// virsh dumpxml → what's needed to make a machine here.
export function vmPlan(xml, state = '') {
	const text = String(xml)
	const nameMatch = /<name>([^<]+)<\/name>/.exec(text)
	const name = nameMatch ? unescapeXml(nameMatch[1]) : 'VM'
	const memKiB = Number(/<memory[^>]*unit=['"]KiB['"][^>]*>(\d+)</.exec(text)?.[1] ?? /<memory[^>]*>(\d+)</.exec(text)?.[1] ?? 0)
	const cores = Number(/<vcpu[^>]*>(\d+)</.exec(text)?.[1] ?? 1)
	const firmware = /<loader[^>]*>[^<]*(?:OVMF|ovmf|edk2)[^<]*<\/loader>/.test(text) || /firmware=['"]efi['"]/.test(text) ? 'efi' : 'bios'
	const machineType = /machine=['"][^'"]*q35[^'"]*['"]/.test(text) ? 'q35' : 'pc'
	const disks = []
	const notes = []
	for (const m of text.matchAll(/<disk\s+type=['"](\w+)['"]\s+device=['"](\w+)['"][^>]*>([\s\S]*?)<\/disk>/g)) {
		const [, type, device, body] = m
		if (device !== 'disk') continue
		const srcMatch = /<source\b[^>]*?\s(?:file|dev)=(?:'([^']+)'|"([^"]+)")/.exec(body)
		const rawFile = srcMatch ? (srcMatch[1] ?? srcMatch[2]) : undefined
		const file = rawFile ? unescapeXml(rawFile) : undefined
		const bus = /<target[^>]*bus=['"](\w+)['"]/.exec(body)?.[1] ?? 'sata'
		const format = /<driver[^>]*type=['"](\w+)['"]/.exec(body)?.[1] ?? 'raw'
		if (type !== 'file' || !file) {
			notes.push(`A whole drive passed to it (${file ?? type}) isn’t brought over.`)
			continue
		}
		disks.push({file, bus, format: format === 'qcow2' ? 'qcow2' : 'raw'})
	}
	if (/<hostdev\b/.test(text)) notes.push('Hardware passed through to it (a graphics card or USB device) isn’t brought over.')
	const nicModel = /<interface[\s\S]*?<model\s+type=['"]([\w-]+)['"]/.exec(text)?.[1] ?? 'virtio'
	return {
		name,
		state,
		cores: Math.max(1, cores),
		memoryMb: Math.max(256, Math.round(memKiB / 1024)),
		firmware,
		machineType,
		nic: /^e1000/.test(nicModel) ? 'e1000e' : 'virtio',
		disks,
		notes,
		problems: disks.length ? [] : ['It has no disk image to copy'],
	}
}

// rsync --info=progress2: "  1,234,567  45%   10.00MB/s    0:01:23 (xfr#…)"
export function rsyncProgress(line) {
	const m = /^\s*([\d,]+)\s+(\d{1,3})%/.exec(String(line))
	return m ? {bytes: Number(m[1].replace(/,/g, '')), percent: Number(m[2]) / 100} : null
}

export function createUnraid({dataDir, files, apps, machines, storage, run = defaultSpawn, now = () => Date.now(), user = 'root', runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()}) {
	const dir = join(dataDir, 'unraid')
	const knownHosts = join(dir, 'known_hosts')
	const askpass = join(dir, 'askpass.sh')
	const stagingDir = join(dir, 'staging')
	const jobFile = join(dir, 'job.json')
	// A short path: a UNIX socket's name can't be long.
	const controlPath = join(runtimeDir, `omarchy-unraid-${process.getuid?.() ?? 0}-%C`)
	let session = null // {host, port, password, version, fingerprint, scannedAt, scan}
	let job = null
	let idle = null

	const ready = (async () => {
		await mkdir(dir, {recursive: true, mode: 0o700})
		await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$OMARCHY_UNRAID_SECRET"\n', {mode: 0o700})
		await chmod(askpass, 0o700)
		// A missing file is no previous job. Empty, truncated, or non-object JSON stays on disk;
		// rewriting it here would destroy the only copy. The log names the file, never its path or contents.
		const text = await readFile(jobFile, 'utf8').catch(() => null)
		if (text !== null) {
			let parsed = null
			try {
				parsed = JSON.parse(text)
			} catch {
				/* not JSON */
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) console.error('[omarchyd] job.json is empty or invalid and was left unchanged')
			else {
				job = parsed
				if (!job.endedAt) {
					Object.assign(job, {endedAt: now(), stopped: 'The server restarted. Choose Done, then connect again to pick up where it left off.'})
					if (Array.isArray(job.items)) {
						for (const item of job.items) {
							if (item?.status === 'running') {
								item.status = 'failed'
								item.error = 'Stopped when the server restarted'
								delete item.step
							} else if (item?.status === 'waiting') {
								item.status = 'skipped'
								delete item.step
							}
						}
					}
				}
			}
		}
	})()
	const saveJob = (record = job) => writeAtomic(jobFile, JSON.stringify(record, null, '\t'), {mode: 0o600})

	function baseEnv() {
		const env = {LC_ALL: 'C'}
		for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'XDG_RUNTIME_DIR', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]
		return env
	}
	const sshOpts = (first) => [
		'-o', `ControlPath=${controlPath}`,
		'-o', 'ControlMaster=auto',
		'-o', 'ControlPersist=20m',
		'-o', `UserKnownHostsFile=${knownHosts}`,
		'-o', `StrictHostKeyChecking=${first ? 'accept-new' : 'yes'}`,
		'-o', 'PreferredAuthentications=password,keyboard-interactive',
		'-o', 'PubkeyAuthentication=no',
		'-o', 'NumberOfPasswordPrompts=1',
		'-o', 'ConnectTimeout=15',
		'-o', 'ServerAliveInterval=30',
		'-p', String(session.port),
		'-l', user,
	]
	const sshEnv = () => ({...baseEnv(), SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', OMARCHY_UNRAID_SECRET: session.password})
	function touch() {
		clearTimeout(idle)
		// Forget the password when nothing has happened for a while. rsync never calls remote, so a running import arms the next window instead of dropping it.
		idle = setTimeout(() => {
			if (job && !job.endedAt) touch()
			else forget()
		}, 2 * 60 * 60_000)
		idle.unref?.()
	}
	function forget() {
		if (!session) return
		run('ssh', [...sshOpts(false), '-O', 'exit', session.host], {env: baseEnv(), timeout: 10_000}).catch(() => {})
		session = null
	}
	async function remote(command, {timeout = 120_000, first = false} = {}) {
		if (!session) throw new RpcError('PRECONDITION_FAILED', 'Connect to your Unraid server first')
		touch()
		try {
			const {stdout} = await run('ssh', [...sshOpts(first), session.host, command], {env: sshEnv(), timeout})
			return stdout
		} catch (e) {
			const msg = String(e.message)
			if (e.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'This server needs ssh. Run Omarchy Server’s installer once more.')
			if (/Permission denied|Authentication failed/i.test(msg)) throw new RpcError('FORBIDDEN', 'Unraid didn’t accept that password (it’s the root password, the one you sign in to Unraid’s web page with).')
			if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(msg)) throw new RpcError('FORBIDDEN', 'That server isn’t the one you connected to before (its key changed). If you reinstalled Unraid, choose Forget it and connect again.')
			if (/Connection refused/i.test(msg)) throw new RpcError('PRECONDITION_FAILED', 'Unraid isn’t accepting SSH. Turn it on in Unraid: Settings › Management Access › Use SSH.')
			if (/timed out|No route|Could not resolve|Name or service not known/i.test(msg)) throw new RpcError('PRECONDITION_FAILED', 'Couldn’t reach that server. Check its name or address, and that it’s on.')
			throw new RpcError('INTERNAL_SERVER_ERROR', msg.replace(/^ssh: /, '').slice(0, 300))
		}
	}

	// ---- connect and look around ---------------------------------------------------------------
	async function connect(input = {}) {
		await ready
		if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is running')
		let host = String(input.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
		let port = 22
		const hp = /^(.+):(\d{1,5})$/.exec(host)
		if (hp) [host, port] = [hp[1], Number(hp[2])]
		if (input.port) port = Number(input.port)
		if (!HOST.test(host) || !(port > 0 && port < 65536)) throw new RpcError('BAD_REQUEST', 'Enter your Unraid server’s name or address, like tower.local or 192.168.1.10')
		const password = String(input.password ?? '')
		if (!password || /[\r\n]/.test(password) || password.length > 512) throw new RpcError('BAD_REQUEST', 'Enter Unraid’s root password')
		forget()
		session = {host, port, password}
		try {
			const out = await remote('cat /etc/unraid-version 2>/dev/null; echo; command -v rsync >/dev/null && echo has-rsync; command -v docker >/dev/null && echo has-docker; command -v virsh >/dev/null && echo has-virsh', {first: true, timeout: 40_000})
			const version = /version="?([\w.-]+)"?/.exec(out)?.[1] ?? null
			if (!version) throw new RpcError('PRECONDITION_FAILED', 'That server doesn’t look like Unraid')
			if (!/has-rsync/.test(out)) throw new RpcError('PRECONDITION_FAILED', 'That Unraid server is missing rsync')
			const fp = await run('ssh-keygen', ['-l', '-F', port === 22 ? host : `[${host}]:${port}`, '-f', knownHosts], {env: baseEnv(), timeout: 10_000}).then((r) => /(SHA256:[A-Za-z0-9+/=]+)/.exec(r.stdout)?.[1] ?? null, () => null)
			Object.assign(session, {version, fingerprint: fp, docker: /has-docker/.test(out), virsh: /has-virsh/.test(out)})
			return {host, version, fingerprint: fp}
		} catch (e) {
			forget()
			throw e
		}
	}

	async function forgetHost(input = {}) {
		await ready
		const host = String(input.host ?? '').trim()
		if (!HOST.test(host)) throw new RpcError('BAD_REQUEST', 'Bad host')
		await run('ssh-keygen', ['-R', host, '-f', knownHosts], {env: baseEnv(), timeout: 10_000}).catch(() => {})
		return true
	}

	async function scan() {
		await ready
		if (!session) throw new RpcError('PRECONDITION_FAILED', 'Connect to your Unraid server first')
		// Shares and their sizes (each size gets a minute; very large ones may show as unknown).
		const sharesOut = await remote(`for d in /mnt/user/*/; do n="\${d%/}"; n="\${n##*/}"; s=$(timeout 60 du -sb "$d" 2>/dev/null | cut -f1); printf '%s\\t%s\\n' "$n" "\${s:-}"; done`, {timeout: 30 * 60_000})
		const shares = sharesOut
			.split('\n')
			.map((l) => l.split('\t'))
			.filter(([n]) => n && SHARE.test(n))
			.map(([n, size]) => ({name: n, size: size ? Number(size) : null, kind: n === 'appdata' ? 'appdata' : n === 'system' ? 'system' : n === 'domains' ? 'domains' : n === 'isos' ? 'isos' : 'share'}))
		let containers = []
		if (session.docker) {
			const names = (await remote(`docker ps -a --format '{{.Names}}'`)).split('\n').filter((n) => CONTAINER.test(n))
			if (names.length) {
				const inspect = JSON.parse(await remote(`docker inspect ${names.map(sq).join(' ')}`, {timeout: 120_000}))
				const images = [...new Set(inspect.map((c) => c.Image).filter((i) => /^sha256:[0-9a-f]{64}$/.test(i)))]
				const imageInfo = images.length ? JSON.parse(await remote(`docker image inspect ${images.map(sq).join(' ')}`, {timeout: 120_000})) : []
				const byImage = new Map(imageInfo.map((i) => [i.Id, i]))
				const appdataSizes = new Map()
				const appdataFiles = new Set()
				const appdataPaths = [...new Set(inspect.flatMap((c) => (c.Mounts ?? []).map((m) => m.Source).filter((s) => unraidPath(s).kind === 'appdata')))]
				if (appdataPaths.length) {
					const out = await remote(`for p in ${appdataPaths.map(sq).join(' ')}; do t=d; [ -f "$p" ] && t=f; printf '%s\\t%s\\t%s\\n' "$p" "$(timeout 60 du -sb "$p" 2>/dev/null | cut -f1)" "$t"; done`, {timeout: 20 * 60_000})
					for (const l of out.split('\n')) {
						const [p, s, t] = l.split('\t')
						if (!p) continue
						appdataSizes.set(p, Number(s) || 0)
						if (t?.trim() === 'f') appdataFiles.add(p)
					}
				}
				const taken = new Set()
				containers = inspect.map((c) => {
					const img = byImage.get(c.Image)
					const plan = containerPlan(c, {imageEnv: img?.Config?.Env ?? [], imageCmd: img?.Config?.Cmd ?? null, takenIds: taken, appdataFiles})
					taken.add(plan.id)
					return {...plan, size: plan.copies.reduce((t, cp) => t + (appdataSizes.get(cp.from) ?? 0), 0), installed: apps.installed(plan.id)}
				})
			}
		}
		let vms = []
		if (session.virsh) {
			const names = (await remote('virsh list --all --name 2>/dev/null')).split('\n').map((n) => n.trim()).filter((n) => VM_NAME.test(n))
			for (const n of names) {
				const [xml, st] = await Promise.all([remote(`virsh dumpxml ${sq(n)}`), remote(`virsh domstate ${sq(n)}`).catch(() => '')])
				const plan = vmPlan(xml, st.trim())
				const sizes = plan.disks.length ? await remote(`stat -c %s ${plan.disks.map((d) => sq(d.file)).join(' ')}`).catch(() => '') : ''
				vms.push({...plan, size: sizes.split('\n').filter(Boolean).reduce((t, s) => t + Number(s), 0)})
			}
		}
		session.scan = {shares, containers, vms, at: now()}
		return {...session.scan, containers: containers.map(({files: _f, ...c}) => c)}
	}

	// ---- the import -----------------------------------------------------------------------------
	// Where shares go: Home › Unraid (or a storage pool's Unraid folder), as Files paths.
	function destRoot(input) {
		const d = String(input?.destination ?? '/Home/Unraid').replace(/\/+$/, '')
		if (!/^\/Home(\/[^/\x00-\x1f"]+){1,6}$/.test(d) || d.split('/').some((p) => p === '..' || p === '.')) throw new RpcError('BAD_REQUEST', 'Choose a folder in Home or on a storage pool')
		return d
	}
	async function realOf(virtual) {
		const parts = virtual.split('/').filter(Boolean)
		for (let i = 2; i <= parts.length; i++) {
			const level = await files.resolve(`/${parts.slice(0, i).join('/')}`, {mustExist: false})
			if (!(await exists(level.real))) await mkdir(level.real, {mode: 0o755})
		}
		return (await files.resolve(virtual)).real
	}

	async function rsync(from, to, onProgress, {file = false} = {}) {
		await mkdir(file ? dirname(to) : to, {recursive: true})
		const e = ['ssh', ...sshOpts(false)].map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(' ')
		const src = from.replace(/\/+$/, '')
		const args = file
			? ['-lt', '--partial', '--protect-args', '--info=progress2', '-e', e, `${session.host}:${src}`, to]
			: ['-rlt', '--partial', '--protect-args', '--info=progress2', '--no-inc-recursive', '-e', e, `${session.host}:${src}/`, `${to}/`]
		try {
			await run('rsync', args, {
				env: sshEnv(),
				timeout: 7 * 24 * 60 * 60_000,
				split: /[\r\n]/,
				onLine: (l) => {
					const p = rsyncProgress(l)
					if (p) onProgress(p)
				},
			})
		} catch (err) {
			if (err?.code === 24) {
				console.warn('[omarchyd] unraid rsync: some source files vanished while copying (exit 24)')
				return
			}
			if (err.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'This server needs rsync. Run Omarchy Server’s installer once more.')
			throw new RpcError('INTERNAL_SERVER_ERROR', `Copying ${from} didn’t finish: ${String(err.message).replace(/^rsync: /, '').slice(0, 200)}`)
		}
	}

	async function start(input = {}) {
		await ready
		if (!session?.scan) throw new RpcError('PRECONDITION_FAILED', 'Connect and look at your Unraid server first')
		if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is already running')
		const dest = destRoot(input)
		const want = (list) => new Set(Array.isArray(list) ? list.map(String) : [])
		const sharesWanted = want(input.shares)
		const containersWanted = want(input.containers)
		const vmsWanted = want(input.vms)
		const scan = session.scan
		const items = []
		for (const s of scan.shares) if (sharesWanted.has(s.name) && s.kind !== 'system' && s.kind !== 'appdata') items.push({kind: 'share', key: s.name, name: s.name, size: s.size, status: 'waiting'})
		// Containers' share folders point at where those shares are being copied.
		const shareDest = (share) => (sharesWanted.has(share) ? `${dest}/${share}` : null)
		for (const c of scan.containers) if (containersWanted.has(c.id)) items.push({kind: 'container', key: c.id, name: c.name, size: c.size, status: 'waiting'})
		for (const v of scan.vms) if (vmsWanted.has(v.name)) items.push({kind: 'vm', key: v.name, name: v.name, size: v.size, status: 'waiting'})
		if (!items.length) throw new RpcError('BAD_REQUEST', 'Choose something to bring over')
		const next = {id: randomBytes(4).toString('hex'), host: session.host, startedAt: now(), endedAt: null, destination: dest, shareOnNetwork: input.shareOnNetwork !== false, pauseContainers: input.pauseContainers !== false, items, shareDest: Object.fromEntries([...sharesWanted].map((s) => [s, `${dest}/${s}`]))}
		await saveJob(next)
		job = next
		touch()
		const plans = new Map(scan.containers.map((c) => [c.id, c]))
		const vmPlans = new Map(scan.vms.map((v) => [v.name, v]))
		job.done = (async () => {
			for (const item of job.items) {
				if (job.cancelled) {
					item.status = 'skipped'
					continue
				}
				item.status = 'running'
				item.progress = 0
				await saveJob().catch(() => {})
				try {
					if (item.kind === 'share') await importShare(item, dest)
					else if (item.kind === 'container') await importContainer(item, plans.get(item.key), shareDest)
					else await importVm(item, vmPlans.get(item.key))
					item.status = 'done'
					item.progress = 1
				} catch (e) {
					item.status = 'failed'
					item.error = e.message
				}
				await saveJob().catch(() => {})
			}
			job.endedAt = now()
			touch()
			await saveJob().catch(() => {})
		})()
		return {id: job.id}
	}

	async function importShare(item, dest) {
		const virtual = `${dest}/${item.key}`
		const real = await realOf(virtual)
		item.step = 'Copying'
		await rsync(`/mnt/user/${item.key}`, real, (p) => (item.progress = p.percent))
		item.path = virtual
		if (job.shareOnNetwork && storage) {
			item.step = 'Sharing on the network'
			await storage.procedures['files.addShare'].run({path: virtual}).catch((e) => (item.note = `Copied, but not shared on the network: ${e.message}`))
		}
	}

	async function importContainer(item, plan, shareDest) {
		if (!plan) throw new Error('It isn’t on the Unraid server any more')
		if (apps.installed(plan.id)) throw new Error('It’s already here')
		// The listing, in the "Imported from Unraid" store.
		const storeDir = apps.importedStoreDir
		await mkdir(storeDir, {recursive: true, mode: 0o700})
		await writeFile(join(storeDir, 'omarchy-app-store.yml'), 'id: imported\nname: Imported from Unraid\n')
		const listingDir = join(storeDir, plan.id)
		await mkdir(listingDir, {recursive: true})
		const compose = YAML.parse(plan.files['docker-compose.yml'])
		// Folders from shares point at where those shares are being copied (as real paths).
		for (const svc of Object.values(compose.services ?? {})) {
			svc.volumes = await Promise.all(
				(svc.volumes ?? []).map(async (v) => {
					// "${APP_DATA_DIR:-.}/data/shares/<share>[/rest]:<in the container>[:ro]" (the variable has a colon of its own).
					const m = /^\$\{APP_DATA_DIR:-\.\}\/data\/shares\/([^/:]+)((?:\/[^:]*)?)(:.+)$/.exec(String(v))
					const share = m && plan.shares.find((s) => slug(s) === m[1])
					if (share && shareDest(share)) return `${join(escapeCompose(await realOf(shareDest(share))), m[2] ?? '')}${m[3]}`
					return v
				}),
			)
		}
		await writeFile(join(listingDir, 'docker-compose.yml'), YAML.stringify(compose))
		await writeFile(join(listingDir, 'omarchy-app.yml'), plan.files['omarchy-app.yml'])
		// Its files: copied while it runs, then once more while it's stopped on Unraid (only what changed).
		const appData = join(apps.appDirFor(plan.id), 'data')
		const total = plan.copies.length || 1
		let n = 0
		for (const cp of plan.copies) {
			item.step = 'Copying its files'
			await rsync(cp.from, join(appData, cp.to), (p) => (item.progress = 0.7 * ((n + p.percent) / total)), {file: !!cp.file})
			n++
		}
		const pause = job.pauseContainers && plan.running && plan.copies.length
		if (pause) {
			item.step = 'Copying the last changes (paused on Unraid)'
			await remote(`docker stop ${sq(plan.name)}`, {timeout: 5 * 60_000})
			try {
				for (const cp of plan.copies) await rsync(cp.from, join(appData, cp.to), () => {}, {file: !!cp.file})
			} finally {
				await remote(`docker start ${sq(plan.name)}`, {timeout: 5 * 60_000}).catch((e) => (item.note = `It didn’t start again on Unraid: ${e.message}`))
			}
		}
		item.step = 'Installing'
		item.progress = 0.8
		await apps.installImported(plan.id)
		const end = now() + 60 * 60_000
		for (;;) {
			const st = apps.importState(plan.id)
			if (st.done) {
				if (st.error) throw new Error(st.error)
				break
			}
			if (now() > end) throw new Error('Installing took too long')
			await new Promise((r) => setTimeout(r, 2000))
		}
		const notes = plan.notes.filter((t) => !plan.shares.some((sh) => shareDest(sh) && t.includes(`the ${sh} share`)))
		if (notes.length) item.note = [item.note, ...notes].filter(Boolean).join(' ')
	}

	async function importVm(item, plan) {
		if (!plan) throw new Error('It isn’t on the Unraid server any more')
		const st = (await remote(`virsh domstate ${sq(plan.name)}`).catch(() => '')).trim()
		if (st && st !== 'shut off') throw new Error(`Shut down ${plan.name} on Unraid first (it’s ${st}), then bring it over`)
		const stage = join(stagingDir, `vm-${randomBytes(4).toString('hex')}`)
		await mkdir(stage, {recursive: true, mode: 0o700})
		try {
			const local = []
			let i = 0
			for (const d of plan.disks) {
				item.step = `Copying disk ${i + 1} of ${plan.disks.length}`
				const to = join(stage, `d${i}`)
				// rsync copies a folder's contents: copy the disk's folder, only that file.
				const folder = d.file.slice(0, d.file.lastIndexOf('/'))
				const file = d.file.slice(d.file.lastIndexOf('/') + 1)
				await mkdir(to, {recursive: true})
				const e = ['ssh', ...sshOpts(false)].map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(' ')
				await run('rsync', ['-t', '--partial', '--sparse', '--protect-args', '--info=progress2', '-e', e, `${session.host}:${folder}/${file}`, `${to}/`], {
					env: sshEnv(),
					timeout: 7 * 24 * 60 * 60_000,
					split: /[\r\n]/,
					onLine: (l) => {
						const p = rsyncProgress(l)
						if (p) item.progress = 0.8 * ((i + p.percent) / plan.disks.length)
					},
				}).catch((err) => {
					throw new Error(`Copying its disk didn’t finish: ${String(err.message).slice(0, 200)}`)
				})
				local.push({file: join(to, file), bus: d.bus, format: d.format})
				i++
			}
			item.step = 'Making the machine'
			item.progress = 0.85
			const {id} = await machines.importVm({...plan, disks: local})
			const end = now() + 12 * 60 * 60_000
			for (;;) {
				const s = machines.importState(id)
				if (s.done) {
					if (s.error) throw new Error(s.error)
					break
				}
				if (now() > end) throw new Error('Making the machine took too long')
				await new Promise((r) => setTimeout(r, 3000))
			}
			if (plan.notes.length) item.note = plan.notes.join(' ')
		} finally {
			await rm(stage, {recursive: true, force: true})
		}
	}

	async function status() {
		await ready
		const {done: _d, ...j} = job ?? {}
		return {
			connected: session ? {host: session.host, version: session.version, fingerprint: session.fingerprint} : null,
			scanned: !!session?.scan,
			job: job ? j : null,
		}
	}

	async function cancel() {
		await ready
		if (job && !job.endedAt) job.cancelled = true
		return true
	}

	async function disconnect() {
		await ready
		if (job && !job.endedAt) throw new RpcError('CONFLICT', 'An import is running')
		forget()
		return true
	}

	return {
		ready,
		close: () => (clearTimeout(idle), forget()),
		procedures: {
			'unraid.status': {kind: 'query', run: status},
			'unraid.connect': {kind: 'mutation', run: connect},
			'unraid.scan': {kind: 'mutation', run: scan},
			'unraid.start': {kind: 'mutation', run: start},
			'unraid.cancel': {kind: 'mutation', run: cancel},
			'unraid.disconnect': {kind: 'mutation', run: disconnect},
			'unraid.forgetHost': {kind: 'mutation', run: forgetHost},
		},
	}
}
