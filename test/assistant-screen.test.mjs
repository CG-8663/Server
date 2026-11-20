// Assistant screen rules: turn gating while a reply is streaming, reopening after a reload,
// minimizing on desktop, and recovering from failed approval requests.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
	canDecideAssistantAction,
	canSendAssistantMessage,
	canStartAssistantFollow,
} from '../web/src/assistantLive.ts'

test('sending is disabled while a reply is being written or an approval is running', () => {
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: false, decidingCount: 0}), true)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: true, decidingCount: 0}), false)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: false, decidingCount: 1}), false)
	assert.equal(canSendAssistantMessage({draft: '   ', itemsLoaded: true, streaming: false, decidingCount: 0}), false)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: false, streaming: false, decidingCount: 0}), false)
})

test('approve and reject wait while a reply is still streaming', () => {
	assert.equal(canDecideAssistantAction({status: 'pending', streaming: false}), true)
	assert.equal(canDecideAssistantAction({status: 'pending', streaming: true}), false)
	assert.equal(canDecideAssistantAction({status: 'running', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'done', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'rejected', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'error', streaming: false}), false)
})

test('follow-up turns wait until no reply or approval is running', () => {
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: true, streaming: false}), true)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: true, streaming: true}), false)
	assert.equal(canStartAssistantFollow({pumping: true, decidingCount: 0, followQueued: true, streaming: false}), false)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 1, followQueued: true, streaming: false}), false)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: false, streaming: false}), false)
})
