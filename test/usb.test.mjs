import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {createUsb, listHostUsb} from '../omarchyd/usb.mjs'

async function writeTree(root, files) {
	for (const [p, v] of Object.entries(files)) {
		const abs = join(root, p)
		await mkdir(dirname(abs), {recursive: true})
		if (v && typeof v === 'object' && v.link) await symlink(v.link, abs)
		else await writeFile(abs, v)
	}
}

describe('listHostUsb', () => {
	let root
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'usb-enum-'))
		await writeTree(root, {
			'sys/bus/usb/devices/usb1/bDeviceClass': '09\n',
			'sys/bus/usb/devices/1-1/idVendor': '1d6b\n',
			'sys/bus/usb/devices/1-1/idProduct': '0002\n',
			'sys/bus/usb/devices/1-1/bDeviceClass': '09\n',
			'sys/bus/usb/devices/1-2/idVendor': '10c4\n',
			'sys/bus/usb/devices/1-2/idProduct': 'ea60\n',
			'sys/bus/usb/devices/1-2/serial': '0001\n',
			'sys/bus/usb/devices/1-2/manufacturer': 'Silicon Labs\n',
			'sys/bus/usb/devices/1-2/product': 'CP210x UART Bridge\n',
			'sys/bus/usb/devices/1-2/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-2:1.0/bInterfaceClass': 'ff\n',
			'sys/bus/usb/devices/1-3/idVendor': '0781\n',
			'sys/bus/usb/devices/1-3/idProduct': '5583\n',
			'sys/bus/usb/devices/1-3/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-3:1.0/bInterfaceClass': '08\n',
			'sys/bus/usb/devices/1-4/idVendor': '046d\n',
			'sys/bus/usb/devices/1-4/idProduct': 'c31c\n',
			'sys/bus/usb/devices/1-4/bDeviceClass': '00\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceClass': '03\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceSubClass': '01\n',
			'sys/bus/usb/devices/1-4:1.0/bInterfaceProtocol': '01\n',
			'sys/bus/usb/devices/2-1/idVendor': '1a86\n',
			'sys/bus/usb/devices/2-1/idProduct': '55d4\n',
			'sys/bus/usb/devices/2-1/serial': 'a8e5c3c0\n',
			'sys/bus/usb/devices/2-1/product': 'SONOFF Zigbee 3.0 USB Dongle Plus V2\n',
			'sys/bus/usb/devices/2-1/bDeviceClass': '02\n',
			'dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0': {link: join(root, 'dev/ttyUSB0')},
			'dev/ttyUSB0': '',
			'dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0': {link: join(root, 'dev/ttyACM0')},
			'dev/ttyACM0': '',
		})
	})
	after(() => rm(root, {recursive: true, force: true}))

	const list = () =>
		listHostUsb({
			sysfs: join(root, 'sys/bus/usb/devices'),
			serialById: join(root, 'dev/serial/by-id'),
		})

	test('lists a Sonoff-style serial stick and omits hub, disk, and boot keyboard', async () => {
		const devices = await list()
		const ids = devices.map((d) => d.id)
		assert.ok(ids.includes('usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0'))
		assert.ok(ids.includes('usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0'))
		assert.equal(devices.some((d) => d.vendorId === '1d6b' || d.vendorId === '0781' || d.vendorId === '046d'), false)
	})

	test('stable id is the by-id basename; a new bus keeps the same id', async () => {
		const first = (await list()).find((d) => d.serial === '0001')
		assert.equal(first.id, 'usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0')
		assert.equal(first.vendorId, '10c4')
		assert.equal(first.productId, 'ea60')
		assert.equal(first.path, '/dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0')
		await mkdir(join(root, 'sys/bus/usb/devices/3-4'), {recursive: true})
		for (const [name, value] of [
			['idVendor', '10c4\n'],
			['idProduct', 'ea60\n'],
			['serial', '0001\n'],
			['product', 'CP210x UART Bridge\n'],
			['bDeviceClass', '00\n'],
		])
			await writeFile(join(root, 'sys/bus/usb/devices/3-4', name), value)
		await mkdir(join(root, 'sys/bus/usb/devices/3-4:1.0'), {recursive: true})
		await writeFile(join(root, 'sys/bus/usb/devices/3-4:1.0/bInterfaceClass'), 'ff\n')
		await rm(join(root, 'sys/bus/usb/devices/1-2'), {recursive: true, force: true})
		const again = (await list()).find((d) => d.serial === '0001')
		assert.equal(again.id, first.id)
	})
})

const stick = {
	id: 'usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0',
	name: 'SONOFF Zigbee 3.0 USB Dongle Plus V2',
	vendorId: '1a86',
	productId: '55d4',
	serial: 'a8e5c3c0',
	path: '/dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0',
	node: '/dev/ttyACM0',
}
const other = {
	id: 'usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0',
	name: 'CP210x UART Bridge',
	vendorId: '10c4',
	productId: 'ea60',
	serial: '0001',
	path: '/dev/serial/by-id/usb-Silicon_Labs_CP210x_UART_Bridge_0001-if00-port0',
	node: '/dev/ttyUSB0',
}

function memoryGuests() {
	const machines = [{id: 'vm1', name: 'Home', usbDevices: [], running: false, liveIds: []}]
	const apps = [{id: 'homeassistant', name: 'Home Assistant', usbDevices: [], running: false, liveIds: [], system: false}]
	const all = () => [
		...machines.map((m) => ({kind: 'machine', id: m.id, name: m.name, devices: m.usbDevices, running: m.running, liveIds: m.liveIds})),
		...apps.map((a) => ({kind: 'app', id: a.id, name: a.name, devices: a.usbDevices, running: a.running, liveIds: a.liveIds})),
	]
	const find = (kind, id) => (kind === 'machine' ? machines : apps).find((x) => x.id === id)
	return {
		machines,
		apps,
		guests: {
			bindings: all,
			bind: async (guest, rec) => {
				const g = find(guest.kind, guest.id)
				if (!g) throw new RpcError('NOT_FOUND', 'That machine doesn’t exist')
				if (g.system) throw new RpcError('PRECONDITION_FAILED', `${g.name} runs on the server itself, not in a container.`)
				if (!g.usbDevices.some((d) => d.id === rec.id)) g.usbDevices.push(rec)
			},
			unbind: async (_guest, deviceId) => {
				for (const g of [...machines, ...apps]) g.usbDevices = g.usbDevices.filter((d) => d.id !== deviceId)
			},
			liveAttach: async () => false,
			liveDetach: async () => false,
		},
	}
}

describe('createUsb attach', () => {
	test('one app may hold two sticks; a second guest is refused', async () => {
		const mem = memoryGuests()
		const usb = createUsb({enumerate: async () => [stick, other], guests: mem.guests, helper: async () => 'ok'})
		await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		await usb.procedures['usb.attach'].run({deviceId: other.id, guest: {kind: 'app', id: 'homeassistant'}})
		const listed = await usb.procedures['usb.list'].run()
		assert.equal(listed.devices.filter((d) => d.bound?.id === 'homeassistant').length, 2)
		await assert.rejects(
			usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'machine', id: 'vm1'}}),
			(e) => e instanceof RpcError && e.code === 'CONFLICT' && /Home Assistant/.test(e.message),
		)
	})

	test('already bound to this guest is a no-op; unplugged attach fails', async () => {
		const mem = memoryGuests()
		const usb = createUsb({enumerate: async () => [stick], guests: mem.guests, helper: async () => 'ok'})
		const a = await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		const b = await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'app', id: 'homeassistant'}})
		assert.equal(mem.apps[0].usbDevices.length, 1)
		assert.equal(a.needsRestart, false)
		assert.equal(b.needsRestart, false)
		await assert.rejects(
			usb.procedures['usb.attach'].run({deviceId: 'usb-missing', guest: {kind: 'app', id: 'homeassistant'}}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /Plug that stick in/.test(e.message),
		)
	})

	test('detach frees the stick; unplug does not clear the bind', async () => {
		const mem = memoryGuests()
		let plugged = [stick]
		const usb = createUsb({enumerate: async () => plugged, guests: mem.guests, helper: async () => 'ok'})
		await usb.procedures['usb.attach'].run({deviceId: stick.id, guest: {kind: 'machine', id: 'vm1'}})
		plugged = []
		const gone = await usb.procedures['usb.list'].run()
		assert.equal(gone.devices.find((d) => d.id === stick.id).bound.id, 'vm1')
		assert.equal(gone.devices.find((d) => d.id === stick.id).path, null)
		await usb.procedures['usb.detach'].run({deviceId: stick.id})
		assert.equal(mem.machines[0].usbDevices.length, 0)
		assert.equal((await usb.procedures['usb.list'].run()).devices.some((d) => d.id === stick.id), false)
	})
})

describe('usb owner-only', () => {
	let root, d, owner, member
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'usb-auth-'))
		const home = join(root, 'home')
		const data = join(root, 'data')
		await mkdir(home, {recursive: true})
		await writeTree(root, {
			'sys/bus/usb/devices/2-1/idVendor': '1a86\n',
			'sys/bus/usb/devices/2-1/idProduct': '55d4\n',
			'sys/bus/usb/devices/2-1/serial': 'a8e5c3c0\n',
			'sys/bus/usb/devices/2-1/product': 'SONOFF Zigbee 3.0 USB Dongle Plus V2\n',
			'sys/bus/usb/devices/2-1/bDeviceClass': '02\n',
			'dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_a8e5c3c0-if00-port0': {link: join(root, 'dev/ttyACM0')},
			'dev/ttyACM0': '',
		})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))
		await writeFile(join(root, 'kvm'), '')
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			usbOptions: {sysfs: join(root, 'sys/bus/usb/devices'), serialById: join(root, 'dev/serial/by-id')},
			machineOptions: {run: async () => '', kvmDevice: join(root, 'kvm')},
			appOptions: {run: async () => '', defaultStores: [], systemApps: null},
			updaterOptions: {autoCheck: false},
		})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			const body = await r.json()
			return {authorization: `Bearer ${body.result.data.accessToken}`}
		}
		owner = await login('owner')
		member = await login('member')
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (kind, path, input, headers) => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		return {status: r.status, body: await r.json()}
	}
	test('members may list USB; only the owner can attach', async () => {
		const listed = await call('query', 'usb.list', undefined, member)
		assert.equal(listed.status, 200)
		assert.ok(listed.body.result.data.devices.length >= 1)
		const attach = await call('mutation', 'usb.attach', {deviceId: stick.id, guest: {kind: 'machine', id: 'missing'}}, member)
		assert.equal(attach.status, 403)
		assert.match(attach.body.error.message, /Only the server’s owner can attach USB devices/)
		const missing = await call('mutation', 'usb.attach', {deviceId: stick.id, guest: {kind: 'machine', id: 'missing'}}, owner)
		assert.equal(missing.status, 404)
	})
})
