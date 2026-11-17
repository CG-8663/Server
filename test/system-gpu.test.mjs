// GPU list for the system page: NVIDIA through nvidia-smi, AMD through sysfs. No root needed.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {gpuUsage} from '../omarchyd/system.mjs'

const nvidiaCsv = `0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39
1, NVIDIA GeForce RTX 3060, GPU-bbb, 0, 2, 12288, 36
`

const runNvidia = async (cmd) => (cmd === 'nvidia-smi' ? nvidiaCsv : '')

test('nvidia-smi: one entry per GPU with utilization, VRAM and temperature', async () => {
	const {gpus} = await gpuUsage({run: runNvidia, list: async () => [], read: async () => ''})
	assert.equal(gpus.length, 2)
	assert.deepEqual(gpus[0], {
		id: 'GPU-aaa',
		index: 0,
		name: 'NVIDIA GeForce RTX 3060',
		used: 32,
		memoryUsed: 1477 * 1024 * 1024,
		memoryTotal: 12288 * 1024 * 1024,
		temperature: 39,
	})
	assert.equal(gpus[1].id, 'GPU-bbb')
	assert.equal(gpus[1].index, 1)
	assert.equal(gpus[1].used, 0)
	assert.equal(gpus[1].memoryUsed, 2 * 1024 * 1024)
	assert.equal(gpus[1].temperature, 36)
})

test('nvidia-smi: [N/A] readings are null, the GPU still appears', async () => {
	const csv = '0, NVIDIA GeForce RTX 3060, GPU-aaa, [N/A], [N/A], 12288, [N/A]\n'
	const {gpus} = await gpuUsage({run: async (cmd) => (cmd === 'nvidia-smi' ? csv : ''), list: async () => [], read: async () => ''})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].used, null)
	assert.equal(gpus[0].memoryUsed, null)
	assert.equal(gpus[0].memoryTotal, 12288 * 1024 * 1024)
	assert.equal(gpus[0].temperature, null)
})

test('no GPUs: empty list, not an error', async () => {
	const {gpus} = await gpuUsage({run: async () => '', list: async () => [], read: async () => ''})
	assert.deepEqual(gpus, [])
})

test('nvidia-smi missing: AMD cards from sysfs, connectors skipped', async () => {
	const files = {
		'/sys/class/drm/card0/device/gpu_busy_percent': '41\n',
		'/sys/class/drm/card0/device/mem_info_vram_used': String(3 * 1024 ** 3),
		'/sys/class/drm/card0/device/mem_info_vram_total': String(16 * 1024 ** 3),
		'/sys/class/drm/card0/device/hwmon/hwmon5/temp1_input': '62000\n',
		'/sys/class/drm/card0/device/product_name': 'AMD Radeon RX 7900 XTX\n',
	}
	const {gpus} = await gpuUsage({
		run: async () => '',
		list: async (dir) => {
			if (dir === '/sys/class/drm') return ['card0', 'card0-DP-1', 'renderD128', 'card1']
			if (dir === '/sys/class/drm/card0/device/hwmon') return ['hwmon5']
			if (dir === '/sys/class/drm/card1/device/hwmon') return []
			return []
		},
		read: async (p) => files[p] ?? '',
	})
	assert.equal(gpus.length, 1)
	assert.equal(gpus[0].id, 'drm-card0')
	assert.equal(gpus[0].index, 0)
	assert.equal(gpus[0].name, 'AMD Radeon RX 7900 XTX')
	assert.equal(gpus[0].used, 41)
	assert.equal(gpus[0].memoryUsed, 3 * 1024 ** 3)
	assert.equal(gpus[0].memoryTotal, 16 * 1024 ** 3)
	assert.equal(gpus[0].temperature, 62)
})

test('nvidia-smi wins when both NVIDIA and sysfs cards exist', async () => {
	const {gpus} = await gpuUsage({
		run: runNvidia,
		list: async (dir) => (dir === '/sys/class/drm' ? ['card0'] : []),
		read: async (p) => (p.endsWith('gpu_busy_percent') ? '99\n' : ''),
	})
	assert.equal(gpus.length, 2)
	assert.equal(gpus[0].id, 'GPU-aaa')
})
