import assert from 'node:assert/strict'
import {afterEach, test} from 'node:test'

import {ApiError, DEFAULT_TIMEOUT_MS, SLOW_TIMEOUT_MS, getBootstrap, login, mutate, post, query} from '../web/src/api.ts'

const originalFetch = globalThis.fetch
const originalAbortTimeout = AbortSignal.timeout
const originalOnLineDesc = typeof navigator !== 'undefined' ? Object.getOwnPropertyDescriptor(navigator, 'onLine') : undefined

afterEach(() => {
	globalThis.fetch = originalFetch
	AbortSignal.timeout = originalAbortTimeout
	if (typeof navigator !== 'undefined') {
		if (originalOnLineDesc) Object.defineProperty(navigator, 'onLine', originalOnLineDesc)
		else delete navigator.onLine
	}
})

function hangingFetch(onSignal) {
	return (_input, init) =>
		new Promise((_resolve, reject) => {
			onSignal?.(init?.signal)
			if (init?.signal?.aborted) {
				reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'))
				return
			}
			init?.signal?.addEventListener(
				'abort',
				() => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError')),
				{once: true},
			)
		})
}

test('query, mutate, post, and getBootstrap time out into ApiError', async () => {
	for (const [label, fn] of [
		['query', () => query('apps.list', undefined, {timeoutMs: 25})],
		['mutate', () => mutate('apps.restart', {appId: 'immich'}, {timeoutMs: 25})],
		['post', () => post('/api/setup', {url: 'http://127.0.0.1'}, {timeoutMs: 25})],
		['login', () => login({username: 'chris', password: 'pw'})],
		['getBootstrap', () => getBootstrap({timeoutMs: 25})],
	]) {
		let seenSignal = null
		globalThis.fetch = hangingFetch((sig) => {
			seenSignal = sig
		})
		// login() uses DEFAULT_TIMEOUT_MS unless we test the fallback via a tiny AbortSignal.timeout stub.
		if (label === 'login') {
			AbortSignal.timeout = () => originalAbortTimeout(25)
		} else {
			AbortSignal.timeout = originalAbortTimeout
		}
		await assert.rejects(fn, (err) => {
			assert.ok(err instanceof ApiError, `${label}: expected ApiError`)
			assert.equal(err.code, 'TIMEOUT', label)
			assert.equal(err.status, 0, label)
			assert.match(err.message, /took too long/i, label)
			return true
		})
		assert.ok(seenSignal instanceof AbortSignal, `${label}: expected AbortSignal passed to fetch`)
		assert.equal(seenSignal.aborted, true, `${label}: signal should be aborted`)
	}
})

test('AbortController fallback triggers TIMEOUT when AbortSignal.timeout is unavailable', async () => {
	AbortSignal.timeout = undefined
	let seenSignal = null
	globalThis.fetch = hangingFetch((sig) => {
		seenSignal = sig
	})
	await assert.rejects(
		() => query('system.stats', undefined, {timeoutMs: 25}),
		(err) => err instanceof ApiError && err.code === 'TIMEOUT' && err.status === 0,
	)
	assert.ok(seenSignal?.aborted)
})

test('external AbortController abort produces ABORTED ApiError', async () => {
	const ac = new AbortController()
	globalThis.fetch = hangingFetch()
	setTimeout(() => ac.abort(), 15)
	await assert.rejects(
		() => query('apps.list', undefined, {signal: ac.signal, timeoutMs: 5000}),
		(err) => err instanceof ApiError && err.code === 'ABORTED' && err.status === 0,
	)
})

test('network failure produces NETWORK ApiError', async () => {
	globalThis.fetch = async () => {
		throw new TypeError('Failed to fetch')
	}
	await assert.rejects(
		() => mutate('apps.stop', {appId: 'immich'}),
		(err) => err instanceof ApiError && err.code === 'NETWORK' && err.status === 0,
	)
})

test('navigator.onLine === false rejects immediately with OFFLINE without calling fetch', async () => {
	let called = 0
	globalThis.fetch = async () => {
		called++
		return new Response(JSON.stringify({data: []}), {status: 200})
	}
	Object.defineProperty(navigator, 'onLine', {value: false, configurable: true})
	await assert.rejects(
		() => query('apps.list'),
		(err) => err instanceof ApiError && err.code === 'OFFLINE' && err.status === 0,
	)
	assert.equal(called, 0)
})

test('normal RPCs attach default timeout while slow RPCs allow long operations', async () => {
	assert.ok(SLOW_TIMEOUT_MS > DEFAULT_TIMEOUT_MS)
	let seenNormal = false
	let seenSlow = false
	globalThis.fetch = async (input, init) => {
		if (String(input).includes('apps.restart')) seenNormal = init.signal instanceof AbortSignal
		if (String(input).includes('backups.connectExisting')) seenSlow = init.signal instanceof AbortSignal
		return new Response(JSON.stringify({data: {ok: true}}), {status: 200})
	}
	await mutate('apps.restart', {appId: 'immich'})
	await mutate('backups.connectExisting', {})
	assert.equal(seenNormal, true)
	assert.equal(seenSlow, true)
})
