import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {createHelper} from '../helper/helper.mjs'

const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}

const lsblk = {
	blockdevices: [
		{
			name: 'sdb',
			path: '/dev/sdb',
			type: 'disk',
			size: 4e12,
			children: [
				{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'zfs_member', label: 'tank', mountpoints: [null]},
			],
		},
	],
}

function fakeFs() {
	return {
		readFile: async () => {
			throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
		},
		writeFile: async () => {},
		rename: async () => {},
		mkdir: async () => {},
		chown: async () => {},
		realpath: async (p) => p,
		readdir: async () => [],
	}
}

function runWith(log, zpoolList) {
	return async (cmd, args = []) => {
		log.push([cmd, ...args])
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		if (cmd === 'zpool') {
			if (zpoolList instanceof Error) throw zpoolList
			return zpoolList
		}
		if (cmd === 'wipefs') return JSON.stringify({signatures: []})
		return ''
	}
}

function helper(log, zpoolList) {
	return createHelper({user, fs: fakeFs(), run: runWith(log, zpoolList)})
}

describe('helper zfs pool member', () => {
	test('format and umount refuse a disk in an imported ZFS pool', async () => {
		const log = []
		const h = helper(log, 'tank\n')
		await assert.rejects(h.handle('format', ['/dev/sdb', 'blank']), /\/dev\/sdb is in a pool/)
		await assert.rejects(h.handle('umount', ['/dev/sdb']), /\/dev\/sdb is in a pool/)
		assert.equal(log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), false)
	})

	test('format still wipes a zfs_member when the pool is not imported', async () => {
		const missing = []
		const gone = helper(missing, new Error('zpool: not found'))
		assert.equal(await gone.handle('format', ['/dev/sdb', 'blank']), 'ok')
		assert.ok(missing.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdb'))
		const empty = []
		const exported = helper(empty, '')
		assert.equal(await exported.handle('format', ['/dev/sdb', 'blank']), 'ok')
		assert.ok(empty.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdb'))
	})
})
