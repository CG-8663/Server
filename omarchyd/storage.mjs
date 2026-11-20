// NAS for omarchyd: drives and their health, Btrfs pools, drive sleep, and network (SMB) shares.
// Reading drive layout needs no privileges (lsblk, /etc/fstab). Anything that needs root goes through
// the Omarchy Server helper (helper/helper.mjs, installed root-owned, allowed by one sudoers rule),
// which re-checks every request itself.
import {writeAtomic} from './atomic.mjs'
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {access, readFile, rm, statfs, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

import {RpcError} from './rpc.mjs'

export const HELPER = '/usr/local/libexec/omarchy-server/helper.mjs'
const FSTAB_MARK = '# omarchy-server pool'
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/efi', '/boot/efi', '/home', '/var', '/usr', '[SWAP]'])

function execP(cmd, args, {input, timeout = 10 * 60_000} = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, {timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				const e = new Error((stderr || error.message).toString().trim().split('\n')[0])
				e.code = error.code
				return reject(e)
			}
			resolve(stdout.toString())
		})
		if (input !== undefined) child.stdin.end(input)
	})
}
const flat = (d) => [d, ...(d.children ?? []).flatMap(flat)]
const truthy = (v) => v === true || v === 1 || v === '1'

function parseSmart(j) {
	const standby =
		/^(standby|sleep)$/i.test(String(j?.power_mode ?? '')) ||
		(j?.smartctl?.messages ?? []).some((m) => /\b(standby|sleep)\b/i.test(m?.string ?? ''))
	const attrs = Object.fromEntries((j?.ata_smart_attributes?.table ?? []).map((a) => [a.id, a.raw?.value]))
	const nvme = j?.nvme_smart_health_information_log
	const hasData =
		j?.smart_status != null ||
		j?.temperature != null ||
		j?.power_on_time != null ||
		nvme != null ||
		Object.keys(attrs).length > 0
	if ((standby && !hasData) || (!hasData && j?.smartctl?.exit_status === 2)) return {standby: true, value: null}
	if (!hasData) return {standby: false, value: null}
	return {
		standby: false,
		value: {
			passed: j.smart_status?.passed ?? null,
			temperature: j.temperature?.current ?? nvme?.temperature ?? null,
			powerOnHours: j.power_on_time?.hours ?? nvme?.power_on_hours ?? null,
			lifetimeUsed: nvme?.percentage_used ?? null,
			reallocated: attrs[5] ?? null,
			pending: attrs[197] ?? null,
		},
	}
}

export function createStorage({dataDir, home = os.homedir(), files, run = execP, fstabPath = '/etc/fstab', user = os.userInfo().username, helperFile = HELPER, smbConf = '/etc/samba/smb.conf', now = Date.now}) {
	const sharesFile = join(dataDir, 'shares.json')
	const sleepFile = join(dataDir, 'drive-sleep.json')
	const passwordFile = join(dataDir, 'share-password')
	const smartCache = new Map() // path -> {at, value}

	const helper = async (verb, args = [], input) => {
		try {
			return (await run('sudo', ['-n', HELPER, verb, ...args], {input})).trim()
		} catch (error) {
			// The helper's own messages are written for people; pass them on.
			throw new RpcError('PRECONDITION_FAILED', /a password is required|not allowed|no such file|command not found/i.test(error.message) ? 'Storage tools aren’t set up. Run the Omarchy Server installer again.' : error.message)
		}
	}
	const readJson = async (file, fallback) => JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)))
	const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2))

	async function blockDevices() {
		const j = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,MOUNTPOINTS,RM,HOTPLUG']))
		return (j.blockdevices ?? []).filter((d) => d.type === 'disk' && !/^(zram|loop|sr|ram)|^mmcblk\d+boot|rpmb$/.test(d.name) && Number(d.size) > 0)
	}
	async function fstabPools() {
		const text = await readFile(fstabPath, 'utf8').catch(() => '')
		return text
			.split('\n')
			.filter((l) => l.includes(FSTAB_MARK))
			.map((l) => ({uuid: /^UUID=(\S+)/.exec(l)?.[1], mountpoint: l.split(/\s+/)[1], name: l.slice(l.indexOf(FSTAB_MARK) + FSTAB_MARK.length).trim()}))
			.filter((p) => p.uuid && NAME.test(p.name))
	}

	// SMART summary, normalised across SATA and NVMe.
	async function health(path) {
		const hit = smartCache.get(path)
		if (hit && now() - hit.at < 10 * 60_000) return hit.value
		let value = null
		try {
			const res = parseSmart(JSON.parse(await helper('smart', [path])))
			value = res.standby ? (hit?.value ?? null) : res.value
		} catch (error) {
			if (/\b(standby|sleep)\b/i.test(error?.message ?? '') && hit?.value) value = hit.value
		}
		smartCache.set(path, {at: now(), value})
		return value
	}

	async function disks() {
		const [devs, pools, sleep, helperOk, zp] = await Promise.all([blockDevices(), fstabPools(), readJson(sleepFile, {}), status().then((s) => s.helperAvailable), zfsPools()])
		const poolByUuid = new Map(pools.map((p) => [p.uuid, p.name]))
		const zfsNames = new Set(zp.map((z) => z.name))
		return Promise.all(
			devs.map(async (d) => {
				const all = flat(d)
				const mounts = all.flatMap((x) => (x.mountpoints ?? []).filter(Boolean))
				const btrfs = all.find((x) => x.fstype === 'btrfs')
				const zmember = all.find((x) => x.fstype === 'zfs_member')
				const pool = btrfs ? (poolByUuid.get(btrfs.uuid) ?? null) : zmember && zfsNames.has(zmember.label) ? zmember.label : null
				const system = mounts.some((m) => SYSTEM_MOUNTS.has(m))
				const blank = !d.fstype && !(d.children ?? []).length && !mounts.length
				const nvme = d.tran === 'nvme' || d.name.startsWith('nvme')
				const mountList = mounts.filter(Boolean)
				return {
					path: d.path,
					id: d.path,
					name: d.name,
					model: (d.model ?? '').trim() || null,
					serial: d.serial ?? null,
					size: Number(d.size),
					kind: nvme ? 'nvme' : truthy(d.rota) ? 'hdd' : 'ssd',
					transport: d.tran ?? null,
					removable: truthy(d.rm) || truthy(d.hotplug),
					role: system ? 'system' : pool ? 'pool' : blank ? 'blank' : 'data',
					pool,
					mounted: mountList.length > 0,
					mounts: mountList,
					btrfs: btrfs && !pool ? {uuid: btrfs.uuid, label: btrfs.label ?? null, mounted: !!(btrfs.mountpoints ?? []).some(Boolean)} : null,
					zfs: zmember && !pool ? {pool: zmember.label ?? null} : null,
					sleepMinutes: d.serial && sleep[d.serial] !== undefined ? sleep[d.serial] : null,
					health: helperOk ? await health(d.path) : null,
				}
			}),
		)
	}

	async function zfsPools() {
		if (!(await status()).zfsAvailable) return []
		return helper('zfs-pools').then((t) => JSON.parse(t), () => [])
	}
	async function pools() {
		const [devs, list] = await Promise.all([blockDevices(), fstabPools()])
		const btrfs = await Promise.all(
			list.map(async (p) => {
				const members = devs.filter((d) => flat(d).some((x) => x.uuid === p.uuid)).map((d) => d.path)
				const mounted = devs.flatMap(flat).some((x) => x.uuid === p.uuid && (x.mountpoints ?? []).includes(p.mountpoint))
				let size = null
				let free = null
				if (mounted) {
					const s = await statfs(p.mountpoint).catch(() => null)
					if (s) (size = s.blocks * s.bsize), (free = s.bavail * s.bsize)
				}
				let detail = null
				if (mounted) detail = await helper('pool-status', [p.name]).then((t) => JSON.parse(t), () => null)
				const errors = detail ? Object.values(detail.devices).reduce((n, d) => n + Object.values(d).reduce((a, b) => a + b, 0), 0) : 0
				return {kind: 'btrfs', name: p.name, uuid: p.uuid, mountpoint: p.mountpoint, folder: `/Home/Pools/${p.name}`, mounted, devices: members, size, free, profile: detail?.profile ?? null, errors, scrub: detail?.scrub ?? null}
			}),
		)
		const virtualOf = (real) => (real && real.startsWith(`${home}/`) ? `/Home${real.slice(home.length)}` : null)
		const zfsList = (await zfsPools()).map((z) => ({
			kind: 'zfs',
			name: z.name,
			uuid: `zfs:${z.name}`,
			mountpoint: z.mountpoint,
			folder: virtualOf(z.folder),
			mounted: true,
			devices: z.devices.map((d) => d.path),
			size: z.size,
			free: z.free,
			profile: z.layout,
			health: z.health,
			errors: z.devices.reduce((n, d) => n + d.errors, 0) + (z.errors && z.errors !== 'No known data errors' ? 1 : 0),
			scrub: {state: /in progress/.test(z.scan) ? 'running' : z.scan ? 'finished' : 'never', errors: / 0B repaired.* 0 errors| with 0 errors/.test(z.scan) || !z.scan ? '' : /errors/.test(z.scan) ? z.scan : '', started: null, summary: z.scan},
		}))
		return [...btrfs, ...zfsList]
	}

	async function importable() {
		const [devs, list] = await Promise.all([blockDevices(), fstabPools()])
		const known = new Set(list.map((p) => p.uuid))
		const byUuid = new Map()
		for (const d of devs)
			for (const x of flat(d))
				if (x.fstype === 'btrfs' && x.uuid && !known.has(x.uuid) && !(x.mountpoints ?? []).some(Boolean)) {
					const e = byUuid.get(x.uuid) ?? {uuid: x.uuid, label: x.label ?? null, devices: []}
					e.devices.push(x.path)
					byUuid.set(x.uuid, e)
				}
		const zfsImport = (await status()).zfsAvailable ? await helper('zfs-importable').then((t) => JSON.parse(t), () => []) : []
		return [...[...byUuid.values()].map((b) => ({kind: 'btrfs', ...b})), ...zfsImport.map((z) => ({kind: 'zfs', uuid: `zfs:${z.name}`, label: z.name, devices: [], state: z.state, otherSystem: z.otherSystem, note: z.note}))]
	}

	let statusCache = null
	async function status() {
		if (statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value
		const helperAvailable = await run('sudo', ['-n', HELPER, 'ping']).then((t) => t.trim() === 'ok', () => false)
		const zfsAvailable = helperAvailable && (await helper('zfs-available').then((t) => t === 'yes', () => false))
		statusCache = {at: Date.now(), value: {helperAvailable, zfsAvailable}}
		return statusCache.value
	}

	// ---- shares -----------------------------------------------------------------------------------
	// Add, update, remove, and a folder move each read the list and write it back. One queue, so
	// each starts from the list the previous call saved.
	let shareQueue = Promise.resolve()
	function withShares(fn) {
		const run = shareQueue.then(fn, fn)
		shareQueue = run.then(() => {}, () => {})
		return run
	}
	// Samba treats these section names as its own, in any case. A share must not use them.
	const SAMBA_RESERVED = new Set(['global', 'homes', 'printers'])
	async function shareList() {
		const shares = await readJson(sharesFile, [])
		return Promise.all(
			shares.map(async (s) => ({
				name: s.name,
				path: s.path,
				sharename: s.name,
				// No password: anyone on your network can open it. Otherwise your share password.
				password: !s.guest,
				readOnly: !!s.readOnly,
				available: await files.resolve(s.path).then(() => true, () => false),
			})),
		)
	}
	async function applyShares(shares) {
		const out = []
		for (const s of shares) {
			const r = await files.resolve(s.path).catch(() => null)
			if (r && r.top === 'Home') out.push({name: s.name, path: r.real, readOnly: !!s.readOnly, ...(s.guest ? {guest: true} : {})})
		}
		await helper('shares-apply', [], JSON.stringify({shares: out}))
	}
	// `to` is the folder's new virtual path, or null when it was trashed. Nested shares follow too.
	// /Home/Music must not take /Home/MusicVideos with it.
	async function relocateShares(from, to) {
		if (typeof from !== 'string' || !from.startsWith('/Home/')) return
		if (to != null && (typeof to !== 'string' || !to.startsWith('/Home/'))) return
		await withShares(async () => {
			const shares = await readJson(sharesFile, [])
			const under = (p) => p === from || (typeof p === 'string' && p.startsWith(from + '/'))
			const next = to == null ? shares.filter((s) => !under(s.path)) : shares.map((s) => (under(s.path) ? {...s, path: to + s.path.slice(from.length)} : s))
			if (next.length === shares.length && next.every((s, i) => s.path === shares[i].path)) return
			// The folder has already moved. The list has to match even if Samba does not reload.
			await writeJson(sharesFile, next)
			await applyShares(next).catch(() => {})
		})
	}
	// Shares without a password need a helper that knows them (installed with Omarchy Server 0.9.21 or
	// later). Read the installed helper rather than guess, so an older one is never asked (it would
	// quietly keep the password, while the page said there was none).
	const helperKnowsGuests = () => readFile(helperFile, 'utf8').then((t) => t.includes('guest ok = yes'), () => false)
	// Samba and the libraries it uses (smbclient, libwbclient) must be one version. After a partial
	// update (one package installed from a newer package list without updating the rest) they aren't,
	// and every Samba program fails. pacman -Q needs no root, so this is checked here, with any helper.
	// The fix: bring the whole system up to date. On Omarchy that's `omarchy update` (it blocks a
	// direct pacman -Syu, since its update also runs snapshots, migrations and hooks).
	const onOmarchy = () => run('sh', ['-c', 'command -v omarchy']).then((t) => !!String(t).trim(), () => false)
	async function sambaFix(missing) {
		if (await onOmarchy()) return missing ? 'omarchy update && omarchy pkg add samba' : 'omarchy update'
		return 'sudo pacman -Syu --needed samba'
	}
	async function sambaHealth() {
		const version = (pkg) => run('pacman', ['-Q', pkg]).then((t) => String(t).trim().split(/\s+/)[1] ?? null, () => null)
		const [samba, smbclient, libwbclient] = await Promise.all(['samba', 'smbclient', 'libwbclient'].map(version))
		if (!samba) return {ok: false, problem: 'missing', command: await sambaFix(true)}
		const parts = {samba, smbclient, libwbclient}
		const off = Object.entries(parts).filter(([, v]) => v && v !== samba)
		if (off.length) return {ok: false, problem: 'mismatch', command: await sambaFix(false), versions: parts}
		return {ok: true}
	}
	async function requireSamba() {
		const h = await sambaHealth()
		if (h.ok) return
		throw new RpcError(
			'PRECONDITION_FAILED',
			h.problem === 'missing'
				? `Samba (for network shares) isn’t installed. Run this once in a terminal on the server: ${h.command}`
				: `Samba on this server is half-updated (samba ${h.versions.samba}, its libraries ${h.versions.smbclient}). Update the system once in a terminal on the server: ${h.command}`,
		)
	}
	async function shareSettings(input) {
		const out = {}
		if (input?.password !== undefined) out.guest = input.password === false
		if (input?.readOnly !== undefined) out.readOnly = input.readOnly === true
		if (out.guest && !(await helperKnowsGuests())) throw new RpcError('PRECONDITION_FAILED', 'Sharing without a password needs Omarchy Server’s installer to run once more on this server. Shares with a password work now.')
		return out
	}
	// Samba's password tool won't run until /etc/samba/smb.conf exists, and Arch's samba package doesn't
	// create one. Writing the current share list first (what the helper does anyway) creates it.
	async function ensureSambaConfig(shares) {
		if (await access(smbConf).then(() => true, () => false)) return
		await applyShares(shares)
	}
	async function sharePassword() {
		try {
			return (await readFile(passwordFile, 'utf8')).trim()
		} catch {
			const words = Array.from({length: 4}, () => randomBytes(3).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4))
			const pw = words.join('-')
			await helper('smb-password', [], `${pw}\n`)
			await writeFile(passwordFile, pw, {mode: 0o600})
			return pw
		}
	}

	files.followShares?.(relocateShares)

	return {
		helper,
		procedures: {
			'storage.status': {kind: 'query', run: status},
			'storage.disks': {kind: 'query', run: disks},
			'storage.pools': {kind: 'query', run: pools},
			'storage.importable': {kind: 'query', run: importable},
			'storage.createPool': {
				kind: 'mutation',
				run: async (input) => {
					const name = String(input?.name ?? '')
					const devices = Array.isArray(input?.devices) ? input.devices.map(String) : []
					if (!NAME.test(name)) throw new RpcError('BAD_REQUEST', 'Pool names use a-z, 0-9 and -, starting with a letter')
					if ((await pools()).some((p) => p.name === name)) throw new RpcError('CONFLICT', `There’s already a pool called ${name}`)
					await helper(input?.fs === 'zfs' ? 'zfs-create' : 'pool-create', [name, String(input?.profile ?? ''), ...devices])
					return true
				},
			},
			'storage.addToPool': {kind: 'mutation', run: async (input) => (await helper('pool-add', [String(input?.name ?? ''), String(input?.device ?? '')]), true)},
			'storage.importPool': {
				kind: 'mutation',
				run: async (input) => {
					const uuid = String(input?.uuid ?? '')
					if (uuid.startsWith('zfs:')) await helper('zfs-import', [uuid.slice(4), ...(input?.force === true ? ['force'] : [])])
					else await helper('pool-import', [String(input?.name ?? ''), uuid])
					return true
				},
			},
			'storage.forgetPool': {kind: 'mutation', run: async (input) => (await helper(input?.kind === 'zfs' ? 'zfs-export' : 'pool-forget', [String(input?.name ?? '')]), true)},
			'storage.scrub': {kind: 'mutation', run: async (input) => (await helper(input?.kind === 'zfs' ? 'zfs-scrub' : 'pool-scrub', [String(input?.name ?? '')]), true)},
			'storage.setSleep': {
				kind: 'mutation',
				run: async (input) => {
					const device = String(input?.device ?? '')
					const minutes = Number(input?.minutes)
					await helper('sleep', [device, String(minutes)])
					const d = (await blockDevices()).find((x) => x.path === device)
					if (d?.serial) {
						const sleep = await readJson(sleepFile, {})
						sleep[d.serial] = minutes
						await writeJson(sleepFile, sleep)
					}
					return true
				},
			},
			'storage.unmount': {
				kind: 'mutation',
				run: async (input) => (await helper('umount', [String(input?.device ?? '')]), true),
			},
			'storage.mount': {
				kind: 'mutation',
				run: async (input) => (await helper('mount', [String(input?.device ?? '')]), true),
			},
			'storage.format': {
				kind: 'mutation',
				run: async (input) => {
					const filesystem = String(input?.filesystem ?? '')
					if (!['blank', 'ext4', 'exfat'].includes(filesystem)) throw new RpcError('BAD_REQUEST', 'Choose blank, ext4 or exfat')
					await helper('format', [String(input?.device ?? ''), filesystem])
					return true
				},
			},
			'files.shares': {kind: 'query', run: shareList},
			'files.sharePassword': {kind: 'query', run: sharePassword},
			'files.shareOptions': {kind: 'query', run: async () => ({noPassword: await helperKnowsGuests(), samba: await sambaHealth()})},
			// Your own password for network shares (the user name is your server account's).
			'files.setSharePassword': {
				kind: 'mutation',
				run: async (input) => {
					const pw = String(input?.password ?? '')
					if (pw.length < 8 || pw.length > 128 || /[\r\n]/.test(pw)) throw new RpcError('BAD_REQUEST', 'Use 8 to 128 characters, on one line.')
					await requireSamba()
					await ensureSambaConfig(await readJson(sharesFile, []))
					await helper('smb-password', [], `${pw}\n`)
					await writeFile(passwordFile, pw, {mode: 0o600})
					return true
				},
			},
			// Change how a folder is shared: with or without a password, read-only or not.
			'files.updateShare': {
				kind: 'mutation',
				run: (input) => withShares(async () => {
					const path = String(input?.path ?? '')
					const shares = await readJson(sharesFile, [])
					const i = shares.findIndex((s) => s.path === path)
					if (i < 0) throw new RpcError('NOT_FOUND', 'That folder isn’t shared')
					await requireSamba()
					const settings = await shareSettings(input)
					const {guest, readOnly, ...rest} = {...shares[i], ...settings}
					const next = shares.map((s, j) => (j === i ? {...rest, ...(guest ? {guest: true} : {}), ...(readOnly ? {readOnly: true} : {})} : s))
					if (!guest) await ensureSambaConfig(shares), await sharePassword()
					await applyShares(next)
					await writeJson(sharesFile, next)
					return true
				}),
			},
			'files.addShare': {
				kind: 'mutation',
				run: (input) => withShares(async () => {
					const path = String(input?.path ?? '')
					const r = await files.resolve(path)
					if (r.top !== 'Home' || path === '/Home') throw new RpcError('BAD_REQUEST', 'Choose a folder inside Home to share')
					const shares = await readJson(sharesFile, [])
					if (shares.some((s) => s.path === path)) return true
					const base = (path.split('/').pop() || 'Share').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 28) || 'Share'
					let name = base
					const nameTaken = (n) => SAMBA_RESERVED.has(n.toLowerCase()) || shares.some((s) => s.name.toLowerCase() === n.toLowerCase())
					for (let n = 2; nameTaken(name); n++) name = `${base} ${n}`
					await requireSamba()
					const settings = await shareSettings(input)
					const next = [...shares, {name, path, ...(settings.guest ? {guest: true} : {}), ...(settings.readOnly ? {readOnly: true} : {})}]
					if (!settings.guest) await ensureSambaConfig(shares), await sharePassword()
					await applyShares(next)
					await writeJson(sharesFile, next)
					return true
				}),
			},
			'files.removeShare': {
				kind: 'mutation',
				run: (input) => withShares(async () => {
					const next = (await readJson(sharesFile, [])).filter((s) => s.path !== String(input?.path ?? ''))
					await applyShares(next)
					await writeJson(sharesFile, next)
					return true
				}),
			},
		},
		// Factory reset: drop the share list and the share password. Clearing Samba is best-effort;
		// the files go either way, so the next owner does not inherit the password.
		async clearShares() {
			await withShares(async () => {
				await applyShares([]).catch((e) => console.error('[omarchyd] reset shares', e.message))
				await rm(sharesFile, {force: true})
				await rm(passwordFile, {force: true})
			})
		},
		firewall: {
			open: (port) => helper('firewall-open', [String(port)]).catch(() => {}),
			close: (port) => helper('firewall-close', [String(port)]).catch(() => {}),
			// Not caught: an app that needs system ports can't start without this.
			lowPorts: (n) => helper('low-ports', [String(n)]),
		},
	}
}
