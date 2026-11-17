export type CaptureMode = 'host' | 'keyboard-lock'
export type LockMethod = 'none' | 'scroll' | 'keyboard-lock'
export type GrabState = {keysLocked: boolean; method: LockMethod; mode: CaptureMode}
export type ToggleSource = 'scroll' | 'f12' | 'chip'

export const CAPTURE_KEY = 'omarchy-server:key-capture'
export const ONBOARDING_KEY = 'omarchy-server:hyprland-onboarding'
export const SNIPPET = `o.bind("SCROLL_LOCK", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
o.bind("SUPER + F12", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
hl.define_submap("passthrough", function()
  o.bind("SCROLL_LOCK", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
  o.bind("SUPER + F12", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
end)`

export function defaultMode(secure: boolean, hasLock: boolean): CaptureMode {
	return secure && hasLock ? 'keyboard-lock' : 'host'
}

export function coerceMode(mode: CaptureMode, secure: boolean): CaptureMode {
	return mode === 'keyboard-lock' && !secure ? 'host' : mode
}

export function canUseKeyboardLock(secure: boolean, hasLock: boolean): boolean {
	return secure && hasLock
}

type KeyboardLock = {lock: (codes?: string[]) => Promise<void>; unlock: () => void}
export function keyboardLockApi(): KeyboardLock | null {
	const k = (navigator as Navigator & {keyboard?: KeyboardLock}).keyboard
	return k && typeof k.lock === 'function' ? k : null
}

export function resolveMode(stored: string | null, secure: boolean, hasLock: boolean): CaptureMode {
	if (stored === 'host' || stored === 'keyboard-lock') return coerceMode(stored, secure)
	return defaultMode(secure, hasLock)
}

export function toggleLock(state: GrabState, source: ToggleSource): GrabState {
	const method: LockMethod = source === 'chip' && state.mode === 'keyboard-lock' ? 'keyboard-lock' : 'scroll'
	if (state.keysLocked) return {...state, keysLocked: false, method: 'none'}
	return {...state, keysLocked: true, method}
}

export function onFullscreenChange(state: GrabState, isFullscreen: boolean): GrabState {
	if (state.method === 'keyboard-lock' && !isFullscreen) return {...state, keysLocked: false, method: 'none'}
	return state
}

export function onBlur(state: GrabState): GrabState {
	return state
}

export function onCaptureModeChange(state: GrabState, next: CaptureMode): GrabState {
	if (state.method === 'keyboard-lock' && next !== 'keyboard-lock') return {keysLocked: false, method: 'none', mode: next}
	return {...state, mode: next}
}

export function chipIntent(state: GrabState): 'toggle' | 'request-keyboard-lock' | 'unlock-keyboard-lock' {
	if (state.mode !== 'keyboard-lock') return 'toggle'
	return state.keysLocked ? 'unlock-keyboard-lock' : 'request-keyboard-lock'
}
