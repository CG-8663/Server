import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {computerSheetChanged, sameFolders} from '../web/src/backupHelpers.ts'

test('#162 un-ticking and re-ticking a computer folder leaves the sheet unchanged', async () => {
	const savedFolders = ['Documents', 'Pictures']
	const savedSchedule = {frequency: 'daily', hour: 1, weekday: 0}

	assert.equal(sameFolders(['Documents', 'Pictures'], savedFolders), true)
	assert.equal(sameFolders(['Pictures', 'Documents'], savedFolders), true)
	assert.equal(sameFolders(['Pictures'], savedFolders), false)
	assert.equal(sameFolders(['Documents', 'Pictures', 'Music'], savedFolders), false)

	// Un-ticking Documents marks changed; re-ticking it at the end clears changed.
	assert.equal(computerSheetChanged(['Pictures'], savedFolders, savedSchedule, savedSchedule), true)
	assert.equal(computerSheetChanged(['Pictures', 'Documents'], savedFolders, savedSchedule, savedSchedule), false)
	assert.equal(computerSheetChanged(['Pictures', 'Documents'], savedFolders, {frequency: 'daily', hour: 2, weekday: 0}, savedSchedule), true)

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /computerSheetChanged\(/)
})
