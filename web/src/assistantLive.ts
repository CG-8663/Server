// What a live assistant bubble and the character badge show. Pure: the screen and the widget
// decide from this, so the mark and the count stay in one place.
import type {AssistantAction, AssistantItem} from './assistant.ts'

export type LiveBubbleMark = 'spinner' | 'ellipsis' | null

export function liveBubbleMark({streaming, content}: {streaming?: boolean; content?: string; activity?: string | null}): LiveBubbleMark {
	if (!streaming) return null
	return content ? 'ellipsis' : 'spinner'
}

export type LiveTurnState = {
	baseId: string
	liveId: string
	afterTool: boolean
	part: number
}

export const startLiveTurn = (aid: string): LiveTurnState => ({baseId: aid, liveId: aid, afterTool: false, part: 1})

// Append streamed text to the live assistant reply. When a tool ran after earlier text,
// finish that bubble and open a new one so live replies match the saved chat after reload.
export function appendLiveText(items: AssistantItem[] | null, turn: LiveTurnState, text: string): {items: AssistantItem[] | null; turn: LiveTurnState} {
	if (!items || !text) return {items, turn}
	const cur = items.find((b) => b.kind === 'text' && b.id === turn.liveId)
	if (!cur || cur.kind !== 'text') return {items, turn}
	if (turn.afterTool && cur.content) {
		const part = turn.part + 1
		const nextId = `${turn.baseId}-${part}`
		const next: AssistantItem[] = items.map((b) => (b.kind === 'text' && b.id === turn.liveId ? {...b, streaming: false} : b))
		next.push({id: nextId, kind: 'text', role: 'assistant', content: text, streaming: true})
		return {items: next, turn: {...turn, liveId: nextId, afterTool: false, part}}
	}
	return {
		items: items.map((b) => (b.kind === 'text' && b.id === turn.liveId ? {...b, content: b.content + text} : b)),
		turn: turn.afterTool ? {...turn, afterTool: false} : turn,
	}
}

export function insertLiveAction(items: AssistantItem[] | null, liveId: string, action: AssistantAction): AssistantItem[] | null {
	if (!items || !action.id) return items
	const card: AssistantItem = {id: `card-${action.id}`, kind: 'card', action}
	const idx = items.findIndex((b) => b.kind === 'card' && b.action.id === action.id)
	if (idx >= 0) return items.map((b, i) => (i === idx ? card : b))
	const live = items.findIndex((b) => b.kind === 'text' && b.id === liveId && !b.content)
	if (live >= 0) {
		const next = items.slice()
		next.splice(live, 0, card)
		return next
	}
	return [...items, card]
}

export function finishLiveItems(items: AssistantItem[] | null, liveId: string, dropEmpty: boolean): AssistantItem[] | null {
	if (!items) return items
	return items.flatMap((b) => {
		if (b.kind !== 'text' || b.id !== liveId) return [b]
		if (!b.content && dropEmpty) return []
		return [{...b, streaming: false}]
	})
}

export type AssistantIconBadge = {count: number} | {warn: true} | null

export function assistantIconBadge({unread = 0, pending = 0, phase}: {unread?: number; pending?: number; phase?: string}): AssistantIconBadge {
	if (unread > 0) return {count: unread}
	if (pending > 0) return {count: pending}
	if (phase === 'error') return {warn: true}
	return null
}
