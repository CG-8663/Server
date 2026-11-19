import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {listHostUsb} from '../omarchyd/usb.mjs'

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
