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
