import type {AssistantAction} from './api'

export type {AssistantAction} from './api'

const STATUSES: readonly AssistantAction['status'][] = ['pending', 'rejected', 'running', 'done', 'error']
const SECRET_JSON = /"(password|apiKey|credentials|defaultPassword)"\s*:\s*(?:"(?:\\.|[^"\\])*"|\{[^{}]*\}|\[[^\[\]]*\]|[^,\n\r}\]]+)/gi
const SECRET_PAIR = /\b(password|apiKey|credentials|defaultPassword)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi

const isStatus = (v: unknown): v is AssistantAction['status'] => STATUSES.includes(v as AssistantAction['status'])

// Drop captured call bodies. A title or detail that still embeds a secret is blanked before paint.
function scrubSecrets(text: string) {
	return text.replace(SECRET_JSON, '"$1":"…"').replace(SECRET_PAIR, '$1$2…')
}

export function cardAction(raw: unknown): AssistantAction {
	const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
	const error = typeof a.error === 'string' ? scrubSecrets(a.error) : ''
	return {
		id: typeof a.id === 'string' ? a.id : '',
		status: isStatus(a.status) ? a.status : 'pending',
		kind: a.kind === 'mcp' ? 'mcp' : 'rpc',
		toolName: typeof a.toolName === 'string' ? a.toolName : '',
		title: scrubSecrets(typeof a.title === 'string' ? a.title : ''),
		detail: scrubSecrets(typeof a.detail === 'string' ? a.detail : ''),
		...(error ? {error} : {}),
	}
}

export type AssistantEvent =
	| {event: 'text'; data: {text: string}}
	| {event: 'tool'; data: {name: string; state: string}}
	| {event: 'action'; data: AssistantAction}
	| {event: 'done'; data: {conversationId: string}}
	| {event: 'error'; data: {message: string}}

export type AssistantStreamBody =
	| {conversationId?: string; message: string; keyId?: string}
	| {conversationId: string; continue: true; keyId?: string}

export async function streamAssistant(body: AssistantStreamBody, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal) {
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
			const parsed: unknown = JSON.parse(dataLine.slice(6))
			if (ev === 'action') {
				const action = cardAction(parsed)
				if (action.id) onEvent({event: 'action', data: action})
				continue
			}
			onEvent({event: ev, data: parsed} as AssistantEvent)
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

export type AssistantItem =
	| {id: string; kind: 'text'; role: 'user' | 'assistant'; content: string; streaming?: boolean}
	| {id: string; kind: 'card'; action: AssistantAction}

export function threadItems(conv: {messages?: AssistantChatMessage[]; actions?: AssistantAction[]}): AssistantItem[] {
	const byId = new Map<string, AssistantAction>()
	for (const raw of conv.actions ?? []) {
		const action = cardAction(raw)
		if (action.id) byId.set(action.id, action)
	}
	const out: AssistantItem[] = []
	const seen = new Set<string>()
	;(conv.messages ?? []).forEach((m, i) => {
		if (m.role === 'user') out.push({id: `u-${m.at}-${i}`, kind: 'text', role: 'user', content: m.content})
		else if (m.role === 'assistant' && m.content) out.push({id: `a-${m.at}-${i}`, kind: 'text', role: 'assistant', content: m.content})
		else if (m.role === 'action') {
			const action = byId.get(m.actionId)
			if (!action || seen.has(action.id)) return
			seen.add(action.id)
			out.push({id: `card-${action.id}`, kind: 'card', action})
		}
	})
	for (const action of byId.values()) {
		if (seen.has(action.id)) continue
		seen.add(action.id)
		out.push({id: `card-${action.id}`, kind: 'card', action})
	}
	return out
}
