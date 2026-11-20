import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const SAM = {userId: 'sam', role: 'member'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? SAM : null)})
const tmp = () => mkdtemp(join(os.tmpdir(), 'acs-state-'))
const chunk = (s) => new TextEncoder().encode(s)
const openaiSays = (text) => ({
	ok: true,
	status: 200,
	headers: new Headers(),
	body: (async function* () {
		yield chunk(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)
	})(),
})

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

test('a step left running across a restart is marked interrupted and reports its tool result', async () => {
	const dataDir = await tmp()
	try {
		let started
		const runningStarted = new Promise((resolve) => {
			started = resolve
		})
		const a1 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 10,
			runProcedure: () => {
				started()
				return new Promise(() => {})
			},
		})
		const chat = await a1.conversations.create('owner', {title: 'Install'})
		await a1.conversations.append('owner', chat.id, {role: 'user', content: 'install x', at: 1})
		await a1.conversations.append('owner', chat.id, {
			role: 'assistant',
			content: '',
			toolCalls: [{id: 'call_1', name: 'apps_install', arguments: '{"appId":"x"}'}],
			at: 2,
		})
		const act = await a1.conversations.putAction('owner', chat.id, {
			kind: 'rpc',
			toolName: 'apps_install',
			toolCallId: 'call_1',
			title: 'Install X',
			detail: '',
			rpc: {path: 'apps.install', input: {appId: 'x'}},
			mcp: null,
		})
		// A separate pending step in another chat must stay pending across restart.
		const other = await a1.conversations.create('owner', {title: 'Other'})
		const pendingAct = await a1.conversations.putAction('owner', other.id, {
			kind: 'rpc',
			toolName: 'apps_start',
			toolCallId: 'call_2',
			title: 'Start Y',
			detail: '',
			rpc: {path: 'apps.start', input: {appId: 'y'}},
			mcp: null,
		})

		void a1.procedures['assistant.approve'].run({actionId: act.id}, {auth: {userId: 'owner'}})
		await runningStarted

		// Restart: a fresh assistant instance on the same data directory.
		const seen = []
		const a2 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 20,
			fetchImpl: async (_url, init) => {
				seen.push(JSON.parse(init.body))
				return openaiSays('Let us try again.')
			},
			runProcedure: async () => null,
		})
		const after = await a2.conversations.get('owner', chat.id)
		assert.equal(after.actions[0].status, 'error')
		assert.match(after.actions[0].error, /Interrupted/i)
		assert.equal(after.actions[0].resolvedAt, 20)
		const outcome = after.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1')
		assert.ok(outcome, 'appends a tool result for the interrupted step')
		assert.equal(outcome.content, after.actions[0].error)
		assert.equal((await a2.conversations.get('owner', other.id)).actions[0].id, pendingAct.id)
		assert.equal((await a2.conversations.get('owner', other.id)).actions[0].status, 'pending')

		// Continuing the chat sends the interrupted result instead of "waiting for Approve".
		await a2.keys.add(OWNER, {provider: 'openai', api: 'chat', apiKey: 'sk-test-1234', model: 'm'})
		const events = []
		await a2.runTurn({userId: 'owner', role: 'owner', conversationId: chat.id, message: 'what happened?', emit: (e) => events.push(e)})
		assert.deepEqual(events.map((e) => e.event), ['text', 'done'])
		const sentTool = seen[0].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
		assert.ok(sentTool)
		assert.match(sentTool.content, /Interrupted/i)
		assert.doesNotMatch(sentTool.content, /waiting for Approve/i)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
