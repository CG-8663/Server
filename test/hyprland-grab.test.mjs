import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {canUseKeyboardLock, coerceMode, defaultMode, onBlur, onFullscreenChange, resolveMode, toggleLock} from '../web/src/desktop/hyprland/grab.ts'

const unlocked = (mode) => ({keysLocked: false, method: 'none', mode})

describe('hyprland grab', () => {
	test('toggle on and off', () => {
		const on = toggleLock(unlocked('host'), 'scroll')
		assert.deepEqual(on, {keysLocked: true, method: 'scroll', mode: 'host'})
		assert.deepEqual(toggleLock(on, 'f12'), unlocked('host'))
	})

	test('HTTP coerces keyboard-lock to host', () => {
		assert.equal(coerceMode('keyboard-lock', false), 'host')
		assert.equal(coerceMode('keyboard-lock', true), 'keyboard-lock')
		assert.equal(resolveMode('keyboard-lock', false, true), 'host')
	})

	test('default mode', () => {
		assert.equal(defaultMode(false, true), 'host')
		assert.equal(defaultMode(true, true), 'keyboard-lock')
		assert.equal(defaultMode(true, false), 'host')
		assert.equal(canUseKeyboardLock(true, true), true)
		assert.equal(canUseKeyboardLock(false, true), false)
	})

	test('leaving fullscreen unlocks keyboard-lock; blur does not', () => {
		const locked = {keysLocked: true, method: 'keyboard-lock', mode: 'keyboard-lock'}
		assert.deepEqual(onFullscreenChange(locked, false), {keysLocked: false, method: 'none', mode: 'keyboard-lock'})
		assert.deepEqual(onFullscreenChange(locked, true), locked)
		const hostLocked = toggleLock(unlocked('host'), 'scroll')
		assert.deepEqual(onFullscreenChange(hostLocked, false), hostLocked)
		assert.deepEqual(onBlur(hostLocked), hostLocked)
	})

	test('chip in keyboard-lock mode uses that method', () => {
		const on = toggleLock(unlocked('keyboard-lock'), 'chip')
		assert.equal(on.method, 'keyboard-lock')
		assert.equal(on.keysLocked, true)
	})
})
