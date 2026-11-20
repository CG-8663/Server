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

export type ConsoleWheelEvent = {
	ctrlKey: boolean
	clientX: number
	clientY: number
	deltaX: number
	deltaY: number
	preventDefault: () => void
}

// Handle wheel zoom and scroll events in the console touch layer.
export function handleConsoleWheel(
	e: ConsoleWheelEvent,
	opts: {
		connected: boolean
		onZoom: (deltaY: number, p: {x: number; y: number}) => void
		onScroll: (buttons: number[], p: {x: number; y: number}) => void
	},
) {
	const p = {x: e.clientX, y: e.clientY}
	if (e.ctrlKey) {
		e.preventDefault()
		if (opts.connected) opts.onZoom(e.deltaY, p)
		return
	}
	if (!opts.connected) return
	const buttons = wheelButtons(e.deltaX, e.deltaY)
	if (!buttons.length) return
	e.preventDefault()
	opts.onScroll(buttons, p)
}

// Register a native wheel listener with passive: false so preventDefault works.
export function bindConsoleWheel(
	el: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
	onWheel: (e: WheelEvent) => void,
) {
	el.addEventListener('wheel', onWheel, {passive: false})
	return () => el.removeEventListener('wheel', onWheel)
}

// Read the current framebuffer size and whether the remote desktop supports resizing.
export function readConsoleMetrics(rfb: {_fbWidth?: number; _fbHeight?: number; _supportsSetDesktopSize?: boolean} | null | undefined) {
	const res = rfb?._fbWidth && rfb?._fbHeight ? {w: rfb._fbWidth, h: rfb._fbHeight} : null
	return {res, canResize: !!rfb?._supportsSetDesktopSize}
}

export type Pt = {x: number; y: number}
export type Rect = {left: number; top: number; right: number; bottom: number; width: number; height: number}
export type Size = {w: number; h: number}

// Convert a screen coordinate to a framebuffer pixel, returning null outside the picture unless clamp is set.
export function pointToFb(p: Pt, rect: Rect | null, fb: Size | null, {clamp = true}: {clamp?: boolean} = {}): Pt | null {
	if (!fb || !rect || !rect.width || !rect.height) return null
	if (!clamp && (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom)) return null
	return {
		x: Math.round(Math.min(fb.w - 1, Math.max(0, ((p.x - rect.left) / rect.width) * fb.w))),
		y: Math.round(Math.min(fb.h - 1, Math.max(0, ((p.y - rect.top) / rect.height) * fb.h))),
	}
}
