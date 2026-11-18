import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {anthropicMessages, streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {listModels} from '../omarchyd/assistant/providers.mjs'

const SECRET = 'sk-ant-test-wxyz'
const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : null)})
const sse = (events) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		for (const e of events) yield new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	})(),
})
const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body)})
const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('anthropicMessages lifts the system prompt, turns calls into tool_use and merges results into one user turn', () => {
	const {system, messages} = anthropicMessages([
		{role: 'system', content: 'Be brief'},
		{role: 'user', content: 'disk and memory?'},
		{
			role: 'assistant',
			content: 'Looking',
			tool_calls: [
				{id: 'call_1', type: 'function', function: {name: 'system_disk', arguments: '{"path":"/"}'}},
				{id: 'call:2', type: 'function', function: {name: 'system_memory', arguments: 'not json'}},
			],
		},
		{role: 'tool', tool_call_id: 'call_1', content: 'free 10'},
		{role: 'tool', tool_call_id: 'call:2', content: 'free 4'},
		{role: 'user', content: 'thanks'},
	])
	assert.equal(system, 'Be brief')
	assert.deepEqual(messages, [
		{role: 'user', content: [{type: 'text', text: 'disk and memory?'}]},
		{
			role: 'assistant',
			content: [
				{type: 'text', text: 'Looking'},
				{type: 'tool_use', id: 'call_1', name: 'system_disk', input: {path: '/'}},
				{type: 'tool_use', id: 'call_2', name: 'system_memory', input: {}},
			],
		},
		{
			role: 'user',
			content: [
				{type: 'tool_result', tool_use_id: 'call_1', content: 'free 10'},
				{type: 'tool_result', tool_use_id: 'call_2', content: 'free 4'},
				{type: 'text', text: 'thanks'},
			],
		},
	])
})

test('streamAnthropic posts to /messages with Anthropic headers and yields text then a tool call', async () => {
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, opts, body: JSON.parse(opts.body)})
		return sse([
			{type: 'message_start', message: {id: 'msg_1'}},
			{type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
			{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Checking'}},
			{type: 'content_block_stop', index: 0},
			{type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'toolu_1', name: 'system_disk', input: {}}},
			{type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"pa'}},
			{type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: 'th":"/"}'}},
			{type: 'content_block_stop', index: 1},
			{type: 'message_delta', delta: {stop_reason: 'tool_use'}},
			{type: 'message_stop'},
		])
	}
	const tools = [{type: 'function', function: {name: 'system_disk', description: 'Disk use', parameters: {type: 'object', properties: {}}}}]
	const out = await collect(streamAnthropic({apiKey: SECRET, model: 'claude-sonnet-5-5', messages: [{role: 'system', content: 'sys'}, {role: 'user', content: 'hi'}], tools, fetchImpl}))
	assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages')
	assert.equal(seen[0].opts.headers['x-api-key'], SECRET)
	assert.equal(seen[0].opts.headers['anthropic-version'], '2023-06-01')
	assert.equal(seen[0].opts.headers.authorization, undefined)
	assert.equal(seen[0].body.system, 'sys')
	assert.equal(seen[0].body.stream, true)
	assert.ok(seen[0].body.max_tokens > 0)
	assert.deepEqual(seen[0].body.tools, [{name: 'system_disk', description: 'Disk use', input_schema: {type: 'object', properties: {}}}])
	assert.deepEqual(seen[0].body.tool_choice, {type: 'auto', disable_parallel_tool_use: true})
	assert.deepEqual(out, [
		{type: 'text', text: 'Checking'},
		{type: 'tool', id: 'toolu_1', name: 'system_disk', arguments: '{"path":"/"}'},
	])
})

test('streamAnthropic reports a rejected key, an overloaded stream and a cut-off stream as errors', async () => {
	const run = (fetchImpl) => collect(streamAnthropic({apiKey: 'k', model: 'm', messages: [], tools: [], fetchImpl}))
	assert.deepEqual(await run(async () => json(401, {type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}})), [
		{type: 'error', message: 'invalid x-api-key', status: 401},
	])
	const over = await run(async () => sse([{type: 'error', error: {type: 'overloaded_error', message: 'Overloaded'}}]))
	assert.equal(over.at(-1).message, 'Overloaded')
	const cut = await run(async () => sse([{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hal'}}]))
	assert.match(cut.at(-1).message, /cut off/)
})

test('listModels asks Anthropic with its own headers and keeps display names', async () => {
	let headers
	const models = await listModels({
		provider: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		apiKey: SECRET,
		fetchImpl: async (url, opts) => {
			headers = opts.headers
			assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1000')
			return json(200, {data: [{id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5'}]})
		},
	})
	assert.deepEqual(models, [{id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5'}])
	assert.equal(headers['x-api-key'], SECRET)
	assert.equal(headers.authorization, undefined)
})

test('an Anthropic key has a fixed address, needs a key, and its turns go to /messages', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aa-'))
	const urls = []
	const fetchImpl = async (url) => {
		urls.push(url)
		return sse([{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hello'}}, {type: 'message_stop'}])
	}
	try {
		const keys = createKeyStore({dataDir})
		await assert.rejects(() => keys.add(OWNER, {provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5-5'}), /API key/)
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, runProcedure: async () => null})
		const k = await asst.keys.add(OWNER, {provider: 'anthropic', apiKey: SECRET, model: 'claude-sonnet-5-5', baseUrl: 'http://10.0.0.5/v1'})
		assert.equal(k.baseUrl, 'https://api.anthropic.com/v1')
		assert.equal(k.name, 'Anthropic')
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(urls, ['https://api.anthropic.com/v1/messages'])
		assert.deepEqual(events.map((e) => e.event), ['text', 'done'])
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
