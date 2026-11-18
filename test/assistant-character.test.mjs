// The assistant's character: which state it shows for what the assistant is doing, and the registry
// contributors add characters to. (The drawings themselves are checked in a browser.)
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {characterState, SLEEP_MS, SUCCESS_MS} from '../web/src/assistantActivity.ts'

const base = {phase: 'idle', pending: 0, composing: false, successAt: 0, activeAt: 1_000_000, open: true}
const at = (patch, opts = {}) => characterState({...base, ...patch}, {now: 1_000_000, ...opts})

test('the character shows what the assistant is actually doing, most important first', () => {
	assert.equal(at({}), 'idle')
	assert.equal(at({}, {hover: true}), 'hover')
	assert.equal(at({composing: true}), 'listening')
	assert.equal(at({phase: 'thinking'}), 'thinking')
	assert.equal(at({phase: 'responding'}), 'responding')
	assert.equal(at({phase: 'working'}), 'working')
	assert.equal(at({phase: 'error'}), 'error')
	// A problem outranks everything; work in progress outranks typing or hovering.
	assert.equal(at({phase: 'error', composing: true, successAt: 1_000_000}), 'error')
	assert.equal(at({phase: 'working', composing: true}, {hover: true}), 'working')
})

test('“done” only for a moment after a confirmed step; sleeping only after a long quiet spell', () => {
	assert.equal(at({successAt: 1_000_000 - 100}), 'success')
	assert.equal(at({successAt: 1_000_000 - SUCCESS_MS - 1}), 'idle')
	assert.equal(at({successAt: 0}), 'idle', 'never assumed')
	const quiet = {open: false, activeAt: 1_000_000 - SLEEP_MS - 1}
	assert.equal(at(quiet), 'sleeping')
	assert.equal(at({...quiet, open: true}), 'idle', 'not while the assistant is open')
	assert.equal(at({...quiet, pending: 1}), 'idle', 'not with a step waiting for you')
	assert.equal(at({...quiet}, {hover: true}), 'hover')
})

test('reactions off: the character stays idle (and still says hello on hover)', () => {
	assert.equal(at({phase: 'working'}, {reactions: false}), 'idle')
	assert.equal(at({phase: 'error'}, {reactions: false, hover: true}), 'hover')
})

test('the registry: six characters, Oma first and the default, each complete and unique', async () => {
	const src = await readFile(new URL('../web/src/character/registry.tsx', import.meta.url), 'utf8')
	const ids = [...src.matchAll(/^\t\tid: '([a-z0-9-]+)',$/gm)].map((m) => m[1])
	assert.deepEqual(ids, ['oma', 'patch', 'pixel', 'stack', 'pulse', 'orbit'])
	assert.match(src, /export const DEFAULT_CHARACTER = 'oma'/)
	for (const field of ['name', 'tagline', 'description', 'colors', 'theme', 'face', 'states', 'back']) {
		assert.equal([...src.matchAll(new RegExp(`^\\t\\t${field}: `, 'gm'))].length, ids.length, `every character has ${field}`)
	}
	// Bundled drawings only: nothing fetched from elsewhere.
	assert.doesNotMatch(src, /https?:\/\//)
	const comp = await readFile(new URL('../web/src/character/AssistantCharacter.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(comp, /https?:\/\/|fetch\(/)
})
