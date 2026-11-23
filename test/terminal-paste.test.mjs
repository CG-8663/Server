import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {pasteInto, terminalPasteDecision} from '../web/src/terminalPaste.ts'

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

test('the paste box inserts at the caret and keeps the text after it', async () => {
	assert.equal(pasteInto('hello', 5, 5, '!'), 'hello!')
	assert.equal(pasteInto('hello', 2, 2, 'X'), 'heXllo')
	assert.equal(pasteInto('hello', 0, 0, 'Z'), 'Zhello')
	assert.equal(pasteInto('hello', 1, 4, 'YY'), 'hYYo')
	assert.equal(pasteInto('abcdef', 4, 2, '-'), 'ab-ef')
	assert.equal(pasteInto('abcd', 1, 3, ''), 'ad')
	assert.equal(pasteInto('', 0, 0, 'hi'), 'hi')

	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /pasteInto\(/)
	assert.doesNotMatch(src, /setPasteText\(\(v\) => v \+ t\)/)
})
