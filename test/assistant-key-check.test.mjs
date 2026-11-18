import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {isChatModel, listModels, verifyKey} from '../omarchyd/assistant/providers.mjs'
import {ALLOWED} from '../server/app.mjs'

const SECRET = 'sk-test-secret-wxyz'
const OWNER = {userId: 'owner', role: 'owner'}
const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body)})
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? {userId: 'sam', role: 'member'} : null)})
const tmp = () => mkdtemp(join(os.tmpdir(), 'akc-'))

test('isChatModel keeps chat models and fine-tunes of them; drops embeddings, speech, images, realtime and moderation', () => {
	for (const id of ['gpt-5.5', 'o4-mini', 'gpt-4.1', 'chatgpt-4o-latest', 'chat-latest', 'gpt-6.2-sol', 'o3-pro', 'ft:gpt-4o-mini:acme::abc123']) assert.equal(isChatModel(id), true, id)
	for (const id of [
		'text-embedding-3-large', 'tts-1', 'tts-1-hd-1106', 'whisper-1', 'dall-e-3', 'gpt-image-1', 'gpt-image-2.5-flare', 'chatgpt-image-latest',
		'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-realtime-2.1-mini', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-transcribe',
		'gpt-4o-mini-tts', 'gpt-audio-mini', 'gpt-5-search-api', 'gpt-live-1', 'gpt-live-transcribe', 'ft:whisper-1:acme::x',
	]) {
		assert.equal(isChatModel(id), false, id)
	}
})

test('a custom endpoint pointed at OpenAI gets the same chat-only list; other endpoints keep everything', async () => {
	const fetchImpl = async () => json(200, {data: [{id: 'gpt-5.5'}, {id: 'tts-1'}, {id: 'gpt-image-2'}]})
	assert.deepEqual(await listModels({provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', fetchImpl}), [{id: 'gpt-5.5'}])
	assert.deepEqual((await listModels({provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', fetchImpl})).length, 3)
})

test('listModels reads /models, filters OpenAI to chat models and sorts', async () => {
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, opts})
		return json(200, {data: [{id: 'gpt-5.5'}, {id: 'text-embedding-3-small'}, {id: 'gpt-4.1'}, {id: 'gpt-4.1'}]})
	}
	const models = await listModels({provider: 'openai', baseUrl: 'https://api.openai.com/v1/', apiKey: SECRET, fetchImpl})
	assert.deepEqual(models, [{id: 'gpt-4.1'}, {id: 'gpt-5.5'}])
	assert.equal(seen[0].url, 'https://api.openai.com/v1/models')
	assert.equal(seen[0].opts.headers.authorization, `Bearer ${SECRET}`)
})

test('listModels sends no Authorization header without a key and reads Ollama-style lists', async () => {
	let headers
	const models = await listModels({
		provider: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:11434/v1',
		apiKey: '',
		fetchImpl: async (_u, opts) => {
			headers = opts.headers
			return json(200, {models: [{name: 'llama3.2'}]})
		},
	})
	assert.deepEqual(models, [{id: 'llama3.2'}])
	assert.equal(headers.authorization, undefined)
})

test('verifyKey tells a rejected key, a wrong address, an unreachable host and a missing model apart', async () => {
	const base = {provider: 'openai-compatible', baseUrl: 'http://box/v1', apiKey: 'k'}
	const rejected = await verifyKey({...base, fetchImpl: async () => json(401, {})})
	assert.equal(rejected.ok, false)
	assert.equal(rejected.status, 'rejected')
	const missing = await verifyKey({...base, fetchImpl: async () => json(404, {})})
	assert.equal(missing.status, 'no-list')
	assert.match(missing.message, /\/v1/)
	const down = await verifyKey({
		...base,
		fetchImpl: async () => {
			throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
		},
	})
	assert.equal(down.status, 'unreachable')
	assert.match(down.message, /ECONNREFUSED/)
	const list = async () => json(200, {data: [{id: 'a'}, {id: 'b'}]})
	const typo = await verifyKey({...base, model: 'c', fetchImpl: list})
	assert.equal(typo.status, 'no-model')
	assert.equal(typo.modelFound, false)
	const good = await verifyKey({...base, model: 'b', fetchImpl: list})
	assert.equal(good.ok, true)
	assert.equal(good.modelFound, true)
	assert.match(good.message, /2 models/)
})

test('a recorded check shows on the key and clears when the model or key changes', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir, now: () => 7})
		const k = await keys.add(OWNER, {provider: 'openai', apiKey: SECRET, model: 'gpt-5.5'})
		assert.equal(k.check, null)
		await keys.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})
		const [listed] = await keys.listPublic('owner')
		assert.deepEqual(listed.check, {ok: true, status: 'ok', message: 'Connected', at: 7})
		assert.equal(listed.apiKey, undefined)
		assert.ok((await keys.update(OWNER, {id: k.id, model: 'gpt-5.5'})).check)
		assert.equal((await keys.update(OWNER, {id: k.id, model: 'gpt-4.1'})).check, null)
		await keys.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})
		assert.equal((await keys.update(OWNER, {id: k.id, apiKey: 'sk-another-key'})).check, null)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('assistant.verifyKey checks a saved key on the server and records it; the secret never comes back', async () => {
	const dataDir = await tmp()
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, opts})
		return json(200, {data: [{id: 'gpt-5.5'}]})
	}
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 9, fetchImpl})
		const k = await asst.keys.add(OWNER, {provider: 'openai', apiKey: SECRET, model: 'gpt-5.5'})
		const r = await asst.procedures['assistant.verifyKey'].run({id: k.id}, {auth: {userId: 'owner'}})
		assert.equal(r.ok, true)
		assert.equal(r.modelFound, true)
		assert.deepEqual(r.models, [{id: 'gpt-5.5'}])
		assert.equal(JSON.stringify(r).includes(SECRET), false)
		assert.equal(seen[0].url, 'https://api.openai.com/v1/models')
		assert.equal(seen[0].opts.headers.authorization, `Bearer ${SECRET}`)
		const [listed] = await asst.keys.listPublic('owner')
		assert.equal(listed.check.ok, true)
		await assert.rejects(() => asst.procedures['assistant.verifyKey'].run({id: k.id}, {auth: {userId: 'sam'}}), /isn.t available/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('checking typed-in details: presets use their own address, and only the owner may check a custom one', async () => {
	const dataDir = await tmp()
	const urls = []
	const fetchImpl = async (url) => {
		urls.push(url)
		return json(200, {data: [{id: 'm'}]})
	}
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 9, fetchImpl})
		const run = (input, userId) => asst.procedures['assistant.verifyKey'].run(input, {auth: {userId}})
		await run({provider: 'openai', apiKey: SECRET, baseUrl: 'http://10.0.0.5/v1'}, 'sam')
		assert.equal(urls.at(-1), 'https://api.openai.com/v1/models')
		await assert.rejects(() => run({provider: 'openai-compatible', baseUrl: 'http://10.0.0.5:8080'}, 'sam'), /owner/)
		assert.equal(urls.length, 1)
		const ok = await run({provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234'}, 'owner')
		assert.equal(ok.ok, true)
		assert.equal(urls.at(-1), 'http://127.0.0.1:1234/v1/models')
		await assert.rejects(() => run({provider: 'openai-compatible', baseUrl: 'ftp://x'}, 'owner'), /base URL/)
		await assert.rejects(() => run({provider: 'nope'}, 'owner'), /Choose a provider/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a key the provider rejects mid-chat is marked in Settings', async () => {
	const dataDir = await tmp()
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, runProcedure: async () => null, fetchImpl: async () => json(401, {error: {message: 'nope'}})})
		await asst.keys.add(OWNER, {provider: 'openai', apiKey: SECRET, model: 'gpt-5.5'})
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: () => {}})
		const [listed] = await asst.keys.listPublic('owner')
		assert.equal(listed.check.ok, false)
		assert.equal(listed.check.status, 'rejected')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('the web server lets assistant.verifyKey through', () => {
	assert.equal(ALLOWED['assistant.verifyKey'], 'mutation')
})
