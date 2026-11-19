// Host USB enumerator and passthrough RPCs for omarchyd.
import {readdir as fsReaddir, readFile as fsReadFile, realpath as fsRealpath} from 'node:fs/promises'
import {join} from 'node:path'
import YAML from 'yaml'

import {RpcError} from './rpc.mjs'

const USB_DEV = /^[0-9]+-[0-9.]+$/

const hex = (s, n) => {
	const t = String(s ?? '').trim().toLowerCase()
	return t ? t.padStart(n, '0').slice(-n) : ''
}

async function isExcluded(sysfs, name, read, readdir) {
	const dir = join(sysfs, name)
	const deviceClass = hex(await read(join(dir, 'bDeviceClass')), 2)
	if (deviceClass === '09' || deviceClass === '08') return true
	const names = await readdir(sysfs).catch(() => [])
	const kids = await readdir(dir).catch(() => [])
	const ifaceDirs = [
		...names.filter((n) => n.startsWith(`${name}:`)).map((n) => join(sysfs, n)),
		...kids.filter((k) => k.includes(':')).map((k) => join(dir, k)),
	]
	for (const iface of ifaceDirs) {
		const cls = hex(await read(join(iface, 'bInterfaceClass')), 2)
		if (cls === '08' || cls === '09') return true
		const sub = hex(await read(join(iface, 'bInterfaceSubClass')), 2)
		const proto = hex(await read(join(iface, 'bInterfaceProtocol')), 2)
		if (cls === '03' && sub === '01' && (proto === '01' || proto === '02')) return true
	}
	return false
}

export async function listHostUsb({
	readdir = fsReaddir,
	readFile = fsReadFile,
	realpath = fsRealpath,
	sysfs = '/sys/bus/usb/devices',
	serialById = '/dev/serial/by-id',
} = {}) {
	const read = (p) => readFile(p, 'utf8').catch(() => '')
	const names = await readdir(sysfs).catch(() => [])
	const devices = []
	for (const name of names) {
		if (!USB_DEV.test(name)) continue
		if (await isExcluded(sysfs, name, read, readdir)) continue
		const dir = join(sysfs, name)
		const vendorId = hex(await read(join(dir, 'idVendor')), 4)
		const productId = hex(await read(join(dir, 'idProduct')), 4)
		if (!vendorId || !productId) continue
		const serial = (await read(join(dir, 'serial'))).trim() || null
		const manufacturer = (await read(join(dir, 'manufacturer'))).trim()
		const product = (await read(join(dir, 'product'))).trim()
		devices.push({
			vendorId,
			productId,
			serial,
			name: product || [manufacturer, product].filter(Boolean).join(' ') || `${vendorId}:${productId}`,
			path: null,
			node: null,
			id: null,
		})
	}
	const links = await readdir(serialById).catch(() => [])
	for (const link of links) {
		if (!link.startsWith('usb-')) continue
		const target = await realpath(join(serialById, link)).catch(() => null)
		const match = devices.find((d) => d.serial && link.includes(d.serial)) || devices.find((d) => link.toLowerCase().includes(`${d.vendorId}_${d.productId}`))
		if (!match) continue
		match.path = `/dev/serial/by-id/${link}`
		match.node = target
		match.id = link
	}
	return devices.map((d) => ({
		...d,
		id: d.id || (d.serial ? `${d.vendorId}-${d.productId}-${d.serial}` : `${d.vendorId}-${d.productId}`),
	}))
}

const USB_SERIAL = /^[A-Za-z0-9._-]{1,128}$/
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c])

export function hostdevXml({vendorId, productId, serial}) {
	const ser = serial && USB_SERIAL.test(serial) ? `<serial>${xml(serial)}</serial>` : ''
	return `<hostdev mode='subsystem' type='usb' managed='yes'><source><vendor id='0x${vendorId}'/><product id='0x${productId}'/>${ser}</source></hostdev>`
}

export function parseUsbLive(xmlText, devices = []) {
	const live = []
	for (const d of devices) {
		const vendor = new RegExp(`<vendor id='0x${d.vendorId}'\\s*/>`)
		const product = new RegExp(`<product id='0x${d.productId}'\\s*/>`)
		if (vendor.test(xmlText) && product.test(xmlText)) live.push(d.id)
	}
	return live
}

const SERIAL_PATH = /^\/dev\/(serial\/by-id\/usb-[A-Za-z0-9._+-]+|ttyUSB[0-9]+|ttyACM[0-9]+)$/

export function usbComposeOverlay(serviceNames, devices) {
	const binds = (devices ?? []).map((d) => d.path).filter((p) => SERIAL_PATH.test(p)).map((p) => `${p}:${p}`)
	if (!binds.length) return ''
	const services = Object.fromEntries(serviceNames.map((name) => [name, {devices: binds}]))
	return YAML.stringify({services})
}

function boundOf(g) {
	return {kind: g.kind, id: g.id, name: g.name}
}

function decorate(h, g) {
	return {
		...h,
		bound: g ? boundOf(g) : null,
		needsRestart: !!(g?.running && !(g.liveIds ?? []).includes(h.id)),
	}
}

export function createUsb({enumerate = listHostUsb, guests = {bindings: () => []}, helper = async () => 'ok'} = {}) {
	const liveAttach = guests.liveAttach ?? (async () => false)
	const liveDetach = guests.liveDetach ?? (async () => false)
	async function list() {
		const host = await enumerate()
		const bindings = await guests.bindings()
		const byDevice = new Map()
		for (const g of bindings) for (const d of g.devices ?? []) byDevice.set(d.id, g)
		const seen = new Set()
		const devices = []
		for (const h of host) {
			seen.add(h.id)
			devices.push(decorate(h, byDevice.get(h.id)))
		}
		for (const g of bindings) {
			for (const d of g.devices ?? []) {
				if (seen.has(d.id)) continue
				seen.add(d.id)
				devices.push(decorate({id: d.id, name: d.name ?? d.id, vendorId: d.vendorId ?? '', productId: d.productId ?? '', serial: d.serial ?? null, path: null, node: null}, g))
			}
		}
		return {devices}
	}
	async function attach(input) {
		const deviceId = String(input?.deviceId ?? '')
		if (!deviceId) throw new RpcError('BAD_REQUEST', 'Choose a USB device')
		const kind = input?.guest?.kind
		const id = String(input?.guest?.id ?? '')
		if ((kind !== 'machine' && kind !== 'app') || !id) throw new RpcError('BAD_REQUEST', 'Choose a machine or an app')
		const rec = (await enumerate()).find((d) => d.id === deviceId)
		if (!rec) throw new RpcError('PRECONDITION_FAILED', 'Plug that stick in, then try again')
		const bindings = await guests.bindings()
		const current = bindings.find((g) => (g.devices ?? []).some((d) => d.id === deviceId))
		if (current && current.kind === kind && current.id === id) return {needsRestart: false}
		if (current) throw new RpcError('CONFLICT', `That stick is already used by ${current.name}`)
		const guest = {kind, id}
		await guests.bind(guest, {id: rec.id, vendorId: rec.vendorId, productId: rec.productId, serial: rec.serial, path: rec.path, name: rec.name})
		const after = (await guests.bindings()).find((g) => g.kind === kind && g.id === id)
		const running = !!after?.running
		const liveResult = running ? await liveAttach(guest, rec) : true
		const live = liveResult === true
		if (rec.serial && USB_SERIAL.test(rec.serial)) await helper('usb-allow', [rec.serial]).catch(() => {})
		const needsRestart = running && !live
		const qemu = typeof liveResult === 'string' ? liveResult : ''
		return {needsRestart, ...(needsRestart ? {message: `Restart ${after.name} to use this stick.${qemu ? ` ${qemu}` : ''}`} : {})}
	}
	async function detach(input) {
		const deviceId = String(input?.deviceId ?? '')
		if (!deviceId) throw new RpcError('BAD_REQUEST', 'Choose a USB device')
		const bindings = await guests.bindings()
		const current = bindings.find((g) => (g.devices ?? []).some((d) => d.id === deviceId))
		if (!current) return {needsRestart: false}
		const rec = current.devices.find((d) => d.id === deviceId)
		const guest = {kind: current.kind, id: current.id}
		const running = !!current.running
		const live = running ? await liveDetach(guest, rec) : false
		await guests.unbind(guest, deviceId)
		const leftover = (await guests.bindings()).some((g) => (g.devices ?? []).some((d) => d.serial && d.serial === rec.serial))
		if (rec.serial && USB_SERIAL.test(rec.serial) && !leftover) await helper('usb-forget', [rec.serial]).catch(() => {})
		const needsRestart = running && !live
		return {needsRestart, ...(needsRestart ? {message: `Restart ${current.name} to apply`} : {})}
	}
	return {
		procedures: {
			'usb.list': {kind: 'query', run: list},
			'usb.attach': {kind: 'mutation', run: attach},
			'usb.detach': {kind: 'mutation', run: detach},
		},
	}
}
