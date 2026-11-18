import {randomBytes} from 'node:crypto'

const completeArgs = (s) => {
	if (!s) return false
	try {
		JSON.parse(s)
		return true
	} catch {
		return false
	}
}

const callId = () => 'call_' + randomBytes(4).toString('hex')

const TOOL_PREFIXES = ['<tool_call', '<function=']

function incompleteToolStart(rest) {
	const unclosedCall = rest.search(/<tool_call>/)
	if (unclosedCall >= 0 && !rest.includes('</tool_call>', unclosedCall)) return unclosedCall
	const unclosedFn = rest.search(/<function=/)
	if (unclosedFn >= 0 && !rest.includes('</function>', unclosedFn)) return unclosedFn
	const lt = rest.lastIndexOf('<')
	if (lt >= 0) {
		const tail = rest.slice(lt)
		if (TOOL_PREFIXES.some((p) => p.startsWith(tail))) return lt
		if (['</tool_call>', '</function>'].some((p) => p.startsWith(tail))) return lt
	}
	return -1
}

const paramsToArgs = (body) => {
	const args = {}
	const re = /<parameter=([^\s>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
	let m
	while ((m = re.exec(body))) args[m[1]] = m[2]
	return Object.keys(args).length ? JSON.stringify(args) : '{}'
}

const toolsFromXmlInner = (block) => {
	const tools = []
	const json = String(block ?? '').trim()
	if (json.startsWith('{')) {
		try {
			const obj = JSON.parse(json)
			const name = String(obj.name ?? obj.function ?? '').trim()
			if (name) {
				const raw = obj.arguments
				const argumentsText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
				tools.push({type: 'tool', id: callId(), name, arguments: argumentsText || '{}'})
			}
		} catch {}
		return tools
	}
	const fn = /<function=([^\s>]+)>([\s\S]*?)<\/function>/g
	let m
	while ((m = fn.exec(block))) tools.push({type: 'tool', id: callId(), name: m[1], arguments: paramsToArgs(m[2])})
	return tools
}

export function takeXmlTools(buf, final) {
	let text = ''
	const tools = []
	let rest = String(buf ?? '')
	for (;;) {
		const wrapped = rest.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
		const fn = rest.match(/<function=([^\s>]+)>([\s\S]*?)<\/function>/)
		const wAt = wrapped ? rest.indexOf(wrapped[0]) : -1
		const fAt = fn ? rest.indexOf(fn[0]) : -1
		let at = -1
		let raw = ''
		let inner = ''
		if (wAt >= 0 && (fAt < 0 || wAt <= fAt)) {
			at = wAt
			raw = wrapped[0]
			inner = wrapped[1]
		} else if (fAt >= 0) {
			at = fAt
			raw = fn[0]
			inner = fn[0]
		}
		if (at < 0) break
		text += rest.slice(0, at)
		tools.push(...toolsFromXmlInner(inner))
		rest = rest.slice(at + raw.length).replace(/^\s*<\/(?:tool_call|function)>/, '')
	}
	rest = rest.replace(/^\s*<\/(?:tool_call|function)>/, '')
	const hold = incompleteToolStart(rest)
	if (hold >= 0) {
		text += rest.slice(0, hold)
		rest = final ? '' : rest.slice(hold)
		return {text, tools, rest}
	}
	text += rest
	return {text, tools, rest: ''}
}

const errorMessage = (raw, status) => {
	try {
		const json = JSON.parse(raw)
		const m = json.error?.message || json.message
		if (m) return String(m)
	} catch {}
	return (raw && String(raw).trim()) || `HTTP ${status}`
}

function parseEvent(event, pending) {
	const data = event.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).replace(/^ /, ''))
		.join('\n')
	const out = {content: '', tools: []}
	if (!data || data === '[DONE]') return out
	let json
	try {
		json = JSON.parse(data)
	} catch {
		return out
	}
	const choice = json.choices?.[0] ?? {}
	const delta = choice.delta ?? {}
	if (typeof delta.content === 'string' && delta.content) out.content += delta.content
	if (typeof choice.message?.content === 'string' && choice.message.content) out.content += choice.message.content
	const addCall = (tc) => {
		if (!tc || typeof tc !== 'object') return
		const i = tc.index ?? pending.length
		const row = pending[i] ?? (pending[i] = {id: '', name: '', arguments: '', done: false})
		if (tc.id) row.id = tc.id
		if (tc.function?.name) row.name = tc.function.name
		if (typeof tc.function?.arguments === 'string') row.arguments += tc.function.arguments
		else if (tc.function?.arguments && typeof tc.function.arguments === 'object') row.arguments = JSON.stringify(tc.function.arguments)
		if (!row.done && row.name && completeArgs(row.arguments)) {
			row.done = true
			if (!row.id) row.id = callId()
			out.tools.push({type: 'tool', id: row.id, name: row.name, arguments: row.arguments})
		}
	}
	for (const tc of delta.tool_calls ?? []) addCall(tc)
	for (const tc of choice.message?.tool_calls ?? []) addCall(tc)
	return out
}



export async function* streamChat({baseUrl, apiKey, model, messages, tools, fetchImpl = fetch, signal}) {
	const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages,
			tools,
			stream: true,
			parallel_tool_calls: false,
			tool_choice: 'auto',
		}),
		signal,
	})
	if (!res.ok) {
		let raw = ''
		try {
			raw = await res.text()
		} catch {}
		yield {type: 'error', message: errorMessage(raw, res.status), status: res.status}
		return
	}
	const pending = []
	const decoder = new TextDecoder()
	let buf = ''
	let contentBuf = ''
	const pump = function* (event, final) {
		const parsed = parseEvent(event, pending)
		if (parsed.content) contentBuf += parsed.content
		const next = takeXmlTools(contentBuf, final)
		contentBuf = next.rest
		if (next.text) yield {type: 'text', text: next.text}
		for (const t of next.tools) yield t
		for (const t of parsed.tools) yield t
	}
	const body = res.body
	if (body) {
		for await (const chunk of body) {
			buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})
			buf = buf.replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* pump(event, false)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* pump(buf.replace(/\r\n/g, '\n'), false)
	yield* pump('', true)
	for (const row of pending) {
		if (row?.done || !row?.name) continue
		const args = row.arguments && completeArgs(row.arguments) ? row.arguments : '{}'
		row.done = true
		if (!row.id) row.id = callId()
		yield {type: 'tool', id: row.id, name: row.name, arguments: args}
	}
}
