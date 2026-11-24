import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

test('machines.list reports hostId server when the file has none', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-vms-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [{id: 'abcd1234', name: 'Old', osId: 'debian', cores: 1, memoryGb: 1, diskSizeGb: 8, state: 'stopped'}]}))
	const m = createMachines({dataDir: data, run: async () => '', kvmDevice: join(root, 'no-kvm')})
	await m.ready
	const rows = await m.procedures['machines.list'].run()
	assert.equal(rows[0].hostId, 'server')
	const saved = JSON.parse(await readFile(join(data, 'machines', 'machines.json'), 'utf8'))
	assert.equal(saved.machines[0].hostId, 'server')
	await rm(root, {recursive: true, force: true})
})

async function waitUntil(fn, ms = 2000) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error('timed out')
}

async function readyHarness(calls, {fail} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-create-'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	const catalog = {version: 1, images: [{id: 'debian-12', familyId: 'debian', name: 'Debian', version: '12', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'ab'.repeat(32), sizeMb: 1, adminGroup: 'sudo'}]}
	const seen = []
	const machines = createMachines({
		dataDir: join(root, 'data'),
		catalogUrl: 'https://example.test/catalog.json',
		fetchImpl: async () => ({ok: true, json: async () => catalog}),
		run: async (cmd, args) => {
			seen.push([cmd, ...(args ?? [])])
			if (cmd === 'openssl') return '$6$salt$hash\n'
			if (cmd === 'virsh') throw new Error('local virsh')
			return ''
		},
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: true, allowed: {vms: true}, on: {vms: true}}],
			progress: () => ({percent: 0.5, step: 'download'}),
			call: async (id, name, args) => {
				if (name === fail) throw new Error('define failed')
				calls.push({id, name, args})
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch, threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga', 'virtio', 'none']}
				if (name === 'vm-fetch') return '/images/debian-12'
				return 'ok'
			},
		},
	})
	await machines.ready
	return {root, machines, seen, arch}
}

test('remote create stores hostId and does not define locally', async () => {
	const calls = []
	const {machines, seen, arch} = await readyHarness(calls)
	const {id} = await machines.procedures['machines.create'].run(
		{hostId: 'abc123abc123', name: 'Box', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
		{auth: {role: 'owner', userId: 'owner'}},
	)
	assert.match(id, /^[a-f0-9]{8}$/)
	await waitUntil(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state !== 'installing')
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.equal(row.hostId, 'abc123abc123')
	assert.notEqual(row.state, 'error')
	assert.ok(calls.some((c) => c.name === 'vm-fetch' && c.id === 'abc123abc123'))
	assert.ok(calls.some((c) => c.name === 'vm-define'))
	const seed = calls.find((c) => c.name === 'vm-seed')
	assert.ok(seed)
	assert.equal(JSON.stringify(seed.args).includes('qemu-guest-agent'), false)
	assert.equal(JSON.stringify(seed.args).includes('install.sh'), false)
	assert.equal(seen.some((c) => c[0] === 'virsh' && c.includes('define')), false)
})

test('remote create failure is an error row and not a local domain', async () => {
	const calls = []
	const {machines, seen} = await readyHarness(calls, {fail: 'vm-define'})
	const {id} = await machines.procedures['machines.create'].run(
		{hostId: 'abc123abc123', name: 'Bad', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
		{auth: {role: 'owner'}},
	)
	await waitUntil(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state === 'error')
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.match(row.errorMessage, /define failed/)
	assert.equal(seen.some((c) => c[0] === 'virsh'), false)
})

test('a Home ISO is refused and a member cannot create remotely', async () => {
	const calls = []
	const {machines} = await readyHarness(calls)
	await assert.rejects(
		machines.procedures['machines.create'].run({hostId: 'abc123abc123', name: 'Iso', osId: 'local:/Home/win.iso', cores: 1, memoryGb: 1, diskSizeGb: 64, username: 'chris', password: 'hunter2'}, {auth: {role: 'owner'}}),
		(e) => e.code === 'PRECONDITION_FAILED' && /ISO is on this server/.test(e.message),
	)
	await assert.rejects(
		machines.procedures['machines.create'].run({hostId: 'abc123abc123', name: 'Nope', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'}, {auth: {role: 'member'}}),
		(e) => e.code === 'FORBIDDEN',
	)
	assert.equal(calls.some((c) => c.name === 'vm-fetch'), false)
})

test('hostId server still creates locally', async () => {
	const calls = []
	const {machines, seen} = await readyHarness(calls)
	const {id} = await machines.procedures['machines.create'].run({hostId: 'server', name: 'Here', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'}, {auth: {role: 'member'}})
	assert.match(id, /^[a-f0-9]{8}$/)
	assert.equal(calls.some((c) => String(c.name).startsWith('vm-')), false)
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.equal(row.hostId, 'server')
})

test('an interrupted remote install is an error and is not resumed', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-cut-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [{id: 'abcd1234', name: 'Cut', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, state: 'installing'}]}))
	const machines = createMachines({dataDir: data, run: async () => '', kvmDevice: join(root, 'no-kvm'), connector: {pair: async () => { throw new Error('no pair') }, list: async () => [], call: async () => 'ok', progress: () => null}})
	await machines.ready
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === 'abcd1234')
	assert.equal(row.state, 'error')
	assert.equal(row.errorMessage, 'Creating it was interrupted. Delete it and create it again.')
	await rm(root, {recursive: true, force: true})
})
