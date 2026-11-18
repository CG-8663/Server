// Live assistant turn: working/typing mark in the bubble, keep the stream if the window closes,
// unread count on the character.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {assistantIconBadge, liveBubbleMark} from '../web/src/assistantLive.ts'
import {
	abortAssistantTurn,
	assistantTurn,
	beginAssistantTurn,
	closeAssistantView,
	finishAssistantTurn,
	keepAssistantWindow,
	openAssistantView,
	resetAssistantTurn,
} from '../web/src/assistantTurn.ts'

test('an empty live bubble shows a spinner; tokens switch it to an ellipsis', () => {
	assert.equal(liveBubbleMark({streaming: true, content: ''}), 'spinner')
	assert.equal(liveBubbleMark({streaming: true, content: '', activity: 'Checked disk'}), 'spinner')
	assert.equal(liveBubbleMark({streaming: true, content: 'Hello'}), 'ellipsis')
	assert.equal(liveBubbleMark({streaming: false, content: 'Hello'}), null)
	assert.equal(liveBubbleMark({streaming: false, content: ''}), null)
})

test('the character badge is the unread count, then pending Approves, and hidden at zero', () => {
	assert.equal(assistantIconBadge({unread: 0, pending: 0, phase: 'idle'}), null)
	assert.deepEqual(assistantIconBadge({unread: 3, pending: 1, phase: 'idle'}), {count: 3})
	assert.deepEqual(assistantIconBadge({unread: 0, pending: 2, phase: 'idle'}), {count: 2})
	assert.deepEqual(assistantIconBadge({unread: 0, pending: 0, phase: 'error'}), {warn: true})
})

test('closing the assistant view does not abort the in-flight turn', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	closeAssistantView()
	assert.equal(ac.signal.aborted, false)
	assert.equal(assistantTurn().open, false)
	assert.equal(assistantTurn().streaming, true)
})

test('Super+W keeps the assistant window mounted while it is still working', () => {
	resetAssistantTurn()
	assert.equal(keepAssistantWindow('assistant'), false)
	const ac = new AbortController()
	beginAssistantTurn(ac)
	assert.equal(keepAssistantWindow('assistant'), true)
	assert.equal(keepAssistantWindow('files'), false)
	closeAssistantView()
	assert.equal(keepAssistantWindow('assistant'), true)
	finishAssistantTurn(ac)
	assert.equal(keepAssistantWindow('assistant'), false)
})

test('a reply that finishes while closed counts as unread until the chat is opened', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	closeAssistantView()
	finishAssistantTurn()
	assert.equal(assistantTurn().unread, 1)
	assert.equal(assistantTurn().streaming, false)
	openAssistantView()
	assert.equal(assistantTurn().unread, 0)
	assert.equal(assistantTurn().open, true)
})

test('New session aborts the in-flight turn', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	abortAssistantTurn()
	assert.equal(ac.signal.aborted, true)
	assert.equal(assistantTurn().streaming, false)
})

test('finishing a superseded turn does not count as unread', () => {
	resetAssistantTurn()
	const first = new AbortController()
	beginAssistantTurn(first)
	closeAssistantView()
	const second = new AbortController()
	beginAssistantTurn(second)
	finishAssistantTurn(first)
	assert.equal(assistantTurn().streaming, true)
	assert.equal(assistantTurn().unread, 0)
	assert.equal(second.signal.aborted, false)
	finishAssistantTurn(second)
	assert.equal(assistantTurn().streaming, false)
	assert.equal(assistantTurn().unread, 1)
})
