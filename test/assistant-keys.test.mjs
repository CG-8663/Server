import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createKeyStore} from '../omarchyd/assistant/keys.mjs'

const tmp = async () => mkdtemp(join(os.tmpdir(), 'ask-'))

test('addKey stores the secret on disk and listPublic never returns it', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir, now: () => 1_700_000_000_000})
		const row = await keys.add('owner', {name: 'My xAI', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		assert.equal(row.provider, 'spacexai')
		assert.equal(row.baseUrl, 'https://api.x.ai/v1')
		assert.equal(row.last4, 'abcd')
		assert.equal(row.mine, true)
		assert.equal(row.apiKey, undefined)
		const listed = await keys.listPublic('owner')
		assert.equal(listed.length, 1)
		assert.equal(listed[0].apiKey, undefined)
		assert.equal(listed[0].last4, 'abcd')
		const raw = JSON.parse(await readFile(join(dataDir, 'assistant', 'keys.json'), 'utf8'))
		assert.equal(raw.keys[0].apiKey, 'xai-secret-abcd')
		assert.equal((await stat(join(dataDir, 'assistant', 'keys.json'))).mode & 0o777, 0o600)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a member cannot use or list a key until it is shared or default', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add('owner', {name: 'k', provider: 'spacexai', apiKey: 'secret-key-1', model: 'grok-4.7'})
		assert.deepEqual(await keys.listPublic('sam'), [])
		await assert.rejects(() => keys.resolveForUser('sam', row.id), /isn.t/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: row.id, sharedWith: ['sam']})
		assert.equal((await keys.listPublic('sam'))[0].id, row.id)
		assert.equal((await keys.resolveForUser('sam', row.id)).apiKey, 'secret-key-1')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('only the server owner can set systemDefault, and only on a key they own', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const a = await keys.add('owner', {name: 'a', provider: 'spacexai', apiKey: 'aaaa', model: 'grok-4.7'})
		const b = await keys.add('sam', {name: 'b', provider: 'openai-compatible', apiKey: 'bbbb', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1'})
		await assert.rejects(() => keys.update({userId: 'sam', role: 'member'}, {id: b.id, systemDefault: true}), /owner/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: a.id, systemDefault: true})
		await assert.rejects(() => keys.update({userId: 'owner', role: 'owner'}, {id: b.id, systemDefault: true}), /own/)
		const second = await keys.add('owner', {name: 'c', provider: 'spacexai', apiKey: 'cccc', model: 'grok-4.7'})
		await keys.update({userId: 'owner', role: 'owner'}, {id: second.id, systemDefault: true})
		const listed = await keys.listPublic('owner')
		assert.equal(listed.find((k) => k.id === a.id).systemDefault, false)
		assert.equal(listed.find((k) => k.id === second.id).systemDefault, true)
		// Own key beats the system default. Someone with neither gets the current default.
		assert.equal((await keys.resolveForUser('sam')).id, b.id)
		assert.equal((await keys.resolveForUser('lee')).id, second.id)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
