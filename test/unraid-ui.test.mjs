import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {defaultSelectedVms, formatBytes, formatTotalSize, isKeyChangedError, itemStatusForView, jobSummary, retryActionState} from '../web/src/unraidView.ts'

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

test('connect form shows a Forget this server’s key button for host key changes', async () => {
	assert.equal(isKeyChangedError('That server isn’t the one you connected to before (its key changed). If you reinstalled Unraid, choose Forget this server’s key and connect again.'), true)
	assert.equal(isKeyChangedError(null), false)
	assert.equal(isKeyChangedError('Unraid didn’t accept that password'), false)
	assert.equal(isKeyChangedError('Couldn’t reach that server.'), false)

	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.match(src, /isKeyChangedError\(/)
	assert.match(src, /mutate\('unraid\.forgetHost'/)
	assert.match(src, /Forget this server’s key/)
})

test('JobView shows retry scan progress and errors when Try the rest again runs', async () => {
	assert.deepEqual(retryActionState(false), {disabled: false, label: 'Try the rest again', showSpinner: false})
	assert.deepEqual(retryActionState(true), {disabled: true, label: 'Looking…', showSpinner: true})

	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.match(src, /scanning=\{scanning\}/)
	assert.match(src, /error=\{error\}/)
	assert.match(src, /retryActionState\(scanning\)/)
	const jobViewSrc = src.slice(src.indexOf('function JobView'))
	assert.match(jobViewSrc, /error && <p className="bk-err">\{error\}<\/p>/)
})

test('installed VMs are deselected by default and disabled in Choose', async () => {
	assert.deepEqual(
		defaultSelectedVms([
			{name: 'Win11', state: 'shut off', problems: [], installed: true},
			{name: 'Ubuntu', state: 'shut off', problems: [], installed: false},
			{name: 'Running', state: 'running', problems: [], installed: false},
			{name: 'NoDisk', state: 'shut off', problems: ['It has no disk image to copy']},
		]),
		['Ubuntu'],
	)
	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.match(src, /defaultSelectedVms\(scan\.vms\)/)
	assert.match(src, /disabled=\{\!\!v\.installed \|\| \!\!v\.problems\.length\}/)
	assert.match(src, /v\.installed \? 'Already here'/)
})

test('unknown container sizes format as size unknown and mark totals as a minimum', async () => {
	assert.equal(formatBytes(null), 'size unknown')
	assert.equal(formatBytes(0), '0 B')
	assert.equal(formatBytes(1024), '1.0 KB')
	assert.equal(formatTotalSize([null]), 'size unknown')
	assert.equal(formatTotalSize([0, null]), 'size unknown')
	assert.equal(formatTotalSize([2 * 1024 ** 3, null]), 'at least 2.0 GB')
	assert.equal(formatTotalSize([2 * 1024 ** 3, 1024 ** 3]), '3.0 GB')
	assert.equal(formatTotalSize([]), '0 B')

	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.match(src, /formatBytes\(/)
	assert.match(src, /formatTotalSize\(/)
})
