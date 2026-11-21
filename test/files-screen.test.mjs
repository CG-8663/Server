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
describe('files screen: #113 favorites preserve FileEntry metadata', () => {
	test('favoritePath extracts path from both FileEntry objects and strings', () => {
		assert.equal(helpers.favoritePath('/Home/Docs'), '/Home/Docs')
		assert.equal(
			helpers.favoritePath({
				name: 'a.pdf',
				path: '/Home/a.pdf',
				type: 'application/pdf',
				size: 123,
				modified: 1000,
				operations: ['favorite'],
			}),
			'/Home/a.pdf',
		)
	})

	test('Files.tsx queries FavoriteItem[] and keeps FileEntry objects in ::favorites', async () => {
		const src = await filesSource()
		assert.match(src, /query<FavoriteItem\[\]>\("files\.favorites"\)/)
		assert.match(src, /favSet = useMemo\(\(\) => new Set\(\(favorites\.data \?\? \[\]\)\.map\(favoritePath\)\), \[favorites\.data\]\)/)
		assert.match(src, /typeof p === "string" \? \{/)
	})
})

describe('files screen: #189 Enter key on row action buttons', () => {
	test('shouldActivateRowOnKey only activates when Enter originates on the row itself', () => {
		const row = {}
		const childBtn = {}
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: row, currentTarget: row}), true)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Enter', target: childBtn, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: ' ', target: row, currentTarget: row}), false)
		assert.equal(helpers.shouldActivateRowOnKey({key: 'Escape', target: row, currentTarget: row}), false)
	})

	test('Files.tsx guards row onKeyDown with shouldActivateRowOnKey', async () => {
		const src = await filesSource()
		assert.match(src, /onKeyDown=\{\(e\) => shouldActivateRowOnKey\(e\) && activate\(f\)\}/)
	})
})

describe('files screen: #195 ShareSheet access radios stay mounted and grouped', () => {
	test('ShareAccessChoice lives at module scope with a shared radio name from useId()', async () => {
		const src = await filesSource()
		const shareStart = src.indexOf('export function ShareSheet(')
		assert.ok(shareStart > 0)
		const beforeShare = src.slice(0, shareStart)
		const insideShare = src.slice(shareStart)

		assert.match(beforeShare, /function ShareAccessChoice\(/)
		assert.match(beforeShare, /<input type="radio" name=\{name\}/)
		assert.doesNotMatch(insideShare, /const Choice\s*=/)
		assert.match(insideShare, /const accessRadioName = useId\(\)/)
		const matches = insideShare.match(/<ShareAccessChoice[\s\S]*?name=\{accessRadioName\}/g) ?? []
		assert.equal(matches.length, 2)
	})
})
