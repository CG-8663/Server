// Assistant screen rules: turn gating while a reply is streaming, reopening after a reload,
// minimizing on desktop, and recovering from failed approval requests.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {consumeReopenAssistant, markReopenAssistant} from '../web/src/assistant.ts'
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

function stubStorage() {
	const map = new Map()
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => void map.set(k, String(v)),
		removeItem: (k) => void map.delete(k),
	}
}

test('reopen-assistant flag survives re-renders before reload and is consumed once on reload', async () => {
	const prevLocal = globalThis.localStorage
	const prevSession = globalThis.sessionStorage
	globalThis.localStorage = stubStorage()
	globalThis.sessionStorage = stubStorage()
	try {
		// Initial page load consumes once into a lazy ref.
		const ref = {current: null}
		const readLazy = () => {
			if (ref.current === null) ref.current = consumeReopenAssistant()
			return ref.current
		}
		assert.equal(readLazy(), false)

		// Approving a wallpaper marks the flag and triggers an App re-render before reload.
		markReopenAssistant()
		assert.equal(readLazy(), false)

		// After reload, the next fresh load sees the flag once and clears it.
		assert.equal(consumeReopenAssistant(), true)
		assert.equal(consumeReopenAssistant(), false)
	} finally {
		globalThis.localStorage = prevLocal
		globalThis.sessionStorage = prevSession
	}

	const appSrc = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
	assert.equal(appSrc.includes('useRef(consumeReopenAssistant())'), false, 'App must not consume the flag on every render')
})
