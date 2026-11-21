// Files screen helpers: name prompts, keyboard/drag guards,
// upload folder walking, favorites paths, photo sync matching, and readable kind labels.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import * as helpers from '../web/src/filesHelpers.ts'

const filesSource = () => readFile(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')

describe('files screen: #441 new folder NamePrompt submit state', () => {
	test('allows submitting suggested New folder name without editing when requireChange is false', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'New folder', initial: 'New folder', requireChange: false, busy: false}),
			true,
		)
	})

	test('requires a changed trimmed name when requireChange is true', () => {
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: ' notes.txt ', initial: 'notes.txt', requireChange: true, busy: false}),
			false,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes2.txt', initial: 'notes.txt', requireChange: true, busy: false}),
			true,
		)
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'notes.txt', initial: ' notes.txt ', requireChange: true, busy: false}),
			true,
		)
	})

	test('rejects invalid names and busy submissions', () => {
		for (const bad of ['', '   ', 'a/b', '.', '..']) {
			assert.equal(
				helpers.canSubmitNamePrompt({name: bad, initial: 'New folder', requireChange: false, busy: false}),
				false,
				bad,
			)
		}
		assert.equal(
			helpers.canSubmitNamePrompt({name: 'Docs', initial: 'New folder', requireChange: false, busy: true}),
			false,
		)
	})

	test('Files.tsx passes requireChange only for rename and uses canSubmitNamePrompt', async () => {
		const src = await filesSource()
		assert.match(src, /requireChange=\{prompt\.kind === "rename"\}/)
		assert.match(src, /canSubmitNamePrompt\(\{ name, initial, requireChange, busy \}\)/)
		assert.doesNotMatch(src, /disabled=\{!valid \|\| busy \|\| name === initial\}/)
	})
})
