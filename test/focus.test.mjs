// Unit tests for the modal stack, keyboard focus management, live regions, and Field accessibility helpers.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
	dialogStackSize,
	getFocusable,
	getInitialFocusTarget,
	hasOpenDialog,
	isElementFocusable,
	isTopDialog,
	popDialog,
	pushDialog,
	resetDialogStack,
	topDialogElement,
} from '../web/src/focus.ts'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeMockEl(opts = {}) {
	const attrs = new Map(Object.entries(opts.attrs ?? {}))
	return {
		id: opts.id ?? 'el',
		disabled: opts.disabled ?? false,
		tabIndex: opts.tabIndex,
		isConnected: opts.isConnected ?? true,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		closest: opts.closest ?? (() => null),
		focus: opts.focus ?? (() => {}),
	}
}

function makeMockContainer(children = [], opts = {}) {
	const autoTarget = opts.autoTarget ?? null
	const set = new Set(children)
	const container = {
		...makeMockEl({id: opts.id ?? 'dialog', tabIndex: -1}),
		contains: (node) => node === container || set.has(node) || !!opts.extraContains?.(node),
		querySelector: (sel) => (sel.includes('autofocus') ? autoTarget : null),
		querySelectorAll: () => children,
	}
	return container
}

afterEach(() => {
	resetDialogStack()
})

test('modal stack tracks nested dialogs and lets only the top dialog handle Escape', () => {
	assert.equal(hasOpenDialog(), false)
	assert.equal(dialogStackSize(), 0)
	assert.equal(topDialogElement(), null)

	const sheetEl = {id: 'app-sheet'}
	const confirmEl = {id: 'confirm-sheet'}
	const sheetId = pushDialog(undefined, sheetEl)
	assert.equal(hasOpenDialog(), true)
	assert.equal(dialogStackSize(), 1)
	assert.equal(isTopDialog(sheetId), true)
	assert.equal(topDialogElement(), sheetEl)

	// Confirm sheet opens over AppSheet: only Confirm is on top.
	const confirmId = pushDialog(undefined, confirmEl)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(sheetId), false)
	assert.equal(isTopDialog(confirmId), true)
	assert.equal(topDialogElement(), confirmEl)

	// Closing Confirm returns top status to AppSheet underneath.
	popDialog(confirmId)
	assert.equal(dialogStackSize(), 1)
	assert.equal(isTopDialog(sheetId), true)
	assert.equal(isTopDialog(confirmId), false)
	assert.equal(topDialogElement(), sheetEl)

	popDialog(sheetId)
	assert.equal(hasOpenDialog(), false)
	assert.equal(dialogStackSize(), 0)
	assert.equal(topDialogElement(), null)
})

test('modal stack handles out-of-order removal and re-push deduplication', () => {
	const firstEl = {id: 'first'}
	const secondEl = {id: 'second'}
	const thirdEl = {id: 'third'}

	const first = pushDialog(undefined, firstEl)
	const second = pushDialog(undefined, secondEl)
	const third = pushDialog(undefined, thirdEl)
	assert.equal(dialogStackSize(), 3)

	// Out-of-order pop removes the middle dialog without disturbing top.
	popDialog(second)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(third), true)

	// Re-pushing an existing id moves it to the top without creating a duplicate entry.
	pushDialog(first, firstEl)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(first), true)
	assert.equal(isTopDialog(third), false)
	assert.equal(topDialogElement(), firstEl)
})

test('isElementFocusable and getFocusable filter disabled, negative tabindex, and inert controls', () => {
	const ok = makeMockEl({id: 'ok', tabIndex: 0})
	const disabled = makeMockEl({id: 'disabled', disabled: true, tabIndex: 0})
	const disabledAttr = makeMockEl({id: 'disabledAttr', attrs: {disabled: ''}})
	const negTab = makeMockEl({id: 'negTab', tabIndex: -1, attrs: {tabindex: '-1'}})
	const hiddenAncestor = makeMockEl({id: 'hidden', closest: (sel) => (sel.includes('inert') ? {} : null)})
	const container = makeMockContainer([disabled, disabledAttr, negTab, hiddenAncestor, ok])

	assert.equal(isElementFocusable(ok), true)
	assert.equal(isElementFocusable(disabled), false)
	assert.equal(isElementFocusable(disabledAttr), false)
	assert.equal(isElementFocusable(negTab), false)
	assert.equal(isElementFocusable(hiddenAncestor), false)
	assert.deepEqual(getFocusable(container), [ok])
})

test('getInitialFocusTarget respects autoFocus already inside dialog and chooses sensible fallbacks', () => {
	const closeBtn = makeMockEl({id: 'close', tabIndex: 0})
	const autoInput = makeMockEl({id: 'name', tabIndex: 0})
	const outsideBtn = makeMockEl({id: 'opener', tabIndex: 0})
	const dialog = makeMockContainer([closeBtn, autoInput], {autoTarget: autoInput})

	// If React already focused an autoFocus input inside the dialog, do not move focus away.
	assert.equal(getInitialFocusTarget(dialog, autoInput), null)

	// When opener is outside, prefer [data-autofocus]/[autofocus] over the first control.
	assert.equal(getInitialFocusTarget(dialog, outsideBtn), autoInput)

	// Without autofocus, pick the first focusable control.
	const plainDialog = makeMockContainer([closeBtn, autoInput])
	assert.equal(getInitialFocusTarget(plainDialog, outsideBtn), closeBtn)

	// If the dialog has no focusable controls, focus the dialog container itself.
	const emptyDialog = makeMockContainer([])
	assert.equal(getInitialFocusTarget(emptyDialog, outsideBtn), emptyDialog)

	// Preferred container overrides controls when requested.
	assert.equal(getInitialFocusTarget(plainDialog, outsideBtn, 'container'), plainDialog)
})

test('Sheet in ui.tsx delegates focus/Escape to useDialogFocus without onClose in lockPageScroll effect', () => {
	const ui = readFileSync(join(rootDir, 'web/src/ui.tsx'), 'utf8')
	assert.match(ui, /useDialogFocus\(open, ref, onClose\)/)
	assert.match(ui, /useEffect\(\(\) => \{\s*if \(!open\) return\s*return lockPageScroll\(\)\s*\}, \[open\]\)/)
})
