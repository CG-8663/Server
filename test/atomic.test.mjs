// State files: many saves at the same moment all land, and the last one wins.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {writeAtomic} from '../omarchyd/atomic.mjs'

test('simultaneous saves never fail and leave the newest state, with no temporary files behind', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'atomic-'))
	try {
		const file = join(dir, 'state.json')
		const state = {n: 0}
		// Before 0.9.12 two saves at once shared one temporary name and one of them failed (ENOENT).
		await Promise.all(
			Array.from({length: 50}, () => {
				state.n++
				return writeAtomic(file, () => JSON.stringify(state))
			}),
		)
		assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {n: 50})
		assert.deepEqual(await readdir(dir), ['state.json'])
		// A failed write doesn't block the next one.
		await assert.rejects(writeAtomic(join(dir, 'missing', 'x.json'), '{}'))
		await writeAtomic(file, '{"ok":true}')
		assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {ok: true})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
