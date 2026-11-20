import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import {consoleDisconnectAction} from '../web/src/consoleHelpers.ts'

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
})
