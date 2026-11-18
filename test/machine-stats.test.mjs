// VM live stats: background virsh samples; RPCs return the last snapshot.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

const id = 'abcd1234'
const domain = `omarchy-${id}`

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

test('machines.stats without an id returns every machine’s last sample', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'mx-stats-'))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	await writeFile(
		join(dataDir, 'machines', 'machines.json'),
		JSON.stringify({
			machines: [
				{
					id,
					name: 'Box',
					state: 'running',
					cores: 2,
					sockets: 1,
					memoryMb: 2048,
					layout: {machineType: 'q35', disks: [{id: 'disk0', device: 'disk', bus: 'virtio', file: 'disk.qcow2', sizeGb: 10}]},
				},
			],
		}),
	)
	let cpuNs = 1e9
	const run = async (cmd, args) => {
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'domstats') {
			cpuNs += 2e9
			return `Domain: '${domain}'\n  cpu.time=${cpuNs}\n  balloon.rss=${64 * 1024 * 1024}\n  net.0.rx.bytes=0\n  net.0.tx.bytes=0\n  block.0.rd.bytes=0\n  block.0.wr.bytes=0\n`
		}
		if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    ${domain}   running\n`
		if (cmd === 'virsh' && a[0] === 'version') return 'Compiled against library: libvirt 10.0.0\nRunning hypervisor: QEMU 9.0.0\n'
		if (cmd === 'virsh' && a[0] === '--version') return '10.0.0\n'
		return ''
	}
	const mx = createMachines({dataDir, run, catalogUrl: 'https://example.test/catalog.json', fetchImpl: async () => new Response('{}'), statsIntervalMs: 20, seriesIntervalMs: 40})
	await mx.procedures['machines.list'].run()
	await wait(70)
	const all = await mx.procedures['machines.stats'].run()
	assert.ok(all[id], 'combined snapshot is keyed by machine id')
	assert.equal(all[id].vcpus, 2)
	assert.ok(all[id].last, 'last sample is present without waiting on virsh')
	assert.equal(typeof all[id].last.cpu, 'number')
	assert.equal(typeof all[id].last.memMb, 'number')
	const one = await mx.procedures['machines.stats'].run({id})
	assert.equal(one.last.cpu, all[id].last.cpu)
	assert.ok(Array.isArray(one.points))
})
