// A clipboard paste must be taken once. xterm clears its hidden field but does not cancel the
// paste, so the browser inserts the text there anyway and then keeps delivering the last character.
// Insert clipboard text in place of the selection, keeping whatever sits after the caret.
export function pasteInto(value: string, start: number, end: number, text: string): string {
	const len = value.length
	const bound = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(len, n)) : len)
	const from = Math.min(bound(start), bound(end))
	const to = Math.max(bound(start), bound(end))
	return value.slice(0, from) + text + value.slice(to)
}

export function terminalPasteDecision(clipboardText: string | null): {prevent: boolean; text: string} {
	if (clipboardText == null || clipboardText === '') return {prevent: false, text: ''}
	return {prevent: true, text: clipboardText}
}
