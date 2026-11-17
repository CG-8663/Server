type Handler = (e: KeyboardEvent) => void
let handler: Handler | null = null

export function setConsoleKeyHandler(h: Handler | null) {
	handler = h
}

export function injectConsoleKey(e: KeyboardEvent) {
	handler?.(e)
}

export function consoleHandlerActive() {
	return !!handler
}
