import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {createAssistant} from '../omarchyd/assistant.mjs'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {SYSTEM_PROMPT} from '../omarchyd/assistant/loop.mjs'
import {streamChat} from '../omarchyd/assistant/providers.mjs'
import {READ_TOOLS, WRITE_TOOLS, filterAppStore, toolsFor} from '../omarchyd/assistant/tools.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ALLOWED} from '../server/app.mjs'

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

const SECRET = 'xai-secret-abcd'
const LIMIT = 'I hit the lookup limit for this turn.'
const KEY_REJECTED = 'That API key was rejected. Replace it in Settings → Assistant.'

const fakeAccounts = () => ({
	getUser(userId) {
		if (userId === 'sam') return {userId, role: 'member'}
		if (userId === 'owner') return {userId, role: 'owner'}
		return null
	},
})

const sse = (text) => ({
	ok: true,
	status: 200,
	text: async () => text,
	body: (async function* () {
		yield text
	})(),
})

const toolSse = (id, name, args = '{}') => sse(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id, function: {name, arguments: args}}]}}]})}\n\ndata: [DONE]\n\n`)
const textSse = (text) => sse(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)

function scripted(responses) {
	const seen = []
	const fetchImpl = async (url, opts) => {
		const body = JSON.parse(opts.body)
		seen.push({url, opts, body})
		const step = responses[Math.min(seen.length - 1, responses.length - 1)]
		return typeof step === 'function' ? step(body) : step
	}
	return {seen, fetchImpl}
}

async function withAssistant(opts) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 50, ...opts})
	const key = await asst.keys.add('owner', {name: 'k', provider: 'spacexai', apiKey: SECRET, model: 'grok-4.7'})
	return {
		dataDir,
		asst,
		key,
		async close() {
			await rm(dataDir, {recursive: true, force: true})
		},
	}
}

function factsProcedure(extra) {
	const calls = []
	const runProcedure = async (name, input, auth) => {
		calls.push({name, input, auth})
		if (extra) {
			const out = await extra(name, input, auth, calls)
			if (out !== undefined) return out
		}
		if (name === 'system.getHostname') return 'box'
		if (name === 'system.device') return {device: 'ThinkPad', os: 'Omarchy'}
		if (name === 'apps.list') return [{id: 'files', credentials: {defaultPassword: 'app-secret'}}]
		if (name === 'swarm.list') return [{name: 'nas'}]
		return null
	}
	return {calls, runProcedure}
}

test('read tools are the curated list and members do not get swarm_list', () => {
	assert.deepEqual(READ_TOOLS.map((t) => t.name), [
		'system_diskUsage',
		'system_cpuUsage',
		'system_memoryUsage',
		'system_gpuUsage',
		'system_cpuTemperature',
		'system_uptime',
		'system_device',
		'system_getHostname',
		'system_getIpAddresses',
		'apps_list',
		'appStore_app',
		'appStore_search',
		'machines_list',
		'machines_details',
		'machines_osImages',
		'machines_capabilities',
		'swarm_list',
		'omarchy_plugins',
		'notifications_get',
	])
	assert.deepEqual(READ_TOOLS.find((t) => t.name === 'system_diskUsage'), {
		name: 'system_diskUsage',
		rpc: 'system.diskUsage',
		description: 'Disk used and free on this server',
		parameters: {type: 'object', properties: {}},
		ownerOnly: false,
	})
	assert.equal(READ_TOOLS.find((t) => t.name === 'swarm_list').ownerOnly, true)
	assert.equal(READ_TOOLS.find((t) => t.name === 'swarm_list').rpc, 'swarm.list')
	assert.equal(READ_TOOLS.find((t) => t.name === 'appStore_app').parameters.properties.appId.type, 'string')
	assert.equal(READ_TOOLS.find((t) => t.name === 'machines_details').parameters.properties.id.type, 'string')
	assert.ok(READ_TOOLS.find((t) => t.name === 'omarchy_plugins').parameters.properties.q)
	assert.ok(READ_TOOLS.find((t) => t.name === 'appStore_search').parameters.properties.limit)
	assert.equal(toolsFor('member').some((t) => t.name === 'swarm_list'), false)
	assert.equal(toolsFor('owner').some((t) => t.name === 'swarm_list'), true)
	assert.equal([...READ_TOOLS, ...WRITE_TOOLS].some((t) => /shell|podman|web_search|x_search/i.test(t.name)), false)
	assert.equal(WRITE_TOOLS.some((t) => t.name === 'apps_install'), true)
})

test('appStore_search keeps a short listing, not the registry dump', () => {
	const apps = Array.from({length: 30}, (_, i) => ({
		id: `a${i}`,
		name: `App ${i}`,
		tagline: 't',
		category: i % 2 ? 'media' : 'files',
		version: '1',
		icon: 'nope',
		compose: 'secret-compose',
	}))
	const registry = [{url: 'https://example.invalid/store', apps}]
	const defaults = filterAppStore(registry, {})
	assert.equal(defaults.length, 12)
	assert.deepEqual(Object.keys(defaults[0]).sort(), ['category', 'id', 'name', 'tagline', 'version'])
	assert.equal(defaults[0].icon, undefined)
	assert.equal(filterAppStore(registry, {limit: 100}).length, 24)
	assert.deepEqual(filterAppStore(registry, {q: 'app 4', category: 'files'}).map((a) => a.id), ['a4'])
	assert.equal(JSON.stringify(defaults).includes('secret-compose'), false)
})

test('runTurn runs a read tool then streams the reply', async () => {
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') return {free: '12 GB'}
	})
	const {seen, fetchImpl} = scripted([toolSse('call_1', 'system_diskUsage', '{}'), textSse('12 GB free')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'how much disk', emit: (e) => events.push(e)})
		assert.equal(calls.some((c) => c.name === 'system.diskUsage'), true)
		const disk = calls.find((c) => c.name === 'system.diskUsage')
		assert.deepEqual(disk.input, {})
		assert.equal(disk.auth.userId, 'owner')
		assert.equal(disk.auth.role, 'owner')
		const visible = events.filter((e) => e.event === 'text' || e.event === 'done')
		assert.deepEqual(visible.map((e) => e.event), ['text', 'done'])
		assert.equal(visible[0].data.text, '12 GB free')
		assert.equal(visible[1].data.conversationId, out.conversationId)
		assert.equal(JSON.stringify(events).includes(SECRET), false)
		const first = seen[0]
		const second = seen[1]
		assert.match(first.url, /\/chat\/completions$/)
		assert.equal(first.opts.headers.authorization, `Bearer ${SECRET}`)
		assert.equal(first.body.stream, true)
		assert.equal(first.body.parallel_tool_calls, false)
		assert.equal(first.body.messages[0].content.startsWith(`${SYSTEM_PROMPT}\n`), true)
		assert.match(first.body.messages[0].content, /Role: owner/)
		assert.match(first.body.messages[0].content, /Hostname: box/)
		assert.match(first.body.messages[0].content, /Device: ThinkPad \(Omarchy\)/)
		assert.match(first.body.messages[0].content, /Installed apps: files/)
		assert.match(first.body.messages[0].content, /Swarm: nas/)
		assert.equal(first.body.messages[0].content.includes('app-secret'), false)
		assert.equal(first.body.tools.some((t) => t.function.name === 'system_diskUsage'), true)
		assert.equal(first.body.tools.some((t) => t.function.name === 'swarm_list'), true)
		assert.equal(JSON.stringify(first.body.messages).includes(SECRET), false)
		const tool = second.body.messages.find((m) => m.role === 'tool')
		const call = second.body.messages.find((m) => m.tool_calls)
		assert.equal(tool.tool_call_id, 'call_1')
		assert.match(tool.content, /12 GB/)
		assert.equal(call.tool_calls[0].id, 'call_1')
		assert.equal(call.tool_calls[0].function.name, 'system_diskUsage')
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.title, 'how much disk')
		assert.equal(saved.messages.at(-1).content, '12 GB free')
		assert.equal(saved.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_1'), true)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes(SECRET), false)
	} finally {
		await box.close()
	}
})

test('a member tool list omits swarm_list and swarm is not loaded', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([textSse('hello')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.keys.update({userId: 'owner', role: 'owner'}, {id: box.key.id, sharedWith: ['sam']})
		const events = []
		await box.asst.runTurn({userId: 'sam', role: 'member', message: 'hi', keyId: box.key.id, emit: (e) => events.push(e)})
		assert.equal(toolsFor('member').some((t) => t.name === 'swarm_list'), false)
		assert.equal(seen[0].body.tools.some((t) => t.function.name === 'swarm_list'), false)
		assert.equal(calls.some((c) => c.name === 'swarm.list'), false)
		assert.doesNotMatch(seen[0].body.messages[0].content, /^Swarm:/m)
		assert.equal(seen[0].body.messages[0].content.includes('nas'), false)
		assert.match(seen[0].body.messages[0].content, /Role: member/)
		assert.equal(events.some((e) => e.event === 'done'), true)
	} finally {
		await box.close()
	}
})

test('an unknown tool is not executed', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([toolSse('call_x', 'shell_exec', '{"cmd":"id"}'), textSse('no')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'run id', emit: () => {}})
		assert.ok(calls.every((c) => ['system.getHostname', 'system.device', 'apps.list', 'swarm.list'].includes(c.name)))
		const tool = seen[1].body.messages.find((m) => m.role === 'tool')
		assert.equal(tool.tool_call_id, 'call_x')
		assert.equal(tool.content, 'unknown tool')
	} finally {
		await box.close()
	}
})

test('a write tool is not run yet', async () => {
	const {calls, runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([toolSse('call_w', 'apps_install', '{"appId":"jellyfin"}'), textSse('cannot')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'install jellyfin', emit: () => {}})
		assert.equal(calls.some((c) => c.name === 'apps.install'), false)
		const tool = seen[1].body.messages.find((m) => m.role === 'tool')
		assert.equal(tool.content, 'writes are not enabled yet')
	} finally {
		await box.close()
	}
})

test('appStore_search filters the registry inside the turn', async () => {
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'appStore.registry') {
			return [{apps: [
				{id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', category: 'media', version: '1', compose: 'secret-compose'},
				{id: 'nextcloud', name: 'Nextcloud', tagline: 'Files', category: 'files', version: '2'},
			]}]
		}
	})
	const {seen, fetchImpl} = scripted([toolSse('call_s', 'appStore_search', '{"q":"jelly","limit":5}'), textSse('Jellyfin')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'find jellyfin', emit: () => {}})
		assert.equal(calls.some((c) => c.name === 'appStore.registry'), true)
		const tool = seen[1].body.messages.find((m) => m.role === 'tool')
		const rows = JSON.parse(tool.content)
		assert.deepEqual(rows, [{id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', category: 'media', version: '1'}])
		assert.equal(tool.content.includes('secret-compose'), false)
	} finally {
		await box.close()
	}
})

test('apps_list and appStore_app results omit passwords', async () => {
	const {runProcedure} = factsProcedure(async (name) => {
		if (name === 'apps.list') return [{id: 'files', name: 'Files', state: 'running', port: 8080, credentials: {defaultUsername: 'admin', defaultPassword: 'app-secret', showBeforeOpen: true}}]
		if (name === 'appStore.app') return {id: 'jellyfin', name: 'Jellyfin', tagline: 'Media', port: 8096, defaultUsername: 'jelly', defaultPassword: 'store-secret', deterministicPassword: true}
	})
	const {seen, fetchImpl} = scripted([
		toolSse('call_a', 'apps_list', '{}'),
		toolSse('call_b', 'appStore_app', '{"appId":"jellyfin"}'),
		textSse('listed'),
	])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'which apps', emit: () => {}})
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes('app-secret'), false)
		assert.equal(raw.includes('store-secret'), false)
		assert.equal(raw.includes('defaultPassword'), false)
		assert.equal(raw.includes('credentials'), false)
		const listed = JSON.parse(saved.messages.find((m) => m.name === 'apps_list').content)
		assert.equal(listed[0].id, 'files')
		assert.equal(listed[0].name, 'Files')
		assert.equal(listed[0].state, 'running')
		assert.equal(listed[0].port, 8080)
		const detail = JSON.parse(saved.messages.find((m) => m.name === 'appStore_app').content)
		assert.equal(detail.name, 'Jellyfin')
		assert.equal(detail.port, 8096)
		assert.equal(detail.defaultUsername, 'jelly')
		assert.equal(detail.tagline, 'Media')
		const posted = JSON.stringify(seen.slice(1).map((s) => s.body.messages))
		assert.equal(posted.includes('app-secret'), false)
		assert.equal(posted.includes('store-secret'), false)
		assert.equal(posted.includes('defaultPassword'), false)
		assert.equal(posted.includes('credentials'), false)
	} finally {
		await box.close()
	}
})

test('a failed read is given back to the model', async () => {
	const {runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') throw new Error('disk vanished')
	})
	const {seen, fetchImpl} = scripted([toolSse('call_d', 'system_diskUsage', '{}'), textSse('could not read disk')])
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'disk?', emit: (e) => events.push(e)})
		assert.equal(seen[1].body.messages.find((m) => m.role === 'tool').content, 'disk vanished')
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.some((e) => e.event === 'text' && e.data.text === 'could not read disk'), true)
	} finally {
		await box.close()
	}
})

test('sixteen lookups stop the turn', async () => {
	let fetches = 0
	const {calls, runProcedure} = factsProcedure(async (name) => {
		if (name === 'system.diskUsage') return {free: fetches}
	})
	const fetchImpl = async (url, opts) => {
		fetches++
		JSON.parse(opts.body)
		if (fetches > 16) return textSse('too many')
		return toolSse(`call_${fetches}`, 'system_diskUsage', '{}')
	}
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'keep looking', emit: (e) => events.push(e)})
		assert.equal(fetches, 16)
		assert.equal(calls.filter((c) => c.name === 'system.diskUsage').length, 16)
		assert.equal(events.some((e) => e.event === 'text' && e.data.text === LIMIT), true)
		assert.equal(events.at(-1).event, 'done')
		assert.equal(events.some((e) => e.data?.text === 'too many'), false)
	} finally {
		await box.close()
	}
})

test('the prompt keeps the last 40 messages and a new chat title is the first line', async () => {
	const {runProcedure} = factsProcedure()
	const {seen, fetchImpl} = scripted([textSse('ok'), textSse('ok')])
	const box = await withAssistant({runProcedure, fetchImpl})
	try {
		const long = `${'N'.repeat(60)}\nsecond line`
		const created = await box.asst.runTurn({userId: 'owner', role: 'owner', message: long, emit: () => {}})
		const conv = await box.asst.conversations.get('owner', created.conversationId)
		assert.equal(conv.title, 'N'.repeat(48))
		for (let i = 0; i < 45; i++) await box.asst.conversations.append('owner', conv.id, {role: 'user', content: `old-${i}`, at: i})
		await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'new-one', conversationId: conv.id, emit: () => {}})
		const body = seen[1].body
		const users = body.messages.filter((m) => m.role === 'user').map((m) => m.content)
		assert.equal(body.messages.filter((m) => m.role !== 'system').length, 40)
		assert.equal(users[0], 'old-6')
		assert.equal(users.at(-1), 'new-one')
		assert.equal(users.includes('old-0'), false)
		assert.equal((await box.asst.conversations.get('owner', conv.id)).title, 'N'.repeat(48))
	} finally {
		await box.close()
	}
})

test('a rejected key uses the settings message', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => ({ok: false, status: 401, text: async () => JSON.stringify({error: {message: 'Incorrect API key'}})})
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(events, [{event: 'error', data: {message: KEY_REJECTED}}])
		assert.ok(out.conversationId)
		const raw = await readFile(join(box.dataDir, 'assistant', 'conversations', `${out.conversationId}.json`), 'utf8')
		assert.equal(raw.includes(SECRET), false)
		assert.equal(raw.includes('Incorrect API key'), false)
	} finally {
		await box.close()
	}
})

test('a provider transport failure becomes an error event', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => {
		throw new Error('socket hang up')
	}
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.deepEqual(events, [{event: 'error', data: {message: 'socket hang up'}}])
		assert.ok(out.conversationId)
	} finally {
		await box.close()
	}
})

test('abort keeps partial assistant text and does not emit an error', async () => {
	const {runProcedure} = factsProcedure()
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		text: async () => '',
		body: (async function* () {
			yield 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'
			throw Object.assign(new Error('aborted'), {name: 'AbortError'})
		})(),
	})
	const box = await withAssistant({runProcedure, fetchImpl})
	const events = []
	try {
		const out = await box.asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.some((e) => e.event === 'done'), false)
		const saved = await box.asst.conversations.get('owner', out.conversationId)
		assert.equal(saved.messages.at(-1).content, 'Partial')
	} finally {
		await box.close()
	}
})

test('missing key does not call the provider', async () => {
	let called = false
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	try {
		const asst = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 1,
			runProcedure: async () => null,
			fetchImpl: async () => {
				called = true
				return textSse('no')
			},
		})
		const events = []
		const out = await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(called, false)
		assert.equal(out.conversationId, null)
		assert.match(events[0].data.message, /Settings → Assistant/)
		assert.equal(events.some((e) => e.event === 'done'), false)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('conversation RPCs list, read, and delete only the caller’s threads', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-'))
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, runProcedure: async () => null})
		assert.equal(asst.procedures['assistant.conversations'].kind, 'query')
		assert.equal(asst.procedures['assistant.getConversation'].kind, 'query')
		assert.equal(asst.procedures['assistant.deleteConversation'].kind, 'mutation')
		assert.equal(ALLOWED['assistant.conversations'], 'query')
		assert.equal(ALLOWED['assistant.getConversation'], 'query')
		assert.equal(ALLOWED['assistant.deleteConversation'], 'mutation')
		const made = await asst.conversations.create('owner', {title: 'Need a VM'})
		await asst.conversations.create('sam', {title: 'Other'})
		const list = await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'owner'}})
		assert.deepEqual(list.map((r) => r.id), [made.id])
		assert.equal(list[0].title, 'Need a VM')
		assert.equal(list[0].messages, undefined)
		const got = await asst.procedures['assistant.getConversation'].run({id: made.id}, {auth: {userId: 'owner'}})
		assert.equal(got.userId, 'owner')
		assert.equal(got.apiKey, undefined)
		await assert.rejects(() => asst.procedures['assistant.getConversation'].run({id: made.id}, {auth: {userId: 'sam'}}), /isn.t/)
		await assert.rejects(() => asst.procedures['assistant.deleteConversation'].run({id: made.id}, {auth: {userId: 'sam'}}), /isn.t/)
		assert.equal(await asst.procedures['assistant.deleteConversation'].run({id: made.id}, {auth: {userId: 'owner'}}), true)
		assert.deepEqual(await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'owner'}}), [])
		assert.equal((await asst.procedures['assistant.conversations'].run(undefined, {auth: {userId: 'sam'}})).length, 1)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('omarchyd serves the conversation RPCs', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'al-'))
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'accounts.json')
		const state = JSON.parse(await readFile(file, 'utf8'))
		state.users.push({userId: 'sam', name: 'Sam', role: 'member', language: 'en', salt: state.users[0].salt, hash: state.users[0].hash, createdAt: Date.now()})
		await writeFile(file, JSON.stringify(state, null, '\t'))
		const d = await startOmarchyd({port: 0, dataDir: data, home: root})
		try {
			const anon = await fetch(`${d.url}/trpc/assistant.conversations`)
			assert.equal(anon.status, 401)
			const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
			const headers = {authorization: `Bearer ${login.result.data.accessToken}`}
			const list = await (await fetch(`${d.url}/trpc/assistant.conversations`, {headers})).json()
			assert.deepEqual(list.result.data, [])
			const missing = await fetch(`${d.url}/trpc/assistant.getConversation?input=${encodeURIComponent(JSON.stringify({id: 'c_nope'}))}`, {headers})
			assert.equal(missing.status, 404)
			const gone = await fetch(`${d.url}/trpc/assistant.deleteConversation`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({id: 'c_nope'})})
			assert.equal(gone.status, 404)
		} finally {
			await d.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
