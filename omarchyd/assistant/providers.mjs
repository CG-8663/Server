const completeArgs = (s) => {
	if (!s) return false
	try {
		JSON.parse(s)
		return true
	} catch {
		return false
	}
}

const errorMessage = (raw, status) => {
	try {
		const json = JSON.parse(raw)
		const m = json.error?.message || json.message
		if (m) return String(m)
	} catch {}
	return (raw && String(raw).trim()) || `HTTP ${status}`
}

function* parseEvent(event, pending) {
	const data = event.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).replace(/^ /, ''))
		.join('\n')
	if (!data || data === '[DONE]') return
	let json
	try {
		json = JSON.parse(data)
	} catch {
		return
	}
	const delta = json.choices?.[0]?.delta ?? {}
	if (typeof delta.content === 'string' && delta.content) yield {type: 'text', text: delta.content}
	for (const tc of delta.tool_calls ?? []) {
		const i = tc.index ?? 0
		const row = pending[i] ?? (pending[i] = {id: '', name: '', arguments: '', done: false})
		if (tc.id) row.id = tc.id
		if (tc.function?.name) row.name = tc.function.name
		if (typeof tc.function?.arguments === 'string') row.arguments += tc.function.arguments
		if (!row.done && row.id && row.name && completeArgs(row.arguments)) {
			row.done = true
			yield {type: 'tool', id: row.id, name: row.name, arguments: row.arguments}
		}
	}
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
	const body = res.body
	if (body) {
		for await (const chunk of body) {
			buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true})
			buf = buf.replace(/\r\n/g, '\n')
			let idx
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const event = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				yield* parseEvent(event, pending)
			}
		}
	}
	buf += decoder.decode()
	if (buf.trim()) yield* parseEvent(buf.replace(/\r\n/g, '\n'), pending)
}
