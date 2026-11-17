import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {flipSplit, focusDir, insert, isNode, rebuild, reconcile, rects, remove, swapDir} from '../web/src/desktop/hyprland/layout.ts'

const area = {x: 0, y: 0, w: 1000, h: 800}

describe('hyprland layout', () => {
	test('empty insert is a single leaf filling the area', () => {
		const tree = insert(null, null, 'a', area)
		assert.deepEqual(tree, {kind: 'leaf', id: 'a'})
		assert.deepEqual(rects(tree, area, 0), {a: area})
	})

	test('second window splits the longer axis', () => {
		const t1 = insert(null, null, 'a', area)
		const t2 = insert(t1, 'a', 'b', area, 0)
		assert.equal(t2.kind, 'split')
		assert.equal(t2.axis, 'h')
		const r = rects(t2, area, 0)
		assert.equal(r.a.w, 500)
		assert.equal(r.b.w, 500)
		assert.equal(r.a.x, 0)
		assert.equal(r.b.x, 500)
	})

	test('close leaves the sibling filling the space', () => {
		const t = insert(insert(null, null, 'a', area), 'a', 'b', area, 0)
		const left = remove(t, 'b')
		assert.deepEqual(left, {kind: 'leaf', id: 'a'})
		assert.equal(remove(left, 'a'), null)
	})

	test('focus and swap by direction', () => {
		const t = insert(insert(null, null, 'a', area), 'a', 'b', area, 0)
		assert.equal(focusDir(t, 'a', 'right', area, 0), 'b')
		assert.equal(focusDir(t, 'a', 'left', area, 0), 'a')
		const swapped = swapDir(t, 'a', 'right', area, 0)
		const r = rects(swapped, area, 0)
		assert.equal(r.b.x, 0)
		assert.equal(r.a.x, 500)
	})

	test('rebuild recovers from a broken tree', () => {
		const t = rebuild(['a', 'b', 'c'], area, 0)
		assert.ok(t)
		assert.deepEqual(Object.keys(rects(t, area, 0)).sort(), ['a', 'b', 'c'])
	})

	test('float remove then reinsert is insert at the focused leaf', () => {
		let t = insert(insert(null, null, 'a', area), 'a', 'b', area, 0)
		t = remove(t, 'b')
		t = insert(t, 'a', 'b', area, 0)
		assert.ok(rects(t, area, 0).a)
		assert.ok(rects(t, area, 0).b)
	})

	test('flipSplit toggles the parent axis', () => {
		const t = insert(insert(null, null, 'a', area), 'a', 'b', area, 0)
		assert.equal(t.axis, 'h')
		assert.equal(flipSplit(t, 'a').axis, 'v')
	})

	test('isNode rejects corrupt trees', () => {
		assert.equal(isNode({kind: 'leaf', id: 'a'}), true)
		assert.equal(isNode({kind: 'split', axis: 'h', ratio: 0.5, a: {kind: 'leaf', id: 'a'}, b: {kind: 'leaf', id: 'b'}}), true)
		assert.equal(isNode({kind: 'split', axis: 'h'}), false)
		assert.equal(isNode({foo: 1}), false)
	})

	test('reconcile drops unknown ids and inserts missing ones', () => {
		const stale = insert(insert(null, null, 'gone', area), 'gone', 'a', area, 0)
		const next = reconcile(stale, ['a', 'b'], area, 0)
		assert.deepEqual(Object.keys(rects(next, area, 0)).sort(), ['a', 'b'])
	})

	test('reconcile rebuilds a corrupt tree', () => {
		const next = reconcile({kind: 'split'}, ['a', 'b'], area, 0)
		assert.deepEqual(Object.keys(rects(next, area, 0)).sort(), ['a', 'b'])
	})
})
