import assert from 'node:assert/strict'
import {test} from 'node:test'

import {streamChat, streamResponses, takeXmlTools} from '../omarchyd/assistant/providers.mjs'

const chatSse = (chunks) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		for (const c of chunks) yield new TextEncoder().encode(`data: ${JSON.stringify(c)}\n\n`)
		yield new TextEncoder().encode('data: [DONE]\n\n')
	})(),
})

const responsesSse = (events) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		for (const e of events) yield new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	})(),
})

const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('trailing partial tag characters are kept at the end of a reply', async () => {
	assert.equal(takeXmlTools('I saw the tag <t', true).text, 'I saw the tag <t')
	assert.equal(takeXmlTools('Use <f', true).text, 'Use <f')
	assert.equal(takeXmlTools('Close with </', true).text, 'Close with </')
	assert.equal(takeXmlTools('Half <tool_call>{"name":"apps_list"', true).text, 'Half ')
	assert.equal(takeXmlTools('Half <function=apps_list>', true).text, 'Half ')

	const chatOut = await collect(streamChat({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools: [],
		fetchImpl: async () => chatSse([
			{choices: [{delta: {content: 'Write it as <h1'}}]},
			{choices: [{delta: {content: '> and then <'}}]},
		]),
	}))
	assert.equal(chatOut.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Write it as <h1> and then <')

	const respOut = await collect(streamResponses({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools: [],
		fetchImpl: async () => responsesSse([
			{type: 'response.output_text.delta', delta: 'The element is <'},
			{type: 'response.completed'},
		]),
	}))
	assert.equal(respOut.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'The element is <')
})
