// Keyboard ownership (launcher vs open context menu) and visible focus rings on inputs/controls.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, test} from 'node:test'

import {shouldLauncherCaptureEnter, shouldYieldLauncherKey} from '../web/src/desktop/hyprland/launcherScroll.ts'

const LAUNCHER = readFileSync(new URL('../web/src/desktop/hyprland/Launcher.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

describe('launcher keyboard ownership when a context menu is open', () => {
	test('yields when a .ctx-menu is mounted in the document', () => {
		const doc = {querySelector: (sel) => (sel === '.ctx-menu' ? {} : null), activeElement: null}
		assert.equal(shouldYieldLauncherKey(doc, null), true)
	})

	test('yields when event target or activeElement is inside .ctx-menu', () => {
		const inMenu = {closest: (sel) => (sel === '.ctx-menu' ? {} : null)}
		const emptyDoc = {querySelector: () => null, activeElement: null}
		assert.equal(shouldYieldLauncherKey(emptyDoc, inMenu), true)
		assert.equal(shouldYieldLauncherKey({querySelector: () => null, activeElement: inMenu}, null), true)
	})

	test('keeps keys when no context menu is open', () => {
		const emptyDoc = {querySelector: () => null, activeElement: {closest: () => null}}
		assert.equal(shouldYieldLauncherKey(emptyDoc, {closest: () => null}), false)
	})

	test('Launcher checks shouldYieldLauncherKey before Escape/Arrow/Enter handling', () => {
		const fn = LAUNCHER.slice(LAUNCHER.indexOf('const onKey ='))
		const guardIdx = fn.indexOf('shouldYieldLauncherKey(document, e.target)')
		const escIdx = fn.indexOf("e.key === 'Escape'")
		assert.ok(guardIdx > 0 && escIdx > guardIdx, 'shouldYieldLauncherKey must run before Escape/Arrow/Enter')
	})

	test('Launcher captures Enter only on the Filter input and moves DOM focus when arrowing inside the list', () => {
		const filterInput = {tagName: 'INPUT'}
		const rowBtn = {tagName: 'BUTTON'}
		assert.equal(shouldLauncherCaptureEnter(filterInput, filterInput, filterInput), true)
		assert.equal(shouldLauncherCaptureEnter(filterInput, rowBtn, rowBtn), false)
		assert.match(LAUNCHER, /shouldLauncherCaptureEnter\(input\.current, document\.activeElement, e\.target\)/)
		assert.match(LAUNCHER, /onFocus=\{\(\) => setSel\(i\)\}/)
		assert.match(LAUNCHER, /list\.current\?\.contains\(document\.activeElement\)/)
	})

	test('context menu and its scrim stack above .hypr-overlay so pointer events reach menu items', () => {
		const z = (sel) => Number(CSS.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{[^}]*?z-index: (\\d+)`))?.[1])
		assert.ok(z('.menu-scrim') > z('.hypr-overlay'), '.menu-scrim must sit above .hypr-overlay')
		assert.ok(z('.ctx-menu') > z('.menu-scrim'), '.ctx-menu must sit above .menu-scrim')
	})
})

describe('visible focus rings', () => {
	test('search, overview search, overview apps, dock items, and launcher input expose focus indicators', () => {
		assert.match(CSS, /\.search:focus-within \{[^}]*box-shadow:/)
		assert.match(CSS, /\.ov-search:focus-within \{[^}]*box-shadow:/)
		assert.match(CSS, /\.ov-app:focus-visible \{[^}]*outline:\s*2px solid/)
		assert.match(CSS, /\.dock-item:focus-visible \{[^}]*outline-offset:\s*-2px/)
		assert.match(CSS, /\.hypr-launcher input:focus-visible \{[^}]*box-shadow:/)
	})
})
