// What a live assistant bubble and the character badge show. Pure: the screen and the widget
// decide from this, so the mark and the count stay in one place.

export type LiveBubbleMark = 'spinner' | 'ellipsis' | null

export function liveBubbleMark({streaming, content}: {streaming?: boolean; content?: string; activity?: string | null}): LiveBubbleMark {
	if (!streaming) return null
	return content ? 'ellipsis' : 'spinner'
}

export type AssistantIconBadge = {count: number} | {warn: true} | null

export function assistantIconBadge({unread = 0, pending = 0, phase}: {unread?: number; pending?: number; phase?: string}): AssistantIconBadge {
	if (unread > 0) return {count: unread}
	if (pending > 0) return {count: pending}
	if (phase === 'error') return {warn: true}
	return null
}
