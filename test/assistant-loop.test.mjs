import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'

test('a user cannot read another user’s conversation', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ac-'))
	try {
		const c = createConversations({dataDir, now: () => 1})
		const row = await c.create('owner', {keyId: 'k_1', title: 'Need a VM'})
		assert.equal(row.title, 'Need a VM')
		await assert.rejects(() => c.get('sam', row.id), /isn.t/)
		await c.append('owner', row.id, {role: 'user', content: 'hello', at: 1})
		const loaded = await c.get('owner', row.id)
		assert.equal(loaded.messages[0].content, 'hello')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
