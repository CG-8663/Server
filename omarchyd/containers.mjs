// Containers (LXC) for omarchyd, run by Incus in its per-user mode.
//
// Why per-user Incus: the Incus daemon runs as root, but a member of the `incus` group (not
// `incus-admin`) only reaches incus-user's socket, which gives this account its own restricted
// project: its own containers, network and limits, unprivileged containers only, no host devices.
// That matches the virtual machines (QEMU on libvirt's per-user session) and keeps MODC's account
// from becoming root-equivalent. Nothing here listens on the network: Incus is reached through its
// local socket by the `incus` command, and a port is opened to the home network only when the owner
// adds one.
//
// The library is the Linux systems Incus already offers (images.linuxcontainers.org). Small app
// recipes are the App Store's job, so there are none here.

import {execFile} from 'node:child_process'
import os from 'node:os'

import {RpcError} from './rpc.mjs'

const NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/
const SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const ALIAS = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const PORT_DEVICE = /^port-(tcp|udp)-(\d{1,5})$/

// The systems offered, in this order. Others in Incus's list (and older releases) stay out to keep
// the library short and maintained.
export const DISTROS = [
	{os: 'debian', name: 'Debian'},
	{os: 'ubuntu', name: 'Ubuntu'},
	{os: 'alpine', name: 'Alpine'},
	{os: 'archlinux', name: 'Arch Linux'},
	{os: 'fedora', name: 'Fedora'},
	{os: 'rockylinux', name: 'Rocky Linux'},
	{os: 'almalinux', name: 'AlmaLinux'},
	{os: 'opensuse', name: 'openSUSE'},
]

const ARCH = {x64: 'x86_64', arm64: 'aarch64'}[process.arch] ?? process.arch

/** The command that sets up per-user Incus on an Arch-based server (Omarchy). It needs sudo once,
 * so the owner runs it; MODC never asks for the password. */
export function setupCommand(user = os.userInfo().username) {
	return [
		'sudo pacman -S --needed incus',
		// Unprivileged containers map their users into this range of the host's IDs.
		"grep -q '^root:1000000:' /etc/subuid || echo 'root:1000000:1000000000' | sudo tee -a /etc/subuid",
		"grep -q '^root:1000000:' /etc/subgid || echo 'root:1000000:1000000000' | sudo tee -a /etc/subgid",
		'sudo systemctl enable --now incus.socket incus-user.socket',
		// A storage pool and the default profile; containers use them.
		'(sudo incus storage show default >/dev/null 2>&1 || sudo incus admin init --minimal)',
		`sudo usermod -aG incus ${user}`,
	].join(' && ')
}

/** Group a `incus image list images: --format json` listing into the library: per system, its
 * current releases for this server's architecture, newest first. */
export function libraryFrom(images, arch = ARCH) {
	const byOs = new Map()
	for (const img of Array.isArray(images) ? images : []) {
		const p = img?.properties ?? {}
		if (img?.type !== 'container' || p.architecture !== arch || (p.variant && p.variant !== 'default')) continue
		const distro = DISTROS.find((d) => d.os === String(p.os ?? '').toLowerCase())
		if (!distro) continue
		const alias = (img.aliases ?? []).map((a) => a?.name).filter((n) => typeof n === 'string' && ALIAS.test(n) && !n.endsWith('/default') && n.split('/').length === 2).sort((a, b) => a.length - b.length)[0]
		if (!alias) continue
		const release = String(p.release ?? alias.split('/')[1])
		const list = byOs.get(distro.os) ?? []
		if (!list.some((r) => r.alias === alias)) list.push({alias, release, description: String(p.description ?? `${distro.name} ${release}`), size: Number(img.size) || 0})
		byOs.set(distro.os, list)
	}
	const rank = (r) => (/^(current|edge|tumbleweed|sid|rawhide)$/.test(r) ? 0 : 1)
	const num = (r) => r.split(/[.]/).map((x) => Number.parseInt(x, 10) || 0)
	const newer = (a, b) => {
		const [x, y] = [num(a.release), num(b.release)]
		for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
		return 0
	}
	return DISTROS.filter((d) => byOs.has(d.os)).map((d) => ({
		os: d.os,
		name: d.name,
		// Numbered releases first (newest), then rolling ones; at most four.
		releases: byOs.get(d.os).sort((a, b) => rank(b.release) - rank(a.release) || newer(a, b)).slice(0, 4),
	}))
}

const gib = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10

/** One container from `incus list --format json`, in the shape the web app shows. */
export function containerFrom(c) {
	const cfg = c?.config ?? {}
	const state = c?.state ?? {}
	const addresses = []
	for (const [nic, n] of Object.entries(state.network ?? {})) {
		if (nic === 'lo') continue
		for (const a of n?.addresses ?? []) if (a?.scope === 'global') addresses.push({family: a.family === 'inet6' ? 'IPv6' : 'IPv4', address: a.address})
	}
	const ports = []
	for (const [name, dev] of Object.entries(c?.devices ?? {})) {
		const m = PORT_DEVICE.exec(name)
		if (!m || dev?.type !== 'proxy') continue
		const inner = /:(\d+)$/.exec(String(dev.connect ?? ''))
		ports.push({protocol: m[1], hostPort: Number(m[2]), containerPort: inner ? Number(inner[1]) : null})
	}
	const root = c?.expanded_devices?.root ?? c?.devices?.root ?? {}
	return {
		name: String(c?.name ?? ''),
		status: String(c?.status ?? 'Unknown').toLowerCase(),
		os: String(cfg['image.os'] ?? ''),
		release: String(cfg['image.release'] ?? ''),
		description: String(cfg['image.description'] ?? ''),
		cpus: cfg['limits.cpu'] ? Number(cfg['limits.cpu']) || null : null,
		memory: cfg['limits.memory'] ?? null,
		disk: root.size ?? null,
		memoryUsedGiB: state.memory?.usage ? gib(state.memory.usage) : null,
		addresses,
		ports: ports.sort((a, b) => a.hostPort - b.hostPort),
		snapshots: (c?.snapshots ?? []).map((s) => ({name: String(s?.name ?? '').split('/').pop(), createdAt: s?.created_at ?? null})),
		createdAt: c?.created_at ?? null,
	}
}

function defaultRun(args, {timeout = 60_000} = {}) {
	return new Promise((resolve, reject) => {
		execFile('incus', args, {timeout, maxBuffer: 64 * 1024 * 1024, env: {...process.env, LC_ALL: 'C'}}, (error, stdout, stderr) => {
			if (error) {
				error.stderr = String(stderr ?? '')
				return reject(error)
			}
			resolve(String(stdout))
		})
	})
}

/**
 * @param {object} o
 * @param {(args: string[], opts?: {timeout?: number}) => Promise<string>} [o.run] runs `incus`
 * @param {number[]} [o.reservedPorts] this server's own ports, never handed to a container
 */
export function createContainers({run = defaultRun, reservedPorts = [], user = os.userInfo().username, now = Date.now} = {}) {
	const creating = new Map() // name -> {alias, error?}
	let library = null // {at, value}

	const message = (error) => {
		const text = String(error?.stderr || error?.message || error).trim()
		return (text.split('\n').filter(Boolean).pop() ?? 'Incus failed').replace(/^Error:\s*/, '')
	}
	const incus = async (args, opts) => {
		try {
			return await run(args, opts)
		} catch (error) {
			if (error?.code === 'ENOENT') throw new RpcError('PRECONDITION_FAILED', 'CONTAINERS_NOT_SET_UP: Incus isn’t installed on this server yet.')
			throw new RpcError('INTERNAL_SERVER_ERROR', message(error))
		}
	}
	const name = (v) => {
		const n = String(v ?? '')
		if (!NAME.test(n)) throw new RpcError('BAD_REQUEST', 'Use lowercase letters, numbers and dashes for the name (up to 63, starting with a letter).')
		return n
	}

	async function status() {
		let out
		try {
			out = await run(['info', '--format', 'json'], {timeout: 10_000})
		} catch (error) {
			const text = String(error?.stderr || error?.message || '')
			const reason =
				error?.code === 'ENOENT'
					? 'Incus isn’t installed on this server yet.'
					: /permission denied/i.test(text)
						? 'This account can’t reach Incus yet. If you just ran the setup, restart the server so the new group applies.'
						: /no such file|connection refused|unix\.socket/i.test(text)
							? 'Incus is installed but its per-user service isn’t running.'
							: message(error)
			return {available: false, reason, setupCommand: setupCommand(user)}
		}
		let info = {}
		try {
			info = JSON.parse(out)
		} catch {
			/* older output */
		}
		return {available: true, version: info?.environment?.server_version ?? null, project: info?.environment?.project ?? null}
	}

	async function list() {
		const out = await incus(['list', '--format', 'json'], {timeout: 20_000})
		let all = []
		try {
			all = JSON.parse(out)
		} catch {
			throw new RpcError('INTERNAL_SERVER_ERROR', 'Incus gave a list this server couldn’t read')
		}
		const rows = all.filter((c) => c?.type === 'container').map(containerFrom)
		for (const [n, c] of creating) if (!rows.some((r) => r.name === n)) rows.push({...containerFrom({name: n, status: c.error ? 'error' : 'creating'}), os: c.alias.split('/')[0], release: c.alias.split('/')[1], error: c.error ?? null})
		return rows.sort((a, b) => a.name.localeCompare(b.name))
	}

	async function images({refresh = false} = {}) {
		if (!refresh && library && now() - library.at < 6 * 3600_000) return library.value
		const out = await incus(['image', 'list', 'images:', 'type=container', `architecture=${ARCH}`, '--format', 'json'], {timeout: 90_000})
		let all = []
		try {
			all = JSON.parse(out)
		} catch {
			throw new RpcError('INTERNAL_SERVER_ERROR', 'The container library couldn’t be read')
		}
		library = {at: now(), value: libraryFrom(all)}
		return library.value
	}

	async function create(input = {}) {
		const n = name(input.name)
		const alias = String(input.image ?? '')
		if (!ALIAS.test(alias)) throw new RpcError('BAD_REQUEST', 'Pick a system from the library')
		const lib = await images()
		if (!lib.some((d) => d.releases.some((r) => r.alias === alias))) throw new RpcError('BAD_REQUEST', 'That system isn’t in the library')
		const cpus = Number(input.cpus ?? 1)
		const memoryMiB = Number(input.memoryMiB ?? 1024)
		const diskGiB = Number(input.diskGiB ?? 8)
		if (!Number.isInteger(cpus) || cpus < 1 || cpus > os.cpus().length) throw new RpcError('BAD_REQUEST', `Use 1 to ${os.cpus().length} CPUs`)
		if (!Number.isInteger(memoryMiB) || memoryMiB < 128 || memoryMiB > Math.floor(os.totalmem() / 1024 ** 2)) throw new RpcError('BAD_REQUEST', 'That’s more memory than this server has')
		if (!Number.isInteger(diskGiB) || diskGiB < 1 || diskGiB > 4096) throw new RpcError('BAD_REQUEST', 'Use 1 to 4096 GB of disk')
		if (creating.has(n) && !creating.get(n).error) throw new RpcError('CONFLICT', `${n} is already being created`)
		if ((await list()).some((c) => c.name === n && c.status !== 'error')) throw new RpcError('CONFLICT', `There’s already a container named ${n}`)
		creating.set(n, {alias})
		// Downloading a system the first time takes a while: the list shows it as being created.
		incus(['launch', `images:${alias}`, n, '--config', `limits.cpu=${cpus}`, '--config', `limits.memory=${memoryMiB}MiB`, '--device', `root,size=${diskGiB}GiB`], {timeout: 15 * 60_000}).then(
			() => creating.delete(n),
			(error) => creating.set(n, {alias, error: error.message}),
		)
		return {name: n}
	}

	const power = (verb) => async (input = {}) => {
		const n = name(input.name)
		if (verb === 'start') await incus(['start', n])
		else if (verb === 'restart') await incus(['restart', n, '--timeout', '60'], {timeout: 90_000})
		else if (verb === 'stop') {
			try {
				await incus(['stop', n, '--timeout', '60'], {timeout: 90_000})
			} catch (error) {
				throw new RpcError('PRECONDITION_FAILED', `STOP_TIMED_OUT: ${n} didn’t shut down within a minute (${error.message}). Force stop turns it off straight away.`)
			}
		} else if (verb === 'forceStop') await incus(['stop', n, '--force'])
		return {ok: true}
	}

	async function remove(input = {}) {
		const n = name(input.name)
		if (creating.get(n)?.error) {
			creating.delete(n)
			return {ok: true}
		}
		await incus(['delete', n, '--force'], {timeout: 120_000})
		return {ok: true}
	}

	const snapshot = (verb) => async (input = {}) => {
		const n = name(input.name)
		const s = String(input.snapshot ?? '')
		if (!SNAPSHOT.test(s)) throw new RpcError('BAD_REQUEST', 'Use letters, numbers, dots, dashes and underscores for the snapshot name')
		await incus(['snapshot', verb, n, s], {timeout: 300_000})
		return {ok: true}
	}

	const portNumber = (v, what) => {
		const p = Number(v)
		if (!Number.isInteger(p) || p < 1 || p > 65535) throw new RpcError('BAD_REQUEST', `${what} must be 1 to 65535`)
		return p
	}
	async function addPort(input = {}) {
		const n = name(input.name)
		const protocol = input.protocol === 'udp' ? 'udp' : 'tcp'
		const hostPort = portNumber(input.hostPort, 'The server’s port')
		const containerPort = portNumber(input.containerPort, 'The container’s port')
		if (hostPort < 1024) throw new RpcError('BAD_REQUEST', 'Use a server port of 1024 or higher; lower ones belong to the server’s own services.')
		if (reservedPorts.includes(hostPort)) throw new RpcError('CONFLICT', `Port ${hostPort} is My Own Data Center’s own`)
		const taken = (await list()).find((c) => c.ports.some((p) => p.hostPort === hostPort && p.protocol === protocol))
		if (taken) throw new RpcError('CONFLICT', `${taken.name} already uses port ${hostPort}`)
		await incus(['config', 'device', 'add', n, `port-${protocol}-${hostPort}`, 'proxy', `listen=${protocol}:0.0.0.0:${hostPort}`, `connect=${protocol}:127.0.0.1:${containerPort}`])
		return {ok: true}
	}
	async function removePort(input = {}) {
		const n = name(input.name)
		const protocol = input.protocol === 'udp' ? 'udp' : 'tcp'
		const hostPort = portNumber(input.hostPort, 'The server’s port')
		await incus(['config', 'device', 'remove', n, `port-${protocol}-${hostPort}`])
		return {ok: true}
	}

	/** A root shell inside a running container, for the terminal. */
	async function shellFor(n) {
		const c = (await list()).find((x) => x.name === name(n))
		if (!c) throw new RpcError('NOT_FOUND', 'No such container')
		if (c.status !== 'running') throw new RpcError('PRECONDITION_FAILED', `${c.name} isn’t running`)
		return {command: ['incus', 'exec', c.name, '--env', 'TERM=xterm-256color', '--', 'su', '-l']}
	}

	return {
		shellFor,
		procedures: {
			'containers.status': {kind: 'query', run: status},
			'containers.list': {kind: 'query', run: list},
			'containers.images': {kind: 'query', run: (input) => images(input ?? {})},
			'containers.create': {kind: 'mutation', run: create},
			'containers.start': {kind: 'mutation', run: power('start')},
			'containers.stop': {kind: 'mutation', run: power('stop')},
			'containers.restart': {kind: 'mutation', run: power('restart')},
			'containers.forceStop': {kind: 'mutation', run: power('forceStop')},
			'containers.delete': {kind: 'mutation', run: remove},
			'containers.snapshot': {kind: 'mutation', run: snapshot('create')},
			'containers.restoreSnapshot': {kind: 'mutation', run: snapshot('restore')},
			'containers.deleteSnapshot': {kind: 'mutation', run: snapshot('delete')},
			'containers.addPort': {kind: 'mutation', run: addPort},
			'containers.removePort': {kind: 'mutation', run: removePort},
		},
	}
}
