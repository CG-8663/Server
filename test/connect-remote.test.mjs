// Remote access API v1, omarchyd side: emergency disable, the local block, the gate settings, and
// reading the website's settings once their field names are known.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createRemoteAccess, parseRemoteAccess, REMOTE_ACCESS_FIELDS} from '../omarchyd/connect-remote.mjs'

const CRED = 'b'.repeat(64)
const DEVICE = '11111111-2222-4333-8444-555555555555'
const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
// Only for these tests: a stand-in for the field names the website's contract will give.
const FIELDS = {state: 'state', configVersion: 'config_version', hostname: 'hostname', deviceId: 'device_id', dataCenterId: 'data_center_id', audience: 'access.aud', issuer: 'access.issuer', certsUrl: 'access.certs_url', connectorValidated: 'connector.validated'}

async function setup(answer, extra = {}) {
	const dir = await mkdtemp(join(os.tmpdir(), 'connect-remote-'))
	const calls = []
	let stopped = 0
	let revoked = 0
	const r = createRemoteAccess({
		dir,
		apiBase: 'https://myowndatacenter.com/api/public/cloud',
		credential: () => CRED,
		deviceId: () => DEVICE,
		onRevoked: () => revoked++,
		stopConnector: async () => stopped++,
		fetchImpl: async (url, init) => {
			calls.push({url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect})
			return answer(init)
		},
		autoStart: false,
		log: () => {},
		...extra,
	})
	await r.ready
	return {r, dir, calls, stopped: () => stopped, revoked: () => revoked, cleanup: () => (r.close(), rm(dir, {recursive: true, force: true}))}
}

test('emergency disable, confirmed by the website', async () => {
	const t = await setup(() => json(200, {state: 'disabled', verified: true}))
	try {
		assert.deepEqual(await t.r.disable(), {verified: true})
		assert.deepEqual(t.calls[0], {url: 'https://myowndatacenter.com/api/public/cloud/remote-access', method: 'POST', auth: `Bearer ${CRED}`, body: {action: 'disable'}, redirect: 'error'})
		assert.equal(t.stopped(), 0)
		assert.equal(t.r.status().blocked, null)
		assert.equal(t.r.gate().enabled, false)
	} finally {
		await t.cleanup()
	}
})

test('emergency disable not confirmed (502 disable_unverified, or offline): blocked here, connector stopped, warning, retry', async () => {
	for (const answer of [() => json(502, {error: 'disable_unverified'}), () => Promise.reject(new TypeError('fetch failed')), () => json(200, {state: 'disabled', verified: false})]) {
		const t = await setup(answer)
		try {
			assert.deepEqual(await t.r.disable(), {verified: false})
			assert.equal(t.stopped(), 1, 'the connector is stopped')
			const s = t.r.status()
			assert.ok(s.blocked)
			assert.equal(s.warning.kind, 'disable_unverified')
			assert.match(s.warning.message, /blocked remote access itself/)
			assert.equal(t.r.gate().blocked, true)
			// The block survives a restart.
			assert.ok(JSON.parse(await readFile(join(t.dir, 'remote.json'), 'utf8')).blocked)
			const again = createRemoteAccess({dir: t.dir, apiBase: 'https://myowndatacenter.com/api/public/cloud', credential: () => CRED, deviceId: () => DEVICE, autoStart: false, log: () => {}})
			await again.ready
			assert.equal(again.gate().blocked, true)
			// The owner retries the cloud-side switch-off.
			assert.equal(t.calls.filter((c) => c.method === 'POST').length, 1)
		} finally {
			await t.cleanup()
		}
	}
})

test('until the website’s field names are filled in, nothing is read and remote access stays shut', async () => {
	assert.equal(REMOTE_ACCESS_FIELDS, null)
	assert.equal(parseRemoteAccess({state: 'enabled', hostname: 'nodezero.myowndatacenter.com'}), null)
	const t = await setup(() => json(200, {state: 'enabled'}))
	try {
		await t.r.tick()
		assert.equal(t.r.status().problem, 'contract_pending')
		assert.equal(t.r.gate().enabled, false)
		assert.equal(t.r.gate().syncedAt, null)
	} finally {
		await t.cleanup()
	}
})

test('with the field names: settings are read, checked and handed to the gate; another device’s are ignored; 401 means revoked', async () => {
	const body = {state: 'enabled', config_version: 7, hostname: 'nodezero.myowndatacenter.com', device_id: DEVICE, data_center_id: 'd', access: {aud: 'a'.repeat(64), issuer: 'https://modc.cloudflareaccess.com', certs_url: 'https://modc.cloudflareaccess.com/cdn-cgi/access/certs'}, connector: {validated: true}}
	let answer = () => json(200, body)
	const t = await setup(() => answer(), {fields: FIELDS})
	try {
		await t.r.tick()
		const g = t.r.gate()
		assert.equal(g.enabled, true)
		assert.equal(g.verified, true)
		assert.equal(g.hostname, 'nodezero.myowndatacenter.com')
		assert.equal(g.audience, 'a'.repeat(64))
		assert.ok(g.syncedAt)
		assert.ok(!JSON.stringify(g).includes(CRED))
		assert.ok(!JSON.stringify(t.r.status()).includes(CRED))
		answer = () => json(200, {...body, device_id: '99999999-2222-4333-8444-555555555555', config_version: 8})
		await t.r.tick()
		assert.equal(t.r.status().problem, 'other_device')
		assert.equal(t.r.status().configVersion, 7, 'kept the last good settings')
		answer = () => json(401, {error: 'invalid_credential'})
		await t.r.tick()
		await new Promise((r) => setTimeout(r, 10))
		assert.equal(t.revoked(), 1)
	} finally {
		await t.cleanup()
	}
})
