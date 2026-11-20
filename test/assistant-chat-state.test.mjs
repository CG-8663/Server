import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createKeyStore} from '../omarchyd/assistant/keys.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const tmp = () => mkdtemp(join(os.tmpdir(), 'acs-state-'))

test('a rejected API key update leaves the key and other defaults untouched in memory and on disk', async () => {
	const dataDir = await tmp()
	try {
		const ks = createKeyStore({dataDir, now: () => 10})
		const first = await ks.add(OWNER, {provider: 'openai', apiKey: 'sk-first-1111', model: 'gpt-first', name: 'First'})
		await ks.update(OWNER, {id: first.id, systemDefault: true})
		const k = await ks.add(OWNER, {provider: 'openai', apiKey: 'sk-abcdef1234', model: 'gpt-a', name: 'Old'})
		await ks.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})

		await assert.rejects(
			() => ks.update(OWNER, {id: k.id, name: 'New name', model: 'gpt-b', systemDefault: true, apiKey: 'abc'}),
			/Enter an API key/,
		)
		const listed = await ks.listPublic('owner')
		const current = listed.find((x) => x.id === k.id)
		assert.equal(current.name, 'Old')
		assert.equal(current.model, 'gpt-a')
		assert.equal(current.systemDefault, false)
		assert.equal(current.check?.ok, true)
		assert.equal(listed.find((x) => x.id === first.id).systemDefault, true)

		// An unrelated edit afterwards must not save anything from the rejected update.
		await ks.update(OWNER, {id: k.id, effort: 'high'})
		const reloaded = (await createKeyStore({dataDir}).listPublic('owner')).find((x) => x.id === k.id)
		assert.equal(reloaded.name, 'Old')
		assert.equal(reloaded.model, 'gpt-a')
		assert.equal(reloaded.effort, 'high')
		assert.equal(reloaded.systemDefault, false)
		assert.equal(reloaded.check?.ok, true)

		// Non-owner trying to change a custom endpoint along with name/model also changes nothing.
		const custom = await ks.add({userId: 'pat', role: 'owner'}, {
			provider: 'openai-compatible',
			apiKey: '',
			model: 'llama-a',
			name: 'Local',
			baseUrl: 'http://127.0.0.1:11434/v1',
		})
		await assert.rejects(
			() => ks.update({userId: 'pat', role: 'member'}, {id: custom.id, name: 'Changed', model: 'llama-b', baseUrl: 'http://10.0.0.5/v1'}),
			/Only the server’s owner can change a custom endpoint/,
		)
		const customAfter = (await ks.listPublic('pat')).find((x) => x.id === custom.id)
		assert.equal(customAfter.name, 'Local')
		assert.equal(customAfter.model, 'llama-a')
		assert.equal(customAfter.baseUrl, 'http://127.0.0.1:11434/v1')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
