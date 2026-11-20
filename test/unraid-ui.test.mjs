import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {itemStatusForView, jobSummary} from '../web/src/unraidView.ts'

test('interrupted and cancelled Unraid jobs never say Everything came over or spin forever', async () => {
	const interrupted = {
		host: 'tower.local',
		endedAt: 1000,
		stopped: 'The server restarted.',
		items: [
			{kind: 'share', key: 'Docs', name: 'Docs', size: 10, status: 'done'},
			{kind: 'share', key: 'Media', name: 'Media', size: 20, status: 'skipped'},
		],
	}
	assert.deepEqual(jobSummary(interrupted, false), {
		running: false,
		done: 1,
		failed: 0,
		incomplete: true,
		heading: '1 of 2 came over',
		canRetry: false,
	})
	assert.equal(jobSummary(interrupted, true).canRetry, true)

	const cancelled = {
		host: 'tower.local',
		endedAt: 1000,
		cancelled: true,
		items: [
			{kind: 'share', key: 'Docs', name: 'Docs', size: 10, status: 'done'},
			{kind: 'share', key: 'Media', name: 'Media', size: 20, status: 'skipped'},
		],
	}
	assert.equal(jobSummary(cancelled, false).incomplete, true)
	assert.equal(jobSummary(cancelled, false).heading, '1 of 2 came over')

	const emptyStopped = {host: 'tower.local', endedAt: 1000, stopped: 'The server restarted.', items: []}
	assert.equal(jobSummary(emptyStopped, false).incomplete, true)
	assert.equal(jobSummary(emptyStopped, false).heading, 'Move stopped')

	const done = {
		host: 'tower.local',
		endedAt: 1000,
		items: [
			{kind: 'share', key: 'Docs', name: 'Docs', size: 10, status: 'done'},
			{kind: 'share', key: 'Media', name: 'Media', size: 20, status: 'done'},
		],
	}
	assert.deepEqual(jobSummary(done, false), {
		running: false,
		done: 2,
		failed: 0,
		incomplete: false,
		heading: 'Everything came over',
		canRetry: false,
	})

	assert.equal(itemStatusForView({status: 'running'}, false), 'failed')
	assert.equal(itemStatusForView({status: 'waiting'}, false), 'skipped')
	assert.equal(itemStatusForView({status: 'running'}, true), 'running')
	assert.equal(itemStatusForView({status: 'waiting'}, true), 'waiting')

	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.match(src, /from '\.\/unraidView'/)
	assert.match(src, /jobSummary\(/)
	assert.match(src, /itemStatusForView\(/)
})
