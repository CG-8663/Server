// A clipboard paste must be taken once. xterm clears its hidden field but does not cancel the
// paste, so the browser inserts the text there anyway and then keeps delivering the last character.
export function terminalPasteDecision(clipboardText: string | null): {prevent: boolean; text: string} {
	if (clipboardText == null || clipboardText === '') return {prevent: false, text: ''}
	return {prevent: true, text: clipboardText}
}
