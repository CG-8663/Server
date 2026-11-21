import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {computerSheetChanged, formatBackupHour, formatBackupStamp, formatBackupWhen, sameFolders, serverLastRun} from '../web/src/backupHelpers.ts'

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

test('#437 backup schedule times and next run use the server time zone consistently', async () => {
	const nextRunAt = Date.parse('2026-11-21T03:00:00Z')
	const nowMs = Date.parse('2026-11-20T12:00:00Z')
	const threeAm = formatBackupHour(3)

	// Browser in New York viewing a UTC server sees tomorrow at 3:00 AM (UTC), not today at 10:00 PM.
	assert.equal(formatBackupWhen(nextRunAt, 'UTC', nowMs, 'America/New_York'), `tomorrow at ${threeAm} (UTC)`)
	// Browser in the same zone as the server omits the zone suffix.
	assert.equal(formatBackupWhen(nextRunAt, 'UTC', nowMs, 'UTC'), `tomorrow at ${threeAm}`)
	// Same-day run shows "today at ...".
	assert.equal(formatBackupWhen(Date.parse('2026-11-20T22:00:00Z'), 'UTC', nowMs, 'UTC'), `today at ${formatBackupHour(22)}`)
	// Later day shows weekday in server's time zone.
	assert.equal(formatBackupWhen(Date.parse('2026-11-22T03:00:00Z'), 'UTC', nowMs, 'America/New_York'), `Sunday at ${threeAm} (UTC)`)

	// Stamps render in the server time zone and tolerate an invalid time zone without throwing.
	assert.notEqual(formatBackupStamp(nextRunAt, 'UTC'), formatBackupStamp(nextRunAt, 'America/New_York'))
	assert.doesNotThrow(() => formatBackupWhen(nextRunAt, 'Invalid/Zone', nowMs, 'UTC'))
	assert.doesNotThrow(() => formatBackupStamp(nextRunAt, 'Invalid/Zone'))

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /formatBackupWhen\(/)
	assert.match(src, /formatBackupHour\(/)
	assert.match(src, /formatBackupStamp\(/)
})

test('#600 serverLastRun prefers status.last when computer backups push server runs past the history slice', async () => {
	const srv = {id: 'srv1', endedAt: 1000, ok: true}
	const comp = {id: 'c1', computer: 'pc1', endedAt: 2000, ok: true}

	assert.equal(serverLastRun({last: srv, history: [comp]}), srv)
	assert.equal(serverLastRun({last: null, history: [comp]}), null)
	assert.equal(serverLastRun({history: [comp, srv]}), srv)
	assert.equal(serverLastRun({history: [comp]}), null)

	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /serverLastRun\(/)
})
