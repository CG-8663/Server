export type AssistantAction = {
	id: string
	conversationId: string
	userId?: string
	status: 'pending' | 'rejected' | 'running' | 'done' | 'error'
	kind: 'rpc' | 'mcp'
	toolName: string
	title: string
	detail: string
	rpc?: {path: string; input: unknown} | null
	mcp?: {appId: string; tool: string; arguments: unknown} | null
	createdAt?: number
	resolvedAt?: number
	error?: string
}

export type AssistantEvent =
	| {event: 'text'; data: {text: string}}
	| {event: 'tool'; data: {name: string; state: string}}
	| {event: 'action'; data: AssistantAction}
	| {event: 'done'; data: {conversationId: string}}
	| {event: 'error'; data: {message: string}}

export async function streamAssistant(body: {conversationId?: string; message: string; keyId?: string}, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal) {
	const res = await fetch('/api/assistant/stream', {
		method: 'POST',
		credentials: 'same-origin',
		headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
		body: JSON.stringify(body),
		signal,
	})
	if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error?.message ?? 'The assistant did not answer')
	const reader = res.body.getReader()
	const dec = new TextDecoder()
	let buf = ''
	for (;;) {
		const {done, value} = await reader.read()
		if (done) break
		buf += dec.decode(value, {stream: true})
		const parts = buf.split('\n\n')
		buf = parts.pop() ?? ''
		for (const block of parts) {
			const ev = /event: (\w+)/.exec(block)?.[1]
			const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
			if (!ev || !dataLine) continue
			onEvent({event: ev, data: JSON.parse(dataLine.slice(6))} as AssistantEvent)
		}
	}
}

export type AssistantChatMessage =
	| {role: 'user'; content: string; at: number}
	| {role: 'assistant'; content?: string; at: number; toolCalls?: {id: string; name: string; arguments: string}[]}
	| {role: 'tool'; toolCallId: string; name: string; content: string; at: number}
	| {role: 'action'; actionId: string; at: number}

export type AssistantConversationSummary = {id: string; title: string; updatedAt: number}

export type AssistantConversation = AssistantConversationSummary & {
	userId: string
	keyId: string | null
	createdAt: number
	messages: AssistantChatMessage[]
	actions?: AssistantAction[]
}
