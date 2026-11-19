// Host USB enumerator and passthrough RPCs for omarchyd.
import {readdir as fsReaddir, readFile as fsReadFile, realpath as fsRealpath} from 'node:fs/promises'
import {join} from 'node:path'

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

export function createUsb({enumerate = listHostUsb, guests = {bindings: () => []}, helper = async () => 'ok'} = {}) {
	return {
		procedures: {
			'usb.list': {
				kind: 'query',
				run: async () => {
					const host = await enumerate()
					await guests.bindings()
					return {devices: host.map((h) => ({...h, bound: null, needsRestart: false}))}
				},
			},
			'usb.attach': {kind: 'mutation', run: async () => {
				throw new RpcError('NOT_FOUND', 'That stick isn’t plugged in')
			}},
			'usb.detach': {kind: 'mutation', run: async () => {
				throw new RpcError('NOT_FOUND', 'That stick isn’t plugged in')
			}},
		},
	}
}
