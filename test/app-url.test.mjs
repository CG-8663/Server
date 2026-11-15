// The address an app opens at (web/src/appUrl.ts), for each kind of app and each way of reaching
// the web app. The TypeScript is compiled here with esbuild (already installed for the build).
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {transform} from 'esbuild'

const source = await readFile(new URL('../web/src/appUrl.ts', import.meta.url), 'utf8')
const {code} = await transform(source, {loader: 'ts', format: 'esm'})
const {appUrl} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const behindGateway = {port: 3003, internalPort: 21000, path: ''}
const ownPort = {port: 8123, viewPort: 7942, path: ''} // host network: holds 8123 itself, plain http

test('an app behind its gateway: same port, http or https to match the page', () => {
	assert.equal(appUrl(behindGateway, '192.168.1.5', false), 'http://192.168.1.5:3003/')
	assert.equal(appUrl(behindGateway, '192.168.1.5', true), 'https://192.168.1.5:3003/')
	assert.equal(appUrl(behindGateway, 'omarchy.local', true), 'https://omarchy.local:3003/')
})

test('an app that needs a secure page gets https even from an http page', () => {
	assert.equal(appUrl({...behindGateway, requiresHttps: true}, '192.168.1.5', false), 'https://192.168.1.5:3003/')
})

test('an app holding its own port: straight there over http, through its view gateway when https is needed', () => {
	assert.equal(appUrl(ownPort, '192.168.1.5', false), 'http://192.168.1.5:8123/')
	// https://…:8123 could never work: the app speaks plain http on its own port.
	assert.equal(appUrl(ownPort, '192.168.1.5', true), 'https://192.168.1.5:7942/')
	assert.equal(appUrl({...ownPort, requiresHttps: true}, '192.168.1.5', false), 'https://192.168.1.5:7942/')
})

test('paths and apps without a web page', () => {
	assert.equal(appUrl({...behindGateway, path: '/admin'}, 'h', false), 'http://h:3003/admin')
	assert.equal(appUrl({port: null}, 'h', false), null)
	assert.equal(appUrl({}, 'h', true), null)
})
