// Shared modal stack, focus management, and accessibility helpers for dialogs, menus, and fields.

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
