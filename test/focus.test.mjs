// Unit tests for the modal stack, keyboard focus management, live regions, and Field accessibility helpers.
import assert from 'node:assert/strict'
import {afterEach, test} from 'node:test'

import {
	dialogStackSize,
	hasOpenDialog,
	isTopDialog,
	popDialog,
	pushDialog,
	resetDialogStack,
	topDialogElement,
} from '../web/src/focus.ts'

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
