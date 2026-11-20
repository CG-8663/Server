export const BTN = {left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64}

export type DisconnectAction = 'ignore' | 'superseded' | 'reconnect'

// Decide what the console should do when noVNC fires a disconnect event.
export function consoleDisconnectAction({disposed, superseded}: {disposed: boolean; superseded: boolean; clean?: boolean}): DisconnectAction {
	if (disposed) return 'ignore'
	if (superseded) return 'superseded'
	return 'reconnect'
}

// Map browser wheel deltas to VNC mouse wheel button masks.
export function wheelButtons(deltaX: number, deltaY: number): number[] {
	const out: number[] = []
	if (deltaY > 0) out.push(BTN.wheelDown)
	else if (deltaY < 0) out.push(BTN.wheelUp)
	if (deltaX > 0) out.push(BTN.wheelRight)
	else if (deltaX < 0) out.push(BTN.wheelLeft)
	return out
}

export type LocalDateLike = Pick<Date, 'getFullYear' | 'getMonth' | 'getDate' | 'getHours' | 'getMinutes' | 'getSeconds'>

// Build a screenshot filename keeping Unicode letters and using local wall-clock time.
export function screenshotFilename(name: string, now: LocalDateLike = new Date()): string {
	const base = name.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'console'
	const pad = (n: number) => String(n).padStart(2, '0')
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
	return `${base}-${stamp}.png`
}
