// MODC Connect: remote access (API v1). What myowndatacenter.com says about remote access to this
// server, the owner's emergency switch, and the non-secret settings the web server's gate needs.
//
//   GET  /api/public/cloud/remote-access                  the remote-access settings (every 5 minutes)
//   POST /api/public/cloud/remote-access {"action":"disable"}   emergency disable
//
// Both with the Phase 3 device credential (connect.mjs owns it). Turning remote access ON is the
// owner's, on the website: this server never asks for it on their behalf.
//
// Fails closed: until the website's settings have been read and checked, or when they're more than
// 30 minutes old, or after a local emergency block, the gate (server/remote-gate.mjs) lets nothing in.
import {join} from 'node:path'

import {plainObject, readJsonState, writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const POLL_MS = 5 * 60_000
const TROUBLE_MS = 60_000
const STALE_MS = 30 * 60_000
const TIMEOUT_MS = 20_000

// The GET answer's fields. The handoff only lists what the answer carries (state, configuration
// version, hostname, device ID, data center ID, Access audience, issuer, certificates URL, connector
// validation); their exact names come from the website's contract and go here, nowhere else. Until
// they're filled in, nothing is read and remote access stays shut.
export const REMOTE_ACCESS_FIELDS = null

// The website's answer, checked, or null when it can't be trusted.
export function parseRemoteAccess(body, fields = REMOTE_ACCESS_FIELDS) {
	if (!fields || !plainObject(body)) return null
	const get = (k) => (fields[k] ? fields[k].split('.').reduce((o, p) => (plainObject(o) ? o[p] : undefined), body) : undefined)
	const out = {
		state: get('state'),
		configVersion: get('configVersion'),
		hostname: get('hostname'),
		deviceId: get('deviceId'),
		dataCenterId: get('dataCenterId'),
		audience: get('audience'),
		issuer: get('issuer'),
		certsUrl: get('certsUrl'),
		connectorValidated: get('connectorValidated'),
	}
	if (typeof out.state !== 'string' || out.state.length > 40) return null
	if (out.hostname != null && (typeof out.hostname !== 'string' || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(out.hostname))) return null
	return out
}

export const DISABLE_WARNING =
	'myowndatacenter.com couldn’t confirm that remote access was switched off. This server has blocked remote access itself and stopped its connector, so nothing gets in. Try the cloud-side switch-off again when you can.'

export function createRemoteAccess({
	dir,
	apiBase,
	credential, // () => the device credential, or null
	deviceId, // () => this device's ID (to check the answer is about us)
	onRevoked, // the website no longer knows this device
	stopConnector, // () => Promise: stop the managed cloudflared now
	fields = REMOTE_ACCESS_FIELDS,
	fetchImpl = fetch,
	now = () => Date.now(),
	autoStart = true,
	log = (m) => console.error(m),
}) {
	const base = String(apiBase).replace(/\/+$/, '')
	if (!/^https:\/\//.test(base)) throw new Error('MODC Connect needs an https address')
	const file = join(dir, 'remote.json')
	// Saved: {settings, syncedAt, blocked: {at, reason}|null, warning: {kind, at}|null}
	let state = {settings: null, syncedAt: null, blocked: null, warning: null}
	let live = {problem: null, nextAt: null, lastTry: null}
	let timer = null
	let closed = false
	let busy = Promise.resolve()
	const serial = (fn) => {
		const run = busy.then(fn, fn)
		busy = run.catch(() => {})
		return run
	}
	const save = () => writeAtomic(file, JSON.stringify(state, null, '\t'), {mode: 0o600})
	const ready = (async () => {
		const got = await readJsonState(file, {validate: plainObject, label: 'connect', log})
		if (got.status === 'ok') state = {settings: null, syncedAt: null, blocked: null, warning: null, ...got.value}
	})()

	async function call(method, body) {
		const cred = credential()
		if (!cred) throw Object.assign(new Error('unpaired'), {unpaired: true})
		let res
		try {
			res = await fetchImpl(`${base}/remote-access`, {
				method,
				headers: {accept: 'application/json', authorization: `Bearer ${cred}`, ...(body ? {'content-type': 'application/json'} : {})},
				body: body ? JSON.stringify(body) : undefined,
				redirect: 'error',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
		} catch {
			throw Object.assign(new Error('network'), {network: true})
		}
		let parsed = null
		try {
			const t = await res.text()
			parsed = t ? JSON.parse(t) : null
		} catch {}
		const ra = Number(res.headers?.get?.('retry-after'))
		return {status: res.status, body: plainObject(parsed) ? parsed : null, error: plainObject(parsed) ? String(parsed.error ?? parsed.code ?? '') : '', retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : null}
	}

	function schedule(ms) {
		if (timer) clearTimeout(timer)
		timer = null
		live.nextAt = null
		if (closed || !credential()) return
		live.nextAt = now() + ms
		if (!autoStart) return
		timer = setTimeout(() => {
			timer = null
			serial(poll).catch(() => {})
		}, ms)
		timer.unref?.()
	}

	async function poll() {
		if (closed || !credential()) return
		live.lastTry = now()
		let r
		try {
			r = await call('GET')
		} catch (e) {
			if (e.unpaired) return
			live.problem = 'offline'
			return schedule(TROUBLE_MS)
		}
		if (r.status === 401) {
			Promise.resolve()
				.then(() => onRevoked?.())
				.catch(() => {})
			return
		}
		if (r.status === 429) {
			live.problem = 'rate_limited'
			return schedule(Math.max(TROUBLE_MS, (r.retryAfter ?? 60) * 1000))
		}
		if (r.status !== 200) {
			live.problem = r.status >= 500 ? 'unavailable' : 'error'
			return schedule(r.status >= 500 ? TROUBLE_MS : POLL_MS)
		}
		const parsed = parseRemoteAccess(r.body, fields)
		if (!parsed) {
			live.problem = fields ? 'unreadable' : 'contract_pending'
			return schedule(POLL_MS)
		}
		if (parsed.deviceId && deviceId() && parsed.deviceId !== deviceId()) {
			// About another device: never use it.
			live.problem = 'other_device'
			return schedule(POLL_MS)
		}
		const changed = state.settings?.configVersion !== parsed.configVersion
		state.settings = parsed
		state.syncedAt = now()
		live.problem = null
		await save()
		if (changed) log('[connect] remote-access settings changed')
		schedule(POLL_MS)
	}

	// The owner's emergency switch: ask the website, and whatever it says, nothing more gets in here.
	async function disable() {
		await ready
		return serial(async () => {
			let r = null
			try {
				r = await call('POST', {action: 'disable'})
			} catch (e) {
				if (e.unpaired) throw new RpcError('PRECONDITION_FAILED', 'This server isn’t connected to myowndatacenter.com')
			}
			const verified = r?.status === 200 && r.body?.state === 'disabled' && r.body?.verified === true
			if (verified) {
				state.warning = null
				state.blocked = null
				if (state.settings) state.settings = {...state.settings, state: 'disabled'}
				state.syncedAt = now()
				await save()
				log('[connect] remote access disabled (confirmed by the website)')
				return {verified: true}
			}
			// Not confirmed (502 disable_unverified, offline, anything else): block here and stop the
			// connector, so no remote request can reach this server whatever the cloud side does.
			state.blocked = {at: now(), reason: r?.error || (r ? `http_${r.status}` : 'offline')}
			state.warning = {kind: 'disable_unverified', at: now()}
			await save()
			await stopConnector?.().catch(() => log('[connect] couldn’t stop the connector'))
			log('[connect] remote access blocked on this server; the website didn’t confirm the switch-off')
			return {verified: false}
		})
	}

	// After an emergency block: the owner chooses to let remote access work again (it still has to be
	// on, and approved, on the website).
	async function allowAgain() {
		await ready
		return serial(async () => {
			state.blocked = null
			state.warning = null
			await save()
			schedule(0)
		})
	}

	// For the web server's gate: no secrets in here.
	function gate() {
		const s = state.settings
		return {
			enabled: s?.state === 'enabled',
			verified: s?.connectorValidated === true,
			blocked: !!state.blocked,
			syncedAt: state.syncedAt,
			hostname: s?.hostname ?? null,
			audience: s?.audience ?? null,
			issuer: s?.issuer ?? null,
			certsUrl: s?.certsUrl ?? null,
		}
	}

	function status() {
		const s = state.settings
		const stale = !state.syncedAt || now() - state.syncedAt > STALE_MS
		return {
			state: s?.state ?? null,
			hostname: s?.hostname ?? null,
			configVersion: s?.configVersion ?? null,
			accessProtected: !!(s?.audience && s?.issuer && s?.certsUrl),
			connectorValidated: s?.connectorValidated === true,
			syncedAt: state.syncedAt,
			stale,
			blocked: state.blocked,
			warning: state.warning ? {kind: state.warning.kind, message: DISABLE_WARNING, at: state.warning.at} : null,
			problem: live.problem,
			nextCheckAt: live.nextAt,
		}
	}

	async function teardown() {
		await ready
		return serial(async () => {
			state = {settings: null, syncedAt: null, blocked: null, warning: null}
			await save()
			if (timer) clearTimeout(timer)
			timer = null
		})
	}

	return {
		ready,
		status,
		gate,
		disable,
		allowAgain,
		teardown,
		check: async () => (await ready, serial(poll)),
		begin: async (delay = 5_000) => (await ready, schedule(delay)),
		tick: async () => (await ready, serial(poll)),
		close() {
			closed = true
			if (timer) clearTimeout(timer)
			timer = null
		},
	}
}
