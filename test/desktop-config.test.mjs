// Signing out must drop the desktop that lived in this tab, including a save already on the wire.
import assert from 'node:assert/strict'
import {test} from 'node:test'

const bag = new Map()
globalThis.localStorage = {
	getItem: (k) => (bag.has(k) ? bag.get(k) : null),
	setItem: (k, v) => bag.set(k, String(v)),
	removeItem: (k) => bag.delete(k),
}
globalThis.window = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
	addEventListener: () => {},
	setInterval: () => 0,
}
globalThis.document = {
	addEventListener: () => {},
	visibilityState: 'visible',
}

const posts = []
let fetchImpl = async () => ({ok: true, json: async () => ({desktop: null})})
globalThis.fetch = (url, opts) => fetchImpl(url, opts)

const KEY = 'omarchy-server:desktop-config'
const REV = `${KEY}:rev`
const DIRTY = `${KEY}:dirty`

const {patchDeskConfig, resetDeskConfig, syncDeskConfig} = await import('../web/src/desktop/config.ts')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the next account does not inherit this tab’s desktop', async () => {
	assert.equal(typeof resetDeskConfig, 'function', 'resetDeskConfig is not exported')

	patchDeskConfig({wallpaper: 'valley', dock: {position: 'bottom'}})
	assert.match(localStorage.getItem(KEY), /"bottom"/)
	localStorage.setItem(REV, '3')
	localStorage.setItem(DIRTY, '1')
	resetDeskConfig()
	assert.equal(localStorage.getItem(KEY), null)
	assert.equal(localStorage.getItem(REV), null)
	assert.equal(localStorage.getItem(DIRTY), null)

	posts.length = 0
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return {ok: true, json: async () => ({desktop: {rev: 1}})}
		}
		return {ok: true, json: async () => ({desktop: null})}
	}
	syncDeskConfig()
	await wait(800)
	const posted = posts.join('\n')
	assert.equal(posted.includes('"bottom"'), false, 'push still has the previous dock')
	assert.equal(posted.includes('valley'), false, 'push still has the previous wallpaper')

	patchDeskConfig({wallpaper: 'valley', dock: {position: 'bottom'}})
	localStorage.setItem(REV, '3')
	resetDeskConfig()
	posts.length = 0
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return {ok: true, json: async () => ({desktop: {rev: 4}})}
		}
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'surf', dock: {position: 'top'}}, rev: 3}})}
	}
	syncDeskConfig()
	await wait(50)
	const saved = JSON.parse(localStorage.getItem(KEY))
	assert.equal(saved.wallpaper, 'surf')
	assert.equal(saved.dock.position, 'top')
	assert.equal(localStorage.getItem(REV), '3')
	const again = posts.join('\n')
	assert.equal(again.includes('valley'), false, 'posted the previous wallpaper')
	assert.equal(again.includes('"bottom"'), false, 'posted the previous dock')

	let release
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return new Promise((resolve) => {
				release = () => resolve({ok: true, json: async () => ({desktop: {rev: 9}})})
			})
		}
		return {ok: true, json: async () => ({desktop: null})}
	}
	patchDeskConfig({wallpaper: 'dunes', dock: {position: 'right'}})
	await wait(700)
	assert.equal(typeof release, 'function', 'the push never left')
	resetDeskConfig()
	release()
	await wait(0)
	assert.equal(localStorage.getItem(REV), null, 'a late save wrote the previous rev')
})
