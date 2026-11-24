import assert from 'node:assert/strict'
import {test} from 'node:test'

import {gaugeCaption, nextStatView, readingFace, statReadings, statViewOf} from '../web/src/fleet/statView.ts'

test('stat view cycles one line, three lines, then gauges', () => {
	assert.equal(statViewOf(undefined), 'line')
	assert.equal(statViewOf(null), 'line')
	assert.equal(statViewOf('dials'), 'line')
	assert.equal(nextStatView('line'), 'blocks')
	assert.equal(nextStatView('blocks'), 'gauges')
	assert.equal(nextStatView('gauges'), 'line')
	assert.equal(nextStatView(statViewOf('nope')), 'blocks')
})

test('every view is given the same readings, including temperature and a size-only disk', () => {
	const readings = statReadings({
		gauges: [
			{k: 'CPU', icon: 'cpu', p: 12.4, ready: true, sub: '12%'},
			{k: 'Memory', icon: 'memory', p: 40, ready: true, sub: '1 GB of 4 GB'},
			{k: 'GPU', icon: 'gpu', p: 0, ready: false, key: 'gpu0', sub: '–'},
			{k: 'Battery', icon: 'battery', p: 80, ready: true, sub: '80%', color: 'var(--green)'},
		],
		temp: 61.2,
		diskSizeGb: 120,
	})
	assert.deepEqual(
		readings.map((r) => r.id),
		['CPU', 'Memory', 'gpu0', 'Battery', 'disk-size', 'temp'],
	)
	assert.deepEqual(
		readings.map((r) => r.text),
		['12%', '40%', '–', '80%', '? of 120 GB', '61°C'],
	)
	// The list does not depend on which drawing is showing. Faces only choose an arc or the value.
	assert.deepEqual(readings.map(readingFace), ['arc', 'arc', 'value', 'arc', 'value', 'value'])
	assert.equal(gaugeCaption(readings[0]), null)
	assert.equal(gaugeCaption(readings[1]), '1 GB of 4 GB')
	assert.equal(gaugeCaption(readings.find((r) => r.id === 'temp')), null)
	assert.equal(readings.find((r) => r.id === 'Battery').color, 'var(--green)')
})

test('a storage gauge already covers the disk, so the size-only reading is not added', () => {
	const readings = statReadings({
		gauges: [{k: 'Storage', icon: 'disk', p: 50, ready: true, sub: '1 GB of 2 GB'}],
		temp: null,
		diskSizeGb: 120,
	})
	assert.deepEqual(
		readings.map((r) => r.id),
		['Storage'],
	)
	assert.equal(readingFace(readings[0]), 'arc')
	assert.equal(gaugeCaption(readings[0]), '1 GB of 2 GB')
})
