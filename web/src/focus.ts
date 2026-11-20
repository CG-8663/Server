// Shared modal stack, focus management, and accessibility helpers for dialogs, menus, and fields.
import {useEffect, useRef, type RefObject} from 'react'

export interface FocusableLike {
	focus?(options?: FocusOptions): void
	disabled?: boolean
	tabIndex?: number
	isConnected?: boolean
	getAttribute?(name: string): string | null
	closest?(selector: string): unknown
}

export interface ContainerLike extends FocusableLike {
	contains(node: unknown): boolean
	querySelector?(selector: string): FocusableLike | null
	querySelectorAll?(selector: string): ArrayLike<FocusableLike>
}

export const FOCUSABLE_SELECTOR =
	'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'

type DialogEntry = {
	id: symbol
	el: HTMLElement | null
}

const dialogStack: DialogEntry[] = []

// Push a modal dialog onto the stack so only the topmost layer handles Escape and Tab.
export function pushDialog(id: symbol = Symbol('dialog'), el: HTMLElement | null = null): symbol {
	popDialog(id)
	dialogStack.push({id, el})
	return id
}

export function popDialog(id: symbol): void {
	for (let i = dialogStack.length - 1; i >= 0; i--) {
		if (dialogStack[i].id === id) {
			dialogStack.splice(i, 1)
			return
		}
	}
}

export function isTopDialog(id: symbol): boolean {
	return dialogStack.length > 0 && dialogStack[dialogStack.length - 1].id === id
}

export function topDialogElement(): HTMLElement | null {
	return dialogStack.length > 0 ? dialogStack[dialogStack.length - 1].el : null
}

export function hasOpenDialog(): boolean {
	return dialogStack.length > 0
}

export function dialogStackSize(): number {
	return dialogStack.length
}

export function resetDialogStack(): void {
	dialogStack.length = 0
}

export function isElementFocusable(el: FocusableLike | null | undefined): el is FocusableLike {
	if (!el) return false
	if (el.disabled || el.getAttribute?.('disabled') != null) return false
	if (el.getAttribute?.('tabindex') === '-1') return false
	if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false
	if (el.closest?.('[inert], [hidden]')) return false
	if (typeof getComputedStyle === 'function' && typeof Element !== 'undefined' && el instanceof Element) {
		const style = getComputedStyle(el)
		if (style.display === 'none' || style.visibility === 'hidden') return false
	}
	return true
}

export function getFocusable(container: ContainerLike): FocusableLike[] {
	if (!container.querySelectorAll) return []
	return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementFocusable)
}

export function getInitialFocusTarget(
	container: ContainerLike,
	active: FocusableLike | null,
	preferred?: 'auto' | 'container' | FocusableLike | null,
): FocusableLike | null {
	// Respect autoFocus or a child effect that already moved focus into the dialog.
	if (active && active !== container && container.contains(active)) return null
	if (preferred && preferred !== 'auto' && preferred !== 'container' && isElementFocusable(preferred)) return preferred
	if (preferred === 'container') return container
	const auto = container.querySelector?.('[data-autofocus], [autofocus]') ?? null
	if (auto && isElementFocusable(auto)) return auto
	return getFocusable(container)[0] ?? container
}

export type DialogFocusOptions = {
	initialFocus?: 'auto' | 'container' | RefObject<HTMLElement | null>
	canEscape?: (e: KeyboardEvent) => boolean
	restoreFocus?: boolean
}

export function useDialogFocus(
	open: boolean,
	ref: RefObject<HTMLElement | null>,
	onClose?: () => void,
	opts?: DialogFocusOptions,
): () => boolean {
	// Keep callbacks and options in refs so parent re-renders never re-run the focus effect.
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	const canEscapeRef = useRef(opts?.canEscape)
	canEscapeRef.current = opts?.canEscape
	const initialFocusRef = useRef(opts?.initialFocus)
	initialFocusRef.current = opts?.initialFocus
	const dialogIdRef = useRef<symbol | null>(null)

	useEffect(() => {
		if (!open) return
		const el = ref.current
		if (!el) return
		const id = pushDialog(undefined, el)
		dialogIdRef.current = id

		const pref = initialFocusRef.current
		const preferred = pref && typeof pref === 'object' ? pref.current : pref
		const active = document.activeElement as FocusableLike | null
		const target = getInitialFocusTarget(el, active, preferred)
		target?.focus?.({preventScroll: true})

		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || !isTopDialog(id) || e.defaultPrevented) return
			if (canEscapeRef.current && !canEscapeRef.current(e)) return
			e.preventDefault()
			e.stopPropagation()
			onCloseRef.current?.()
		}
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('keydown', onKey)
			popDialog(id)
			if (dialogIdRef.current === id) dialogIdRef.current = null
		}
	}, [open, ref])

	return () => dialogIdRef.current !== null && isTopDialog(dialogIdRef.current)
}
