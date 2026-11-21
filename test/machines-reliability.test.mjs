// Reliability fixes for omarchyd machines and machine settings UI.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

async function makeEnv(t, {machines = [], run, kvm = false, files = null} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-rel-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const dataDir = join(root, 'data')
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'a'.repeat(64), sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const kvmDevice = join(root, 'kvm')
	if (kvm) await writeFile(kvmDevice, '')
	await mkdir(join(dataDir, 'machines', 'vms'), {recursive: true})
	if (machines.length) {
		await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines}, null, 2))
	}
	const open = (overrides = {}) =>
		createMachines({
			dataDir,
			catalogUrl: `file://${catalog}`,
			fetchImpl: async () => {
				throw new Error('no network in test')
			},
			run: overrides.run ?? run ?? (async () => ''),
			kvmDevice,
			files: overrides.files ?? files,
			statsIntervalMs: 60_000,
			watchIdleMs: 1,
		})
	return {root, dataDir, kvmDevice, open}
}

function makeMachineRecord(dataDir, overrides = {}) {
	const id = overrides.id ?? 'a1b2c3d4'
	const dir = join(dataDir, 'machines', 'vms', id)
	return {
		id,
		vmid: 100,
		name: 'Box',
		osId: 'testos-amd64',
		sockets: 1,
		cores: 2,
		cpuType: 'host',
		memoryMb: 1024,
		memoryGb: 1,
		diskSizeGb: 20,
		mac: '52:54:00:11:22:33',
		portForwards: [],
		createdAt: 1760000000000,
		boot: ['disk0'],
		options: {},
		cloudInit: {username: 'chris', hostname: 'box', sshKeys: []},
		layout: {
			firmware: 'bios',
			machineType: 'q35',
			nic: 'virtio',
			video: 'vga',
			disks: [
				{id: 'disk0', file: join(dir, 'disk.qcow2'), device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 20},
				{id: 'seed', role: 'seed', file: join(dir, 'seed.iso'), device: 'cdrom', bus: 'sata', format: 'raw'},
			],
		},
		...overrides,
	}
}

test('#201: port forwarding tracks ports across all machines and resets form only on success', async () => {
	const {PORT_MAX, PORT_MIN, nextFreePort, takenPorts} = await import('../web/src/machines/portForwardingState.ts')
	assert.equal(PORT_MIN, 40_000)
	assert.equal(PORT_MAX, 49_999)

	const machineA = {id: 'aaaa1111', portForwards: [{id: 'f1', protocol: 'tcp', hostPort: 42222, guestPort: 22}]}
	const machineB = {id: 'bbbb2222', portForwards: [{id: 'f2', protocol: 'tcp', hostPort: 49999, guestPort: 80}]}

	const taken = takenPorts([machineA, machineB], machineB)
	assert.equal(taken.has('tcp:42222'), true)
	assert.equal(taken.has('tcp:49999'), true)
	assert.equal(nextFreePort(42222, taken, 'tcp'), 42223)
	assert.equal(nextFreePort(49999, taken, 'tcp'), PORT_MIN)

	const src = await readFile(new URL('../web/src/machines/PortForwarding.tsx', import.meta.url), 'utf8')
	assert.match(src, /useMachines\(/)
	assert.match(src, /takenPorts\(/)
	const addBlock = src.match(/const add = \([\s\S]*?\n\t\}/)?.[0] ?? ''
	assert.match(addBlock, /onSuccess|\(\) => \{[\s\S]*setAdding\(false\)/, 'add() must close form only in onSuccess')
})

test('#208: flipping an Options switch leaves open Name and Start order editors intact', async () => {
	const src = await readFile(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')
	const block = src.match(/export function OptionsPanel[\s\S]*?\n\}\nconst bootName/)?.[0] ?? ''
	assert.ok(block.length > 0, 'OptionsPanel found')
	const flagBlock = block.match(/const flag = [\s\S]*?\n\t\)/)?.[0] ?? ''
	assert.ok(flagBlock.length > 0, 'flag helper found')
	assert.equal(/\bset\(/.test(flagBlock), false, 'flag must not call row-closing set()')
	assert.equal(/setOpen\(/.test(flagBlock), false, 'flag must not call setOpen')
	assert.match(flagBlock, /action\.mutate\(/)
	assert.match(block, /if \(open === 'name'\)\s*setName\(d\.name\)/)
	assert.match(block, /if \(open === 'order'\)/)
	assert.match(block, /set\([^\n]*'Renamed'/)
	assert.match(block, /set\([^\n]*'Start order saved'/)
})

test('#659: tasks left running when omarchyd restarted are marked error on startup', async (t) => {
	const id = 'a1b2c3d4'
	const env = await makeEnv(t, {
		run: async (cmd, args) => (cmd === 'virsh' && args.includes('list') ? ' Id   Name   State\n------------------\n' : ''),
	})
	const rec = makeMachineRecord(env.dataDir, {
		id,
		tasks: [
			{id: 't2', type: 'backup', detail: '100-box-20261120-000000', status: 'running', startedAt: 1760000002000},
			{id: 't1', type: 'start', status: 'ok', startedAt: 1760000000000, endedAt: 1760000001000},
		],
	})
	await writeFile(join(env.dataDir, 'machines', 'machines.json'), JSON.stringify({machines: [rec]}))

	const m = env.open()
	await m.ready

	const tasks = await m.procedures['machines.tasks'].run()
	const det = await m.procedures['machines.details'].run({id})
	for (const list of [tasks, det.tasks]) {
		const backupTask = list.find((x) => x.id === 't2')
		assert.equal(backupTask.status, 'error')
		assert.equal(typeof backupTask.endedAt, 'number')
		assert.equal(backupTask.message, 'Interrupted by a restart')
		const okTask = list.find((x) => x.id === 't1')
		assert.equal(okTask.status, 'ok')
		assert.equal(okTask.endedAt, 1760000001000)
	}
	const saved = JSON.parse(await readFile(join(env.dataDir, 'machines', 'machines.json'), 'utf8'))
	assert.equal(saved.machines[0].tasks.find((x) => x.id === 't2').status, 'error')
})
