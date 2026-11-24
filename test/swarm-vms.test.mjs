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
