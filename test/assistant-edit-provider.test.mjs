import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const SAM = {userId: 'sam', role: 'member'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? SAM : null)})
const json = (status, body) => ({ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body)})

async function setup() {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aep-'))
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, auth: opts.headers.authorization})
		return json(200, {data: [{id: 'm'}]})
	}
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 5, fetchImpl})
	const verify = (input, userId = 'owner') => asst.procedures['assistant.verifyKey'].run(input, {auth: {userId}})
	return {dataDir, seen, asst, verify}
}

test('editing a key checks a newly typed key with the saved address, and records nothing until it is saved', async () => {
	const {dataDir, seen, asst, verify} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai', apiKey: 'sk-old-key', model: 'm'})
		const r = await verify({id: k.id, apiKey: 'sk-new-key'})
		assert.equal(r.ok, true)
		assert.equal(seen.at(-1).url, 'https://api.openai.com/v1/models')
		assert.equal(seen.at(-1).auth, 'Bearer sk-new-key')
		const [listed] = await asst.keys.listPublic('owner')
		assert.equal(listed.check, null, 'a check of unsaved details is not recorded')
		// A preset's address can't be changed by checking.
		await verify({id: k.id, apiKey: 'sk-new-key', baseUrl: 'http://10.0.0.9/v1'})
		assert.equal(seen.at(-1).url, 'https://api.openai.com/v1/models')
		// The saved key is used when none is typed, and that check is recorded.
		await verify({id: k.id, apiKey: '  '})
		assert.equal(seen.at(-1).auth, 'Bearer sk-old-key')
		assert.equal((await asst.keys.listPublic('owner'))[0].check.ok, true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a custom endpoint’s new address is checked with its saved key; only the owner may, and only the key’s owner may try new details', async () => {
	const {dataDir, seen, asst, verify} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: 'local-key', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1'})
		await verify({id: k.id, baseUrl: 'http://127.0.0.1:8000'})
		assert.equal(seen.at(-1).url, 'http://127.0.0.1:8000/v1/models')
		assert.equal(seen.at(-1).auth, 'Bearer local-key')
		await assert.rejects(() => verify({id: k.id, baseUrl: 'ftp://x'}), /base URL/)
		await asst.keys.update(OWNER, {id: k.id, sharedWith: ['sam']})
		const before = seen.length
		await assert.rejects(() => verify({id: k.id, apiKey: 'sam-key'}, 'sam'), /Only the person who added/)
		await assert.rejects(() => verify({id: k.id, baseUrl: 'http://10.0.0.5'}, 'sam'), /Only the person who added/)
		assert.equal(seen.length, before)
		// Sam can still check the shared key as it is.
		assert.equal((await verify({id: k.id}, 'sam')).ok, true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('saving an edit changes the name, key and address together and clears the old check', async () => {
	const {dataDir, asst} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: '', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1'})
		await asst.keys.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})
		const out = await asst.procedures['assistant.updateKey'].run({id: k.id, name: 'Workstation', apiKey: 'tok-1234', baseUrl: 'http://127.0.0.1:8000'}, {auth: {userId: 'owner'}})
		assert.equal(out.name, 'Workstation')
		assert.equal(out.last4, '1234')
		assert.equal(out.baseUrl, 'http://127.0.0.1:8000/v1')
		assert.equal(out.check, null)
		assert.equal(out.apiKey, undefined)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
