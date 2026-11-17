import {streamChat} from './providers.mjs'
import {filterAppStore, isWriteTool, lookupTool, openAiTools} from './tools.mjs'

export const SYSTEM_PROMPT = 'You are the Omarchy Server assistant on this machine and its Local swarm. You do not write programs or propose shell commands. Use only the given tools. Lookups run immediately. You cannot change anything yet. Stay on this host.'

const LIMIT = 'I hit the lookup limit for this turn.'
const KEY_REJECTED = 'That API key was rejected. Replace it in Settings → Assistant.'
const MAX_CALLS = 16
const MAX_MESSAGES = 40

const textOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null))

function toOpenAI(m) {
	if (m.role === 'user') return {role: 'user', content: String(m.content ?? '')}
	if (m.role === 'assistant') {
		const msg = {role: 'assistant', content: m.content ? String(m.content) : null}
		if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
			msg.tool_calls = m.toolCalls.map((t) => ({
				id: t.id,
				type: 'function',
				function: {name: t.name, arguments: t.arguments || '{}'},
			}))
		}
		return msg
	}
	if (m.role === 'tool') return {role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '')}
	return null
}

function parseArgs(raw) {
	if (!raw || !String(raw).trim()) return {}
	const args = JSON.parse(raw)
	if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
	return args
}

export function createLoop({keys, conversations, runProcedure, fetchImpl, now = () => Date.now()}) {
	const stamp = () => now()

	async function grab(name, auth, input = {}) {
		if (!runProcedure) return null
		try {
			return await runProcedure(name, input, auth)
		} catch {
			return null
		}
	}

	async function facts(role, auth) {
		const owner = role === 'owner'
		const hostname = await grab('system.getHostname', auth)
		const device = await grab('system.device', auth)
		const apps = await grab('apps.list', auth)
		const swarm = owner ? await grab('swarm.list', auth) : null
		const appIds = Array.isArray(apps) ? apps.map((a) => a?.id).filter(Boolean) : []
		const swarmNames = Array.isArray(swarm) ? swarm.map((s) => s?.name).filter(Boolean) : []
		const lines = [SYSTEM_PROMPT, '', `Role: ${owner ? 'owner' : 'member'}`]
		if (typeof hostname === 'string' && hostname) lines.push(`Hostname: ${hostname}`)
		if (device && typeof device === 'object' && device.device) lines.push(`Device: ${device.device}${device.os ? ` (${device.os})` : ''}`)
		lines.push(`Installed apps: ${appIds.join(', ') || 'none'}`)
		if (owner) lines.push(`Swarm: ${swarmNames.join(', ') || 'none'}`)
		return lines.join('\n')
	}

	async function runTool(tool, auth) {
		// Writes stay pending until Approve exists. Do not call the procedure.
		if (isWriteTool(tool.name)) return {content: 'writes are not enabled yet', state: 'done'}
		const read = lookupTool(tool.name)
		if (!read) return {content: 'unknown tool', state: 'done'}
		let args
		try {
			args = parseArgs(tool.arguments)
		} catch {
			return {content: 'invalid arguments', state: 'error'}
		}
		try {
			if (!runProcedure) return {content: 'tool failed', state: 'error'}
			const result = read.name === 'appStore_search' ? filterAppStore(await runProcedure('appStore.registry', {}, auth), args) : await runProcedure(read.rpc, args, auth)
			return {content: textOf(result), state: 'done'}
		} catch (e) {
			return {content: e?.message || 'tool failed', state: 'error'}
		}
	}

	async function runTurn({userId, role, message, conversationId, keyId, signal, emit}) {
		const say = (event, data) => {
			if (typeof emit === 'function') emit({event, data})
		}
		let row = null
		const finish = (conversationIdOut) => ({conversationId: conversationIdOut ?? null})
		try {
			if (conversationId) row = await conversations.get(userId, conversationId)
			let key
			try {
				key = await keys.resolveForUser(userId, keyId || row?.keyId || undefined)
			} catch (e) {
				say('error', {message: e?.message || 'Add an API key in Settings → Assistant, or ask the owner to share one'})
				return finish(row?.id)
			}
			if (!row) {
				const title = String(message ?? '').split(/\r?\n/)[0].trim().slice(0, 48) || 'Chat'
				row = await conversations.create(userId, {keyId: key.id, title})
			} else if (row.keyId !== key.id) {
				row = await conversations.setKey(userId, row.id, key.id)
			}
			const auth = {userId, role}
			row = await conversations.append(userId, row.id, {role: 'user', content: String(message ?? ''), at: stamp()})
			const system = await facts(role, auth)
			const tools = openAiTools(role)
			let used = 0

			const stopped = async (text) => {
				if (text) row = await conversations.append(userId, row.id, {role: 'assistant', content: text, at: stamp()})
			}

			for (;;) {
				if (signal?.aborted) return finish(row.id)
				const history = row.messages.map(toOpenAI).filter(Boolean).slice(-MAX_MESSAGES)
				while (history[0]?.role === 'tool') history.shift()
				const messages = [{role: 'system', content: system}, ...history]
				let text = ''
				const toolCalls = []
				let providerError = null
				try {
					for await (const ev of streamChat({
						baseUrl: key.baseUrl,
						apiKey: key.apiKey,
						model: key.model,
						messages,
						tools,
						fetchImpl,
						signal,
					})) {
						if (signal?.aborted) break
						if (ev.type === 'text') {
							text += ev.text
							say('text', {text: ev.text})
						} else if (ev.type === 'tool') toolCalls.push(ev)
						else if (ev.type === 'error') {
							providerError = ev
							break
						}
					}
				} catch (e) {
					await stopped(text)
					if (signal?.aborted || e?.name === 'AbortError') return finish(row.id)
					say('error', {message: e?.message || 'The assistant did not answer'})
					return finish(row.id)
				}
				if (signal?.aborted) {
					await stopped(text)
					return finish(row.id)
				}
				if (providerError) {
					await stopped(text)
					say('error', {message: providerError.status === 401 ? KEY_REJECTED : (providerError.message || 'The assistant did not answer')})
					return finish(row.id)
				}
				if (!toolCalls.length) {
					await stopped(text)
					say('done', {conversationId: row.id})
					return finish(row.id)
				}
				row = await conversations.append(userId, row.id, {
					role: 'assistant',
					content: text,
					toolCalls: toolCalls.map((t) => ({id: t.id, name: t.name, arguments: t.arguments})),
					at: stamp(),
				})
				let hit = false
				const leftover = []
				for (const tool of toolCalls) {
					if (used >= MAX_CALLS) {
						leftover.push(tool)
						hit = true
						continue
					}
					const outcome = await runTool(tool, auth)
					used++
					row = await conversations.append(userId, row.id, {
						role: 'tool',
						toolCallId: tool.id,
						name: tool.name,
						content: outcome.content,
						at: stamp(),
					})
					say('tool', {name: tool.name, state: outcome.state})
					if (used >= MAX_CALLS) hit = true
				}
				if (!hit) continue
				for (const tool of leftover) {
					row = await conversations.append(userId, row.id, {
						role: 'tool',
						toolCallId: tool.id,
						name: tool.name,
						content: LIMIT,
						at: stamp(),
					})
				}
				row = await conversations.append(userId, row.id, {role: 'assistant', content: LIMIT, at: stamp()})
				say('text', {text: LIMIT})
				say('done', {conversationId: row.id})
				return finish(row.id)
			}
		} catch (e) {
			say('error', {message: e?.message || 'The assistant did not answer'})
			return finish(row?.id)
		}
	}

	return {runTurn}
}
