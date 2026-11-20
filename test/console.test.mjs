import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import {BTN, consoleDisconnectAction, screenshotFilename, wheelButtons} from '../web/src/consoleHelpers.ts'

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
		assert.match(src, /wheelButtons\(/)
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
})
