import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {streamChat} from '../omarchyd/assistant/providers.mjs'

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

test('streamChat yields text then a whole tool call', async () => {
	const body = [
		'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
		'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"system_diskUsage","arguments":"{}"}}]}}]}\n\n',
		'data: [DONE]\n\n',
	].join('')
	const srv = http.createServer((req, res) => {
		assert.match(req.url, /\/chat\/completions$/)
		assert.equal(req.headers.authorization, 'Bearer k')
		res.writeHead(200, {'content-type': 'text/event-stream'})
		res.end(body)
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	try {
		const port = srv.address().port
		const out = []
		for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'grok-4.7', messages: [], tools: [], fetchImpl: fetch})) out.push(ev)
		assert.deepEqual(out.map((e) => e.type), ['text', 'tool'])
		assert.equal(out[0].text, 'Hi')
		assert.equal(out[1].name, 'system_diskUsage')
	} finally {
		await new Promise((r) => srv.close(r))
	}
})

test('streamChat surfaces HTTP 401 as error', async () => {
	const srv = http.createServer((_q, res) => {
		res.writeHead(401, {'content-type': 'application/json'})
		res.end(JSON.stringify({error: {message: 'Incorrect API key'}}))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	try {
		const port = srv.address().port
		const out = []
		for await (const ev of streamChat({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad', model: 'm', messages: [], tools: []})) out.push(ev)
		assert.equal(out[0].type, 'error')
		assert.match(out[0].message, /key/i)
	} finally {
		await new Promise((r) => srv.close(r))
	}
})
