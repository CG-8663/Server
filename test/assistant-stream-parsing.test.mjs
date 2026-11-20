import assert from 'node:assert/strict'
import {test} from 'node:test'

import {streamChat, streamResponses, takeXmlTools, withToolFallback, forgetTextToolModels} from '../omarchyd/assistant/providers.mjs'
import {openAiTools} from '../omarchyd/assistant/tools.mjs'

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

test('streamed XML tool calls inside <tool_call> do not leak the opening tag', async () => {
	const pieces = ['Let me check.\n\n', '<tool_call>', '\n<function=apps_list>', '\n</function>', '\n</tool_call>']
	const chatOut = await collect(streamChat({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools: [],
		fetchImpl: async () => chatSse(pieces.map((content) => ({choices: [{delta: {content}}]}))),
	}))
	assert.equal(chatOut.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Let me check.\n\n')
	assert.equal(chatOut.some((e) => e.type === 'text' && e.text.includes('<tool_call>')), false)
	assert.equal(chatOut.filter((e) => e.type === 'tool').length, 1)
	assert.equal(chatOut.find((e) => e.type === 'tool').name, 'apps_list')

	const respOut = await collect(streamResponses({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools: [],
		fetchImpl: async () => responsesSse([
			...pieces.map((delta) => ({type: 'response.output_text.delta', delta})),
			{type: 'response.completed'},
		]),
	}))
	assert.equal(respOut.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Let me check.\n\n')
	assert.equal(respOut.filter((e) => e.type === 'tool').map((e) => e.name).join(','), 'apps_list')

	const noClose = takeXmlTools('Checking.\n<tool_call>\n<function=apps_list>\n</function>', true)
	assert.equal(noClose.text, 'Checking.\n')
	assert.equal(noClose.tools.map((t) => t.name).join(','), 'apps_list')
})

test('XML tool calls preserve object, array, number and boolean argument types', async () => {
	const usbXml = '<tool_call>\n<function=usb_attach>\n<parameter=deviceId>\nusb-1\n</parameter>\n<parameter=guest>\n{"kind":"app", "id":"zigbee2mqtt"}\n</parameter>\n</function>\n</tool_call>'
	const direct = takeXmlTools(usbXml, true)
	assert.deepEqual(JSON.parse(direct.tools[0].arguments), {deviceId: 'usb-1', guest: {kind: 'app', id: 'zigbee2mqtt'}})

	const tools = [
		...openAiTools('owner'),
		{
			type: 'function',
			function: {
				name: 'demo_toggle',
				description: 'Demo',
				parameters: {type: 'object', properties: {enabled: {type: 'boolean'}, label: {type: 'string'}}},
			},
		},
	]

	const fwXml = '<tool_call>\n<function=machines_updateSettings>\n<parameter=id>\nvm-1\n</parameter>\n<parameter=portForwards>\n[{"id":"p1","protocol":"tcp","hostPort":8080,"guestPort":80}]\n</parameter>\n</function>\n</tool_call>'
	const fwOut = await collect(streamChat({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools,
		fetchImpl: async () => chatSse([{choices: [{delta: {content: fwXml}}]}]),
	}))
	assert.deepEqual(JSON.parse(fwOut.find((e) => e.type === 'tool').arguments), {
		id: 'vm-1',
		portForwards: [{id: 'p1', protocol: 'tcp', hostPort: 8080, guestPort: 80}],
	})

	// Schema-declared string fields stay strings even when their text looks like a number or boolean.
	const createXml = '<tool_call>\n<function=machines_create>\n<parameter=name>\n123\n</parameter>\n<parameter=cores>\n4\n</parameter>\n<parameter=memoryGb>\n8\n</parameter>\n</function>\n</tool_call>'
	const createOut = await collect(streamResponses({
		baseUrl: 'http://x/v1',
		apiKey: 'k',
		model: 'm',
		messages: [],
		tools,
		fetchImpl: async () => responsesSse([
			{type: 'response.output_text.delta', delta: createXml},
			{type: 'response.completed'},
		]),
	}))
	assert.deepEqual(JSON.parse(createOut.find((e) => e.type === 'tool').arguments), {name: '123', cores: 4, memoryGb: 8})

	const boolXml = '<tool_call>\n<function=demo_toggle>\n<parameter=enabled>\ntrue\n</parameter>\n<parameter=label>\ntrue\n</parameter>\n</function>\n</tool_call>'
	forgetTextToolModels()
	let calls = 0
	const fallbackOut = await collect(withToolFallback(streamChat, {
		baseUrl: 'http://127.0.0.1:11434/v1',
		apiKey: '',
		model: 'qwen-xml',
		messages: [{role: 'user', content: 'toggle'}],
		tools,
		fetchImpl: async () => {
			calls++
			if (calls === 1) return {ok: false, status: 400, text: async () => JSON.stringify({error: {message: 'does not support tools'}})}
			return chatSse([{choices: [{delta: {content: boolXml}}]}])
		},
	}))
	assert.deepEqual(JSON.parse(fallbackOut.find((e) => e.type === 'tool').arguments), {enabled: true, label: 'true'})
})
