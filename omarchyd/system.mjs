// System facts, read straight from Linux: /proc, /sys and statfs. No root needed.
import {execFile} from 'node:child_process'
import {readFile, readdir, statfs} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'

const sh = (cmd, args, timeout = 10_000) =>
	new Promise((resolve) => execFile(cmd, args, {timeout, maxBuffer: 8 * 1024 * 1024}, (error, stdout) => resolve(error && !stdout ? '' : String(stdout))))

const read = (p) => readFile(p, 'utf8').catch(() => '')

// CPU use between two /proc/stat samples.
let lastCpu = null
async function cpuSample() {
	return cpuFromStat((await read('/proc/stat')).split('\n')[0])
}
export function cpuFromStat(line) {
	const n = line.trim().split(/\s+/).slice(1).map(Number)
	const idle = (n[3] ?? 0) + (n[4] ?? 0)
	// guest and guest_nice (columns 9 and 10) are already counted in user and nice.
	const total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0)
	return {idle, total}
}
// Callers share one sample. A reading over a few milliseconds is only noise (/proc/stat moves in
// 10 ms ticks), so within a second of the last reading the last answer is given again.
let lastAnswer = null
let lastAt = 0
export async function cpuUsage() {
	if (lastAnswer && Date.now() - lastAt < 1000) return lastAnswer
	const now = await cpuSample()
	const prev = lastCpu ?? now
	lastCpu = now
	const dTotal = now.total - prev.total
	const used = dTotal > 0 ? (100 * (dTotal - (now.idle - prev.idle))) / dTotal : 0
	const pct = Math.round(Math.max(0, Math.min(100, used)) * 10) / 10
	const answer = {threads: os.cpus().length, totalUsed: pct, system: pct, apps: [], machines: []}
	if (prev !== now) (lastAnswer = answer), (lastAt = Date.now())
	return answer
}
// Prime the first sample so the first answer isn't 0.
void cpuUsage()

export async function memoryUsage() {
	const info = Object.fromEntries(
		(await read('/proc/meminfo'))
			.split('\n')
			.map((l) => /^(\w+):\s+(\d+)/.exec(l))
			.filter(Boolean)
			.map((m) => [m[1], Number(m[2]) * 1024]),
	)
	const size = info.MemTotal ?? os.totalmem()
	const used = size - (info.MemAvailable ?? os.freemem())
	return {size, totalUsed: used, system: used, apps: [], machines: []}
}

// What takes up the drive: apps, machines and your files are measured in the background (du can
// take a while on a big home folder) and refreshed every 10 minutes; "System" is the rest.
let breakdown = {at: 0, running: null, apps: 0, machines: 0, files: 0}
async function duBytes(paths, {unshare = false} = {}) {
	if (!paths.length) return 0
	const args = ['-n', '19', ...(unshare ? ['podman', 'unshare'] : []), 'du', '-s', '-B1', '--one-file-system', '-c', ...paths]
	const out = await sh('nice', args, 10 * 60_000)
	const total = out.trim().split('\n').pop()?.split('\t')[0]
	return Number(total) || 0
}
async function measure(home, dataDir) {
	const present = async (dir) => ((await readdir(dir).catch(() => null)) ? [dir] : [])
	// App containers' files belong to other user ids, so they're measured from inside podman's namespace.
	const containers = await present(join(home, '.local/share/containers/storage'))
	const appData = dataDir ? await present(join(dataDir, 'apps')) : []
	const apps = (containers.length ? (await duBytes(containers, {unshare: true})) || (await duBytes(containers)) : 0) + (await duBytes(appData, {unshare: true}).then((n) => n || duBytes(appData)))
	const machines = dataDir ? await duBytes(await present(join(dataDir, 'machines'))) : 0
	const visible = ((await readdir(home).catch(() => [])) ?? []).filter((n) => !n.startsWith('.')).map((n) => join(home, n))
	const files = await duBytes(visible)
	breakdown = {at: Date.now(), running: null, apps, machines, files}
}

// The drive the home folder lives on, and how much of it no partition uses yet (after a disk was
// made bigger, the partition and filesystem have to be grown before the space can be used).
let driveCache = {at: 0, value: null}
export const forgetDrive = () => (driveCache = {at: 0, value: null})
const MB = 1024 * 1024
async function driveOf(path, fsSize) {
	if (Date.now() - driveCache.at < 60_000) return driveCache.value
	let value = null
	try {
		const [source, fstype] = (await sh('findmnt', ['-n', '-o', 'SOURCE,FSTYPE', '-T', path])).trim().split(/\s+/)
		const dev = (source ?? '').replace(/\[.*\]$/, '')
		if (dev.startsWith('/dev/')) {
			// From the filesystem's device up to the physical (or virtual) disk.
			const chain = JSON.parse((await sh('lsblk', ['-J', '-b', '-s', '-o', 'NAME,PATH,SIZE,TYPE', dev])) || '{}').blockdevices?.[0]
			const layers = []
			for (let n = chain; n; n = n.children?.[0]) layers.push(n)
			const disk = layers.find((n) => n.type === 'disk')
			const part = layers.find((n) => n.type === 'part')
			const crypt = layers.find((n) => n.type === 'crypt')
			const fsDevice = layers[0]
			if (disk) {
				const tree = JSON.parse((await sh('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,START', disk.path])) || '{}').blockdevices?.[0]
				const parts = (tree?.children ?? []).filter((c) => c.type === 'part')
				const last = parts.reduce((a, c) => (Number(c.start ?? 0) > Number(a?.start ?? -1) ? c : a), null)
				// Each layer that hasn't caught up with the one below it after a disk was made bigger.
				const steps = []
				const partLag = parts.length ? Number(disk.size) - parts.reduce((t, c) => t + Number(c.size || 0), 0) : 0
				if (part && partLag > 256 * MB) steps.push(last?.name === part.name ? 'partition' : 'partition-not-last')
				if (crypt && part && Number(part.size) - Number(crypt.size) > 256 * MB) steps.push('encryption')
				if (fsSize && Number(fsDevice.size) - fsSize > Math.max(1024 * MB, Number(fsDevice.size) * 0.06)) steps.push('filesystem')
				if (crypt && part && partLag > 256 * MB && !steps.includes('encryption')) steps.push('encryption')
				if (part && partLag > 256 * MB && !steps.includes('filesystem')) steps.push('filesystem')
				const notInUse = steps.length ? Math.max(0, Number(disk.size) - fsSize) : 0
				const partNumber = part ? Number(/(\d+)$/.exec(part.name)?.[1]) : null
				value = {
					name: disk.path,
					size: Number(disk.size),
					notInUse,
					steps: [...new Set(steps)],
					partition: part?.path ?? null,
					partitionNumber: Number.isInteger(partNumber) ? partNumber : null,
					encrypted: crypt ? crypt.name : null,
					filesystem: fstype ?? null,
				}
			}
		}
	} catch {
		value = null
	}
	driveCache = {at: Date.now(), value}
	return value
}

export async function diskUsage(path, {dataDir} = {}) {
	const s = await statfs(path)
	const size = s.blocks * s.bsize
	const available = s.bavail * s.bsize
	const used = size - s.bfree * s.bsize
	if (!breakdown.running && Date.now() - breakdown.at > 10 * 60_000) breakdown.running = measure(path, dataDir).catch(() => (breakdown.running = null))
	const {apps, machines, files} = breakdown
	const measured = Math.min(used, apps + machines + files)
	return {
		size,
		totalUsed: used,
		available,
		system: used - measured,
		files: breakdown.at ? Math.min(files, used) : 0,
		apps: breakdown.at && apps ? [{id: 'apps', name: 'Apps', used: Math.min(apps, used)}] : [],
		machines: breakdown.at && machines ? [{id: 'machines', name: 'Machines', used: Math.min(machines, used)}] : [],
		measuring: !breakdown.at,
		drive: await driveOf(path, size),
	}
}

// Is this server a virtual machine? (They have no temperature sensors to read.)
let virtual = null
async function isVirtual() {
	if (virtual !== null) return virtual
	const v = (await sh('systemd-detect-virt', ['--vm'])).trim()
	if (v) virtual = v !== 'none'
	else virtual = /qemu|kvm|vmware|virtualbox|innotek|xen|microsoft|parallels|bochs/i.test(`${await read('/sys/class/dmi/id/sys_vendor')} ${await read('/sys/class/dmi/id/product_name')}`)
	return virtual
}

// The hottest CPU sensor we can find (coretemp, k10temp, zenpower or a thermal zone).
export async function cpuTemperature() {
	let best = null
	for (const hw of await readdir('/sys/class/hwmon').catch(() => [])) {
		const dir = `/sys/class/hwmon/${hw}`
		const name = (await read(`${dir}/name`)).trim()
		if (!/coretemp|k10temp|k8temp|zenpower|cpu|acpitz|soc|x86_pkg/.test(name)) continue
		// Older kernels keep the readings one folder down.
		for (const d of [dir, `${dir}/device`]) {
			for (const f of await readdir(d).catch(() => [])) {
				if (!/^temp\d+_input$/.test(f)) continue
				const t = Number(await read(`${d}/${f}`)) / 1000
				if (Number.isFinite(t) && t > 0 && t < 150 && (best === null || t > best)) best = t
			}
		}
	}
	if (best === null) {
		for (const z of await readdir('/sys/class/thermal').catch(() => [])) {
			if (!z.startsWith('thermal_zone')) continue
			const t = Number(await read(`/sys/class/thermal/${z}/temp`)) / 1000
			if (Number.isFinite(t) && t > 0 && t < 150 && (best === null || t > best)) best = t
		}
	}
	if (best === null) return {warning: 'normal', temperature: null, reason: (await isVirtual()) ? 'virtual' : 'no-sensor'}
	const temperature = Math.round(best)
	return {warning: temperature >= 90 ? 'hot' : temperature >= 80 ? 'warm' : 'normal', temperature}
}

const num = (s) => {
	if (s == null) return null
	const t = String(s).trim()
	if (!t || t === '[N/A]' || /^n\/?a$/i.test(t)) return null
	const n = Number(t)
	return Number.isFinite(n) ? n : null
}

function nvidiaGpu(line) {
	const parts = line.split(',').map((s) => s.trim())
	if (parts.length < 7) return null
	const [index, name, uuid, used, memUsed, memTotal, temp] = parts
	const i = num(index)
	if (i == null || !name) return null
	const mib = (v) => {
		const n = num(v)
		return n == null ? null : Math.round(n * 1024 * 1024)
	}
	const t = num(temp)
	return {
		id: uuid || `nvidia-${i}`,
		index: i,
		name,
		used: num(used),
		memoryUsed: mib(memUsed),
		memoryTotal: mib(memTotal),
		temperature: t == null ? null : Math.round(t),
	}
}

async function nvidiaGpus(run) {
	const out = await run('nvidia-smi', ['--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], 8_000)
	const gpus = []
	for (const line of String(out).split('\n')) {
		if (!line.trim()) continue
		const g = nvidiaGpu(line)
		if (g) gpus.push(g)
	}
	return gpus
}

const VENDOR_NVIDIA = '0x10de'
const VENDOR_AMD = '0x1002'
const VENDOR_INTEL = '0x8086'

function pciVendor(text) {
	return String(text ?? '').trim().toLowerCase()
}

function drmFallbackName(vendor, card) {
	if (vendor === VENDOR_INTEL) return 'Intel Graphics'
	if (vendor === VENDOR_AMD) return 'AMD Graphics'
	if (vendor === VENDOR_NVIDIA) return 'NVIDIA Graphics'
	return card
}

async function drmGpus(list, readText, {skipVendors = new Set()} = {}) {
	const names = await list('/sys/class/drm').catch(() => [])
	const cards = names.filter((n) => /^card\d+$/.test(n)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
	const gpus = []
	for (const card of cards) {
		const dir = `/sys/class/drm/${card}/device`
		const vendor = pciVendor(await readText(`${dir}/vendor`))
		if (skipVendors.has(vendor)) continue
		const used = num(await readText(`${dir}/gpu_busy_percent`))
		let memoryUsed = num(await readText(`${dir}/mem_info_vram_used`))
		let memoryTotal = num(await readText(`${dir}/mem_info_vram_total`))
		if (memoryTotal == null) {
			const lmemTotal = num(await readText(`${dir}/lmem_total_bytes`))
			const lmemFree = num(await readText(`${dir}/lmem_free_bytes`))
			if (lmemTotal != null) {
				memoryTotal = lmemTotal
				memoryUsed = lmemFree == null ? null : Math.max(0, lmemTotal - lmemFree)
			}
		}
		let temperature = null
		for (const hw of await list(`${dir}/hwmon`).catch(() => [])) {
			const t = num(await readText(`${dir}/hwmon/${hw}/temp1_input`))
			if (t != null) {
				temperature = Math.round(t / 1000)
				break
			}
		}
		const product = (await readText(`${dir}/product_name`)).trim()
		const name = product || drmFallbackName(vendor, card)
		if (!vendor && used == null && memoryUsed == null && memoryTotal == null && temperature == null && !product) continue
		gpus.push({id: `drm-${card}`, index: Number(card.slice(4)), name, used, memoryUsed, memoryTotal, temperature})
	}
	return gpus
}

// Each GPU we can see: NVIDIA through nvidia-smi, AMD and Intel through DRM sysfs.
// A hybrid laptop powers its NVIDIA card down when idle; nvidia-smi would wake it on every poll.
// When every NVIDIA display device is runtime-suspended, show the last reading as idle instead.
// nvidia-smi does not hide AMD/Intel cards; NVIDIA DRM nodes are skipped only while smi already listed them.
const PCI = '/sys/bus/pci/devices'
const NVIDIA_SMI_MS = 3000
let lastNvidia = null
let lastNvidiaAt = -Infinity
export function forgetGpus() {
	lastNvidia = null
	lastNvidiaAt = -Infinity
}
export async function nvidiaAsleep({list = readdir, read: readText = read} = {}) {
	let found = false
	for (const d of await list(PCI).catch(() => [])) {
		if ((await readText(`${PCI}/${d}/vendor`)).trim().toLowerCase() !== '0x10de') continue
		if (!(await readText(`${PCI}/${d}/class`)).trim().startsWith('0x03')) continue
		found = true
		if ((await readText(`${PCI}/${d}/power/runtime_status`)).trim() !== 'suspended') return false
	}
	return found
}

export async function gpuUsage({run = sh, list = readdir, read: readText = read, now = Date.now} = {}) {
	try {
		const t = now()
		let nvidia
		if (lastNvidia && (await nvidiaAsleep({list, read: readText}))) {
			nvidia = lastNvidia.map((g) => ({...g, used: 0, memoryUsed: 0, temperature: null}))
			lastNvidiaAt = -Infinity
		} else if (lastNvidia && t - lastNvidiaAt < NVIDIA_SMI_MS) {
			nvidia = lastNvidia
		} else {
			nvidia = await nvidiaGpus(run)
			lastNvidia = nvidia.length ? nvidia : null
			lastNvidiaAt = t
		}
		const skipVendors = nvidia.length ? new Set([VENDOR_NVIDIA]) : new Set()
		const others = await drmGpus(list, readText, {skipVendors})
		return {gpus: [...nvidia, ...others]}
	} catch {
		return {gpus: []}
	}
}

const POWER_SUPPLY = '/sys/class/power_supply'
const BATTERY_STATUS = {
	charging: 'charging',
	discharging: 'discharging',
	full: 'full',
	'not charging': 'not-charging',
}

// System batteries from sysfs. HID/mouse packs (scope=Device) and mains adapters are skipped.
export async function batteryUsage({list = readdir, read: readText = read} = {}) {
	try {
		const names = [...(await list(POWER_SUPPLY).catch(() => []))].sort()
		const batteries = []
		for (const id of names) {
			const dir = `${POWER_SUPPLY}/${id}`
			const type = (await readText(`${dir}/type`)).trim()
			if (!/^battery$/i.test(type)) continue
			if ((await readText(`${dir}/present`)).trim() === '0') continue
			const scope = (await readText(`${dir}/scope`)).trim()
			if (scope && /^device$/i.test(scope)) continue
			const status = BATTERY_STATUS[(await readText(`${dir}/status`)).trim().toLowerCase()] ?? 'unknown'
			const model = (await readText(`${dir}/model_name`)).trim()
			const manufacturer = (await readText(`${dir}/manufacturer`)).trim()
			const capacity = num(await readText(`${dir}/capacity`))
			let energyNow = num(await readText(`${dir}/energy_now`))
			let energyFull = num(await readText(`${dir}/energy_full`))
			let powerNow = num(await readText(`${dir}/power_now`))
			const chargeNow = num(await readText(`${dir}/charge_now`))
			const chargeFull = num(await readText(`${dir}/charge_full`))
			const currentNow = num(await readText(`${dir}/current_now`))
			const voltageNow = num(await readText(`${dir}/voltage_now`))
			if (energyNow == null && chargeNow != null && voltageNow != null) energyNow = (chargeNow * voltageNow) / 1e6
			if (energyFull == null && chargeFull != null && voltageNow != null) energyFull = (chargeFull * voltageNow) / 1e6
			if (powerNow == null && currentNow != null && voltageNow != null) powerNow = (currentNow * voltageNow) / 1e6
			let percent = capacity
			if (percent == null && energyNow != null && energyFull > 0) percent = (100 * energyNow) / energyFull
			if (percent != null) percent = Math.round(Math.max(0, Math.min(100, percent)))
			let secondsRemaining = null
			if (powerNow > 0 && energyNow != null) {
				if (status === 'discharging') secondsRemaining = Math.round((energyNow / powerNow) * 3600)
				else if (status === 'charging' && energyFull > energyNow) secondsRemaining = Math.round(((energyFull - energyNow) / powerNow) * 3600)
			}
			batteries.push({
				id,
				index: batteries.length,
				name: model || manufacturer || id,
				percent,
				status,
				secondsRemaining,
				power: powerNow == null ? null : Math.round((powerNow / 1e6) * 10) / 10,
				energyNow: energyNow == null ? null : Math.round(energyNow),
				energyFull: energyFull == null ? null : Math.round(energyFull),
			})
		}
		return {batteries}
	} catch {
		return {batteries: []}
	}
}

export function ipAddresses() {
	const out = []
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		if (/^(lo|docker|br-|veth|virbr)/.test(name)) continue
		for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
	}
	return out
}

// A short, readable name for the machine: the DMI product name, else the hostname.
export async function deviceName() {
	const vendor = (await read('/sys/class/dmi/id/sys_vendor')).trim()
	const product = (await read('/sys/class/dmi/id/product_name')).trim()
	if (product && !/to be filled|system product name|default string/i.test(product)) {
		return /qemu|kvm|virtual|vmware/i.test(`${vendor} ${product}`) ? 'Virtual machine' : product
	}
	return os.hostname()
}

export async function osRelease() {
	const lines = Object.fromEntries(
		(await read('/etc/os-release'))
			.split('\n')
			.map((l) => /^(\w+)=["']?(.*?)["']?$/.exec(l))
			.filter(Boolean)
			.map((m) => [m[1], m[2]]),
	)
	return {id: lines.ID ?? 'linux', pretty: lines.PRETTY_NAME ?? 'Linux'}
}
