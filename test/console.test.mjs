import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import {BTN, bindConsoleWheel, consoleDisconnectAction, handleConsoleWheel, pointToFb, readConsoleMetrics, resolveSuperKey, screenshotFilename, wheelButtons} from '../web/src/consoleHelpers.ts'

describe('console helpers', () => {
	test('#120: reconnects on clean and unclean disconnects unless disposed or superseded', async () => {
		assert.equal(consoleDisconnectAction({disposed: false, superseded: false, clean: true}), 'reconnect')
		assert.equal(consoleDisconnectAction({disposed: false, superseded: false, clean: false}), 'reconnect')
		assert.equal(consoleDisconnectAction({disposed: true, superseded: false, clean: false}), 'ignore')
		assert.equal(consoleDisconnectAction({disposed: false, superseded: true, clean: true}), 'superseded')

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /consoleDisconnectAction/)
		assert.doesNotMatch(src, /!.*\.detail\.clean/)
	})

	test('#121: maps horizontal and vertical wheel deltas without scrolling up on zero deltaY', async () => {
		assert.deepEqual(wheelButtons(0, 0), [])
		assert.deepEqual(wheelButtons(12, 0), [BTN.wheelRight])
		assert.deepEqual(wheelButtons(-12, 0), [BTN.wheelLeft])
		assert.deepEqual(wheelButtons(0, 12), [BTN.wheelDown])
		assert.deepEqual(wheelButtons(0, -12), [BTN.wheelUp])
		assert.deepEqual(wheelButtons(10, -10), [BTN.wheelUp, BTN.wheelRight])

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /handleConsoleWheel\(|wheelButtons\(/)
	})

	test('#124: keeps Unicode machine names and uses local time in screenshot filenames', async () => {
		const fakeLocal = {
			getFullYear: () => 2026,
			getMonth: () => 10,
			getDate: () => 20,
			getHours: () => 23,
			getMinutes: () => 30,
			getSeconds: () => 5,
			toISOString: () => '2026-11-21T04:30:05.000Z',
		}
		assert.equal(screenshotFilename('Сервер', fakeLocal), 'Сервер-2026-11-20-23-30-05.png')
		assert.equal(screenshotFilename('Мой ПК', fakeLocal), 'Мой-ПК-2026-11-20-23-30-05.png')
		assert.equal(screenshotFilename('日本語 VM 1', fakeLocal), '日本語-VM-1-2026-11-20-23-30-05.png')
		assert.equal(screenshotFilename('!!!', fakeLocal), 'console-2026-11-20-23-30-05.png')
		assert.equal(screenshotFilename('   ', fakeLocal), 'console-2026-11-20-23-30-05.png')
		assert.equal(screenshotFilename('My VM!', fakeLocal), 'My-VM-2026-11-20-23-30-05.png')

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /screenshotFilename\(machine\.name\)/)
	})

	test('#122: binds non-passive wheel listener and prevents default on Ctrl+wheel', async () => {
		const calls = []
		const fakeEl = {
			addEventListener(type, fn, opts) {
				calls.push(['add', type, fn, opts])
			},
			removeEventListener(type, fn) {
				calls.push(['remove', type, fn])
			},
		}
		const listener = () => {}
		const unbind = bindConsoleWheel(fakeEl, listener)
		assert.deepEqual(calls[0], ['add', 'wheel', listener, {passive: false}])
		unbind()
		assert.deepEqual(calls[1], ['remove', 'wheel', listener])

		let prevented = 0
		let zoomed = null
		let scrolled = null
		handleConsoleWheel(
			{ctrlKey: true, clientX: 50, clientY: 60, deltaX: 0, deltaY: -100, preventDefault: () => prevented++},
			{connected: true, onZoom: (dy, p) => (zoomed = {dy, p}), onScroll: (b, p) => (scrolled = {b, p})},
		)
		assert.equal(prevented, 1)
		assert.deepEqual(zoomed, {dy: -100, p: {x: 50, y: 60}})
		assert.equal(scrolled, null)

		let preventedDisconnected = 0
		let zoomedDisconnected = 0
		handleConsoleWheel(
			{ctrlKey: true, clientX: 10, clientY: 20, deltaX: 0, deltaY: -50, preventDefault: () => preventedDisconnected++},
			{connected: false, onZoom: () => zoomedDisconnected++, onScroll: () => {}},
		)
		assert.equal(preventedDisconnected, 1)
		assert.equal(zoomedDisconnected, 0)

		let preventedScroll = 0
		let scrolledRes = null
		handleConsoleWheel(
			{ctrlKey: false, clientX: 30, clientY: 40, deltaX: 12, deltaY: 0, preventDefault: () => preventedScroll++},
			{connected: true, onZoom: () => {}, onScroll: (b, p) => (scrolledRes = {b, p})},
		)
		assert.equal(preventedScroll, 1)
		assert.deepEqual(scrolledRes, {b: [BTN.wheelRight], p: {x: 30, y: 40}})

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /bindConsoleWheel\(/)
		assert.doesNotMatch(src, /onWheel=\{onWheel\}/)
	})

	test('#372: keeps checking remote resize support after initial connect', async () => {
		assert.deepEqual(readConsoleMetrics(null), {res: null, canResize: false})
		assert.deepEqual(readConsoleMetrics({_fbWidth: 0, _fbHeight: 0, _supportsSetDesktopSize: false}), {res: null, canResize: false})
		assert.deepEqual(readConsoleMetrics({_fbWidth: 1920, _fbHeight: 1080, _supportsSetDesktopSize: false}), {res: {w: 1920, h: 1080}, canResize: false})
		assert.deepEqual(readConsoleMetrics({_fbWidth: 1920, _fbHeight: 1080, _supportsSetDesktopSize: true}), {res: {w: 1920, h: 1080}, canResize: true})

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		const pollBlock = src.slice(src.indexOf('window.setInterval(() => {'), src.indexOf('}, 1000)'))
		assert.match(pollBlock, /readConsoleMetrics\(/)
		assert.match(pollBlock, /setCanResize/)
	})

	test('#123: ignores taps and clicks on the black bars while clamping drags', async () => {
		const rect = {left: 0, top: 100, right: 400, bottom: 325, width: 400, height: 225}
		const fb = {w: 1600, h: 900}
		assert.deepEqual(pointToFb({x: 200, y: 212.5}, rect, fb, {clamp: false}), {x: 800, y: 450})
		assert.deepEqual(pointToFb({x: 200, y: 212.5}, rect, fb, {clamp: true}), {x: 800, y: 450})
		// Top, bottom, left, right black bars
		assert.equal(pointToFb({x: 200, y: 40}, rect, fb, {clamp: false}), null)
		assert.equal(pointToFb({x: 200, y: 360}, rect, fb, {clamp: false}), null)
		assert.equal(pointToFb({x: -10, y: 200}, rect, fb, {clamp: false}), null)
		assert.equal(pointToFb({x: 410, y: 200}, rect, fb, {clamp: false}), null)
		// Active drags still clamp to edges
		assert.deepEqual(pointToFb({x: 200, y: 40}, rect, fb, {clamp: true}), {x: 800, y: 0})
		assert.deepEqual(pointToFb({x: 500, y: 400}, rect, fb, {clamp: true}), {x: 1599, y: 899})
		// Missing or zero-size rect/fb
		assert.equal(pointToFb({x: 10, y: 10}, null, fb, {clamp: false}), null)
		assert.equal(pointToFb({x: 10, y: 10}, rect, null, {clamp: false}), null)
		assert.equal(pointToFb({x: 10, y: 10}, {left: 0, top: 0, right: 10, bottom: 0, width: 10, height: 0}, fb, {clamp: false}), null)

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /toFb\(p,\s*false\)/)
		assert.match(src, /toFb\(st\.start,\s*false\)/)
		assert.match(src, /toFb\(st\.two\.mid,\s*false\)/)
		assert.doesNotMatch(src, /toFb\(st\.two\.mid\)\s*\?\?\s*cursor\.current/)
		assert.match(src, /mode === 'touch' && onPicture\(p\)/)
	})

	test('#367: defaults Super key to meta even on Linux desktop so AltGr keeps working', async () => {
		assert.equal(resolveSuperKey(null), 'meta')
		assert.equal(resolveSuperKey(undefined), 'meta')
		assert.equal(resolveSuperKey(''), 'meta')
		assert.equal(resolveSuperKey('unknown'), 'meta')
		assert.equal(resolveSuperKey('altright'), 'altright')
		assert.equal(resolveSuperKey('ctrlright'), 'ctrlright')
		assert.equal(resolveSuperKey('meta'), 'meta')

		const src = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
		assert.match(src, /resolveSuperKey\(/)
		assert.doesNotMatch(src, /\/Linux\/\.test\(navigator\.userAgent\)/)
	})
})
