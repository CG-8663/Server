import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {terminalPasteDecision} from '../web/src/terminalPaste.ts'

test('a clipboard paste is taken once so the browser cannot repeat the last character', async () => {
	assert.deepEqual(terminalPasteDecision('hello'), {prevent: true, text: 'hello'})
	assert.deepEqual(terminalPasteDecision('line\n'), {prevent: true, text: 'line\n'})
	assert.deepEqual(terminalPasteDecision(''), {prevent: false, text: ''})
	assert.deepEqual(terminalPasteDecision(null), {prevent: false, text: ''})

	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /terminalPasteDecision\(e\.clipboardData/)
	assert.match(src, /e\.preventDefault\(\)/)
	assert.match(src, /e\.stopPropagation\(\)/)
	assert.match(src, /term\.paste\(decision\.text\)/)
	assert.match(src, /addEventListener\('paste', onPaste, true\)/)
})
