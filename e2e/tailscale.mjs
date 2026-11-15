// End to end, on a real Linux machine: the real root helper, the real Tailscale package and
// service, real omarchyd, Tailscale's real web page, and a tailnet (Headscale) with a second node
// standing in for your phone.
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync} from 'node:fs'
import http from 'node:http'
import {join} from 'node:path'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a)
const ok = (cond, what) => {
	if (!cond) throw new Error(`FAILED: ${what}`)
	log('ok ', what)
}
const sh = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
const tryCmd = (cmd, args) => {
	try {
		return {ok: true, out: sh(cmd, args)}
	} catch (e) {
		return {ok: false, out: String(e.stdout || '') + String(e.stderr || e.message)}
	}
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (what, fn, ms = 60_000) => {
	const end = Date.now() + ms
	let last
	for (;;) {
		try {
			const v = await fn()
			if (v) return v
		} catch (e) {
			last = e
		}
		if (Date.now() > end) throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ''}`)
		await wait(500)
	}
}
// Through the "phone" node's SOCKS proxy, to the server's Tailscale address.
// Asynchronous on purpose: the test servers live in this same process, so a blocking curl would stop
// them answering.
const tryAsync = (cmd, args) => new Promise((resolve) => execFile(cmd, args, {encoding: 'utf8'}, (e, out, err) => resolve(e ? {ok: false, out: String(out || '') + String(err || e.message)} : {ok: true, out})))
const viaPhone = (url) => tryAsync('curl', ['-sS', '--max-time', '8', '-o', '-', '-w', '\n%{http_code} %{redirect_url}', '--socks5-hostname', '127.0.0.1:1055', url])

const KEY = process.env.HS_KEY
const LOGIN = 'http://127.0.0.1:8080'
const ME = process.env.USER
const root = mkdtempSync('/tmp/e2e-')
const data = join(root, 'data')
const accounts = await openAccounts(data)
await accounts.createOwner({name: 'Owner', password: 'correct horse'})

let d, auth
const boot = async () => {
	d = await startOmarchyd({port: 0, dataDir: data, home: join(root, 'home'), webPort: 7790, appOptions: {defaultStores: []}, machineOptions: {run: async () => ''}})
	const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 'runner'}})})).json()
	auth = {authorization: `Bearer ${login.result.data.accessToken}`}
}
const call = async (path, input, kind = 'mutation') => {
	const url = new URL(`${d.url}/trpc/${path}`)
	const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
	if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
	else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
	const body = await (await fetch(url, init)).json()
	if (body.error) throw new Error(body.error.message)
	return body.result.data
}
const q = (p, i) => call(p, i, 'query')
const tailscaleApp = async () => (await q('apps.list')).find((a) => a.id === 'tailscale')

await boot()

// 1. In the App Store, under Omarchy Server.
const reg = await q('appStore.registry')
ok(reg[0].meta.name === 'Omarchy Server' && reg[0].apps.some((a) => a.id === 'tailscale' && a.system), 'listed under Omarchy Server')
ok(!tryCmd('dpkg', ['-s', 'tailscale']).ok, 'Tailscale isn’t installed yet')

// 2. Install: real helper, real package, real service.
await assert.rejects(call('apps.install', {appId: 'tailscale'}), /needs your permission/)
ok(true, 'refused without permission')
await call('apps.install', {appId: 'tailscale', grant: ['system-software']})
const app = await until(
	'installed',
	async () => {
		const a = await tailscaleApp()
		if (a?.state === 'unknown' && a.error) throw new Error(a.error)
		return a?.state === 'running' && a
	},
	240_000,
)
ok(tryCmd('dpkg', ['-s', 'tailscale']).ok, 'the tailscale package is installed')
ok(sh('systemctl', ['is-active', 'tailscaled']).trim() === 'active', 'tailscaled service is running')
const prefs = JSON.parse(sh('tailscale', ['debug', 'prefs']))
ok(prefs.OperatorUser === ME, `you (${ME}) are its operator`)
ok(app.version && sh('tailscale', ['version']).startsWith(app.version), `version ${app.version}`)
ok(!prefs.RouteAll && !prefs.RunSSH && !prefs.ExitNodeID, 'no routes, SSH or exit node turned on')

// 3. Its page, behind the sign-in.
await until('page ready', async () => (await q('apps.probe', {appId: 'tailscale'})).readiness === 'ready')
ok(true, 'Open is ready')
const anon = await fetch('http://127.0.0.1:8240/', {redirect: 'manual'})
ok(anon.status === 302 && /7790/.test(anon.headers.get('location')), 'its port sends strangers to sign in')
const listening = sh('ss', ['-ltnH']).split('\n').filter((l) => l.includes(`:${app.internalPort} `))
ok(listening.length > 0 && listening.every((l) => l.includes(`127.0.0.1:${app.internalPort}`)), `its private page listens on 127.0.0.1 only (${listening.map((l) => l.trim().split(/\s+/)[3]).join(', ')})`)
const {ticket} = await call('apps.accessTicket', {appId: 'tailscale'})
const enter = await fetch(`http://127.0.0.1:8240/__omarchy/enter?t=${ticket}`, {redirect: 'manual'})
const cookie = enter.headers.get('set-cookie').split(';')[0]
const html = await (await fetch('http://127.0.0.1:8240/', {headers: {cookie}})).text()
ok(/Tailscale/.test(html), 'signed in: Tailscale’s page')
const node = await (await fetch('http://127.0.0.1:8240/api/data', {headers: {cookie}})).json()
ok(node.Status === 'NeedsLogin', `it waits for you to log in (${node.Status})`)
// The Log in button, through the gateway (Tailscale's CSRF check compares Origin and Host).
// What the page's Log in button sends (client/web/src/components/views/login-view.tsx).
const up = await fetch('http://127.0.0.1:8240/api/up', {method: 'POST', headers: {cookie, origin: 'http://127.0.0.1:8240', 'content-type': 'application/json'}, body: JSON.stringify({Reauthenticate: true})})
const upText = await up.text()
log('POST /api/up through the gateway:', up.status, upText.slice(0, 300))
if (up.status !== 200) {
	const direct = await fetch(`http://127.0.0.1:${app.internalPort}/api/up`, {method: 'POST', headers: {origin: `http://127.0.0.1:${app.internalPort}`, 'content-type': 'application/json'}, body: '{}'}).then(async (r) => `${r.status} ${(await r.text()).slice(0, 300)}`, (e) => `error ${e.message}`)
	log('POST /api/up straight to its private port:', direct)
	log('app logs:\n' + (await q('apps.logs', {appId: 'tailscale'})))
}
const upBody = JSON.parse(upText)
ok(up.status === 200 && /^https:\/\/login\.tailscale\.com\//.test(upBody.url ?? ''), `Log in gives a real Tailscale sign-in link (${upBody.url})`)
const csrf = await fetch('http://127.0.0.1:8240/api/up', {method: 'POST', headers: {cookie, origin: 'http://evil.example', 'content-type': 'application/json'}, body: '{}'})
ok(csrf.status === 403, 'another site can’t press Log in for you')

// 4. Join a tailnet (Headscale here, instead of a Tailscale account), as the operator: no sudo.
log(tryCmd('tailscale', ['up', '--reset', `--operator=${ME}`, `--login-server=${LOGIN}`, `--authkey=${KEY}`, '--hostname=omarchy-e2e', '--timeout=90s']).out || '(up)')
const serverIP = await until('server tailnet address', async () => /^100\./.test(sh('tailscale', ['ip', '-4']).trim()) && sh('tailscale', ['ip', '-4']).trim(), 90_000)
ok(true, `the server joined the tailnet as ${serverIP}`)

// What the server offers: one service open to the network, one kept on localhost.
http.createServer((_q, r) => r.end('omarchy-web')).listen(7780, '0.0.0.0')
http.createServer((_q, r) => r.end('private')).listen(7781, '127.0.0.1')

// 5. The phone: a second Tailscale node (userspace, as an unprivileged user), from its own copy of
// the programs (uninstalling removes the package's).
mkdirSync('/tmp/phone', {recursive: true})
mkdirSync('/tmp/tsbin', {recursive: true})
sh('cp', [sh('sh', ['-c', 'command -v tailscaled']).trim(), sh('sh', ['-c', 'command -v tailscale']).trim(), '/tmp/tsbin/'])
const phone = spawn('/tmp/tsbin/tailscaled', ['--tun=userspace-networking', '--statedir=/tmp/phone', '--socket=/tmp/phone/sock', '--port=41642', '--socks5-server=127.0.0.1:1055'], {stdio: ['ignore', 'ignore', 'ignore']})
await until('phone daemon', async () => tryCmd('/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'status']).out.length > 0)
log(tryCmd('/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'up', `--login-server=${LOGIN}`, `--authkey=${KEY}`, '--hostname=phone', '--timeout=90s']).out || '(phone up)')
ok(true, 'the phone joined the tailnet')

let lastTry = null
const web = await until(
	'phone reaches Omarchy Server',
	async () => {
		const r = (await viaPhone(`http://${serverIP}:7780/`))
		lastTry = r
		return r.ok && r.out.startsWith('omarchy-web') && r
	},
	60_000,
).catch((error) => {
	log(`last curl: ${JSON.stringify(lastTry)}`)
	for (const [cmd, args] of [
		['/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'status']],
		['/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'ping', '--c=3', '--tsmp', serverIP]],
		['/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'netcheck']],
		['tailscale', ['status']],
		['tailscale', ['debug', 'prefs']],
		['ip', ['addr', 'show', 'tailscale0']],
		['sudo', ['iptables', '-S']],
		['sudo', ['ss', '-ltnp']],
				['curl', ['-sS', '--max-time', '8', '-v', '--socks5-hostname', '127.0.0.1:1055', `http://${serverIP}:7780/`]],
	]) { const r = tryCmd(cmd, args); log(`$ ${cmd} ${args.join(' ')}\n${r.out}${r.err ?? ''}`) }
	throw error
})
ok(true, `phone → ${serverIP}:7780 reaches Omarchy Server (${web.out.split('\n').pop()})`)
const gate = (await viaPhone(`http://${serverIP}:8240/`))
ok(gate.ok && /(^|\s)302 .*7790/.test(gate.out), `phone → an app’s port: sent to sign in first (${gate.out.split('\n').pop()})`)
const priv = (await viaPhone(`http://${serverIP}:7781/`))
ok(!priv.out.includes('private'), `phone can’t reach a service kept on localhost (${priv.out.trim().split('\n').pop()})`)
const page = (await viaPhone(`http://${serverIP}:${app.internalPort}/`))
ok(!/Tailscale/.test(page.out), `phone can’t reach Tailscale’s private page directly (${page.out.trim().split('\n').pop()})`)
log(sh('/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'status']).trim())

// 6. Stop disconnects the server; Start brings it back.
await call('apps.stop', {appId: 'tailscale'})
ok((await tailscaleApp()).state === 'stopped', 'Stop: shown as stopped')
ok(JSON.parse(sh('tailscale', ['status', '--json'])).BackendState === 'Stopped', 'Stop: Tailscale is disconnected')
await until('phone loses the server', async () => !(await viaPhone(`http://${serverIP}:7780/`)).out.startsWith('omarchy-web'), 60_000)
ok(true, 'Stop: the phone can’t reach the server')
await call('apps.start', {appId: 'tailscale'})
ok((await tailscaleApp()).state === 'running', 'Start: running')
await until('phone reaches the server again', async () => (await viaPhone(`http://${serverIP}:7780/`)).out.startsWith('omarchy-web'), 120_000)
ok(sh('tailscale', ['ip', '-4']).trim() === serverIP, 'Start: same Tailscale address, no new log in')

// 7. omarchyd restarts: its page comes back.
await d.close()
await boot()
await until('page after restart', async () => (await q('apps.probe', {appId: 'tailscale'})).readiness === 'ready', 30_000)
ok(true, 'after omarchyd restarts, Open is ready again')
ok(/Tailscale’s page/.test(await q('apps.logs', {appId: 'tailscale'})), 'logs')

// 8. Uninstall: signed out, service stopped, package removed.
await call('apps.uninstall', {appId: 'tailscale'})
ok(!(await tailscaleApp()), 'uninstalled')
ok(!tryCmd('dpkg', ['-s', 'tailscale']).ok, 'the package is removed')
ok(tryCmd('systemctl', ['is-active', 'tailscaled']).out.trim() !== 'active', 'the service is stopped')
ok(!(await fetch('http://127.0.0.1:8240/').then(() => true, () => false)), 'its port is closed')
const peers = JSON.parse(sh('/tmp/tsbin/tailscale', ['--socket=/tmp/phone/sock', 'status', '--json'])).Peer ?? {}
ok(!Object.values(peers).some((p) => p.HostName === 'omarchy-e2e' && p.Online), 'the server left the tailnet')

phone.kill()
await d.close()
log('ALL CHECKS PASSED')
process.exit(0)
