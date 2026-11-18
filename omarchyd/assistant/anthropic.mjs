// Anthropic's own Messages API (POST /v1/messages). The loop speaks Chat Completions, so its messages
// and tools are converted here and the stream comes back as the same {text | tool | error} events.
import {randomBytes} from 'node:crypto'

export const ANTHROPIC = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192

export const anthropicHeaders = (apiKey) => ({'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION})

// Tool ids must match ^[a-zA-Z0-9_-]+$; ids from another provider are mapped the same way on both sides.
const safeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'toolu_' + randomBytes(4).toString('hex')

const parseInput = (raw) => {
	try {
		const v = JSON.parse(raw || '{}')
		return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
	} catch {
		return {}
	}
}

export function anthropicMessages(messages) {
	const system = []
	const out = []
	const push = (role, blocks) => {
		if (!blocks.length) return
		const last = out.at(-1)
		// Roles alternate: tool results after a tool call, or two user turns in a row, share one message.
		if (last?.role === role) last.content.push(...blocks)
		else out.push({role, content: blocks})
	}
	for (const m of messages ?? []) {
		if (!m) continue
		if (m.role === 'system') {
			if (m.content) system.push(String(m.content))
		} else if (m.role === 'user') {
			push('user', [{type: 'text', text: String(m.content ?? '') || ' '}])
		} else if (m.role === 'assistant') {
			const blocks = []
			if (m.content) blocks.push({type: 'text', text: String(m.content)})
			for (const t of m.tool_calls ?? []) blocks.push({type: 'tool_use', id: safeId(t.id), name: t.function?.name, input: parseInput(t.function?.arguments)})
			push('assistant', blocks)
		} else if (m.role === 'tool') {
			push('user', [{type: 'tool_result', tool_use_id: safeId(m.tool_call_id), content: String(m.content ?? '')}])
		}
	}
	return {system: system.join('\n\n'), messages: out}
}

export const anthropicTools = (tools) =>
	(tools ?? []).map((t) => ({name: t.function?.name, description: t.function?.description ?? '', input_schema: t.function?.parameters ?? {type: 'object', properties: {}}}))

const errorText = (raw, status) => {
	try {
		const m = JSON.parse(raw)?.error?.message
		if (m) return String(m)
	} catch {}
	return (raw && String(raw).trim()) || `HTTP ${status}`
}

export async function* streamAnthropic({baseUrl = ANTHROPIC, apiKey, model, messages, tools, fetchImpl = fetch, signal}) {
	const converted = anthropicMessages(messages)
	const body = {model, max_tokens: MAX_TOKENS, messages: converted.messages, stream: true}
	if (converted.system) body.system = converted.system
	const fnTools = anthropicTools(tools)
	if (fnTools.length) Object.assign(body, {tools: fnTools, tool_choice: {type: 'auto', disable_parallel_tool_use: true}})
	const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/messages`, {
		method: 'POST',
		headers: {'content-type': 'application/json', accept: 'text/event-stream', ...anthropicHeaders(apiKey)},
		body: JSON.stringify(body),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorText(raw, res.status), status: res.status}
		return
	}
	const blocks = new Map() // content blocks by index
	let finished = false
	const handle = function* (event) {
		const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
		if (!data) return
		let ev
		try {
			ev = JSON.parse(data)
		} catch {
			return
		}
		if (ev.type === 'content_block_start') {
			const cb = ev.content_block ?? {}
			blocks.set(ev.index, {type: cb.type, id: cb.id, name: cb.name, json: ''})
			if (cb.type === 'text' && cb.text) yield {type: 'text', text: cb.text}
		} else if (ev.type === 'content_block_delta') {
			const b = blocks.get(ev.index)
			if (ev.delta?.type === 'text_delta' && ev.delta.text) yield {type: 'text', text: ev.delta.text}
			else if (ev.delta?.type === 'input_json_delta' && b) b.json += ev.delta.partial_json ?? ''
		} else if (ev.type === 'content_block_stop') {
			const b = blocks.get(ev.index)
			if (b?.type === 'tool_use' && b.name) {
				const input = parseInput(b.json)
				yield {type: 'tool', id: b.id || safeId(''), name: b.name, arguments: JSON.stringify(input)}
			}
			blocks.delete(ev.index)
		} else if (ev.type === 'message_stop') finished = true
		else if (ev.type === 'error') {
			finished = true
			yield {type: 'error', message: String(ev.error?.message || 'The assistant did not answer'), status: ev.error?.type === 'authentication_error' ? 401 : 0}
		}
	}
	const decoder = new TextDecoder()
	let buf = ''
	if (res.body) {
		for await (const chunk of res.body) {
			buf += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})).replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* handle(event)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* handle(buf.replace(/\r\n/g, '\n'))
	if (!finished && !signal?.aborted) yield {type: 'error', message: 'The answer was cut off; try again'}
}
