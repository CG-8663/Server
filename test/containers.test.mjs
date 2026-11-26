// Containers (LXC through per-user Incus): the library, the list, and what reaches `incus`.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {containerFrom, createContainers, libraryFrom, setupCommand} from '../omarchyd/containers.mjs'

const img = (os, release, alias, {arch = 'x86_64', type = 'container', variant = 'default'} = {}) => ({
	type,
	size: 120e6,
	aliases: [{name: alias}, {name: `${alias}/default`}, {name: `${alias}/default/amd64`}],
	properties: {os, release, variant, architecture: arch, description: `${os} ${release}`},
})

test('the library keeps the listed systems for this architecture, newest first, containers only', () => {
	const lib = libraryFrom(
		[
			img('Debian', '12', 'debian/12'),
			img('Debian', '13', 'debian/13'),
			img('Debian', '11', 'debian/11'),
			img('Debian', '12', 'debian/12', {arch: 'aarch64'}),
			img('Debian', '12', 'debian/12/cloud', {variant: 'cloud'}),
			img('Ubuntu', '24.04', 'ubuntu/24.04', {type: 'virtual-machine'}),
			img('Alpine', 'edge', 'alpine/edge'),
			img('Alpine', '3.21', 'alpine/3.21'),
			img('Gentoo', 'current', 'gentoo/current'),
		],
		'x86_64',
	)
	assert.deepEqual(
		lib.map((d) => d.os),
		['debian', 'alpine'],
		'Gentoo is not offered; the Ubuntu entry was a VM image',
	)
	assert.deepEqual(
		lib[0].releases.map((r) => r.alias),
		['debian/13', 'debian/12', 'debian/11'],
	)
	assert.deepEqual(
		lib[1].releases.map((r) => r.alias),
		['alpine/3.21', 'alpine/edge'],
	)
})

test('a container from incus list: addresses, opened ports, limits and snapshots', () => {
	const c = containerFrom({
		name: 'web',
		type: 'container',
		status: 'Running',
		config: {'image.os': 'Debian', 'image.release': 'bookworm', 'limits.cpu': '2', 'limits.memory': '1024MiB'},
		devices: {'port-tcp-8080': {type: 'proxy', listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:80'}, other: {type: 'disk'}},
		expanded_devices: {root: {type: 'disk', path: '/', size: '8GiB'}},
		state: {memory: {usage: 512 * 1024 ** 2}, network: {lo: {addresses: [{family: 'inet', address: '127.0.0.1', scope: 'local'}]}, eth0: {addresses: [{family: 'inet', address: '10.20.30.4', scope: 'global'}, {family: 'inet6', address: 'fe80::1', scope: 'link'}]}}},
		snapshots: [{name: 'web/before', created_at: '2026-11-26T10:00:00Z'}],
	})
	assert.equal(c.status, 'running')
	assert.equal(c.cpus, 2)
	assert.equal(c.memory, '1024MiB')
	assert.equal(c.disk, '8GiB')
	assert.equal(c.memoryUsedGiB, 0.5)
	assert.deepEqual(c.addresses, [{family: 'IPv4', address: '10.20.30.4'}])
	assert.deepEqual(c.ports, [{protocol: 'tcp', hostPort: 8080, containerPort: 80}])
	assert.deepEqual(c.snapshots, [{name: 'before', createdAt: '2026-11-26T10:00:00Z'}])
})

function fakeIncus({list = [], images = [img('Debian', '12', 'debian/12')], fail = null} = {}) {
	const calls = []
	const run = async (args) => {
		calls.push(args)
		if (fail && fail(args)) throw Object.assign(new Error('Command failed'), {stderr: 'Error: Not allowed by project restrictions'})
		if (args[0] === 'list') return JSON.stringify(list)
		if (args[0] === 'image') return JSON.stringify(images)
		if (args[0] === 'info') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		return ''
	}
	return {run, calls}
}

test('create launches the picked system with its limits, and refuses bad names and systems not in the library', async () => {
	const f = fakeIncus()
	const ct = createContainers({run: f.run})
	const p = ct.procedures
	await assert.rejects(p['containers.create'].run({name: 'Bad Name', image: 'debian/12'}), /lowercase/)
	await assert.rejects(p['containers.create'].run({name: 'web', image: 'evil/latest'}), /isn’t in the library/)
	await assert.rejects(p['containers.create'].run({name: 'web', image: 'debian/12; rm -rf /'}), /Pick a system/)
	assert.deepEqual(await p['containers.create'].run({name: 'web', image: 'debian/12', cpus: 1, memoryMiB: 512, diskGiB: 4}), {name: 'web'})
	await new Promise((r) => setTimeout(r, 10))
	assert.deepEqual(
		f.calls.find((a) => a[0] === 'launch'),
		['launch', 'images:debian/12', 'web', '--config', 'limits.cpu=1', '--config', 'limits.memory=512MiB', '--device', 'root,size=4GiB'],
	)
})

test('a container that is still being created shows in the list, and a failed one shows why', async () => {
	let finish
	const f = fakeIncus()
	const run = async (args) => (args[0] === 'launch' ? new Promise((_r, reject) => (finish = () => reject(Object.assign(new Error('x'), {stderr: 'Error: Failed instance creation: no space left'})))) : f.run(args))
	const p = createContainers({run}).procedures
	await p['containers.create'].run({name: 'db', image: 'debian/12'})
	assert.equal((await p['containers.list'].run()).find((c) => c.name === 'db').status, 'creating')
	finish()
	await new Promise((r) => setTimeout(r, 10))
	const failed = (await p['containers.list'].run()).find((c) => c.name === 'db')
	assert.equal(failed.status, 'error')
	assert.match(failed.error, /no space left/)
	await p['containers.delete'].run({name: 'db'})
	assert.equal((await p['containers.list'].run()).length, 0, 'deleting a failed creation just clears it')
})

test('ports: 1024 and up, never this server’s own, never twice; added as an Incus proxy device', async () => {
	const f = fakeIncus({list: [{name: 'a', type: 'container', status: 'Running', devices: {'port-tcp-9000': {type: 'proxy', connect: 'tcp:127.0.0.1:9000'}}}, {name: 'b', type: 'container', status: 'Running'}]})
	const p = createContainers({run: f.run, reservedPorts: [2021, 7780]}).procedures
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 80, containerPort: 80}), /1024 or higher/)
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 7780, containerPort: 80}), /own/)
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 9000, containerPort: 80}), /a already uses port 9000/)
	await p['containers.addPort'].run({name: 'b', hostPort: 8080, containerPort: 80})
	assert.deepEqual(f.calls.at(-1), ['config', 'device', 'add', 'b', 'port-tcp-8080', 'proxy', 'listen=tcp:0.0.0.0:8080', 'connect=tcp:127.0.0.1:80'])
	await p['containers.removePort'].run({name: 'b', protocol: 'udp', hostPort: 8080})
	assert.deepEqual(f.calls.at(-1), ['config', 'device', 'remove', 'b', 'port-udp-8080'])
})

test('Incus errors come back in plain words, and a slow shutdown offers Force stop', async () => {
	const f = fakeIncus({fail: (a) => a[0] === 'stop' && a.includes('--timeout')})
	const p = createContainers({run: f.run}).procedures
	await assert.rejects(p['containers.stop'].run({name: 'web'}), /STOP_TIMED_OUT: web didn’t shut down.*Not allowed by project restrictions/)
	await p['containers.forceStop'].run({name: 'web'})
	assert.deepEqual(f.calls.at(-1), ['stop', 'web', '--force'])
})

test('not set up yet: the status says why and gives the one-time setup (sudo is run by the owner, never by MODC)', async () => {
	const missing = createContainers({run: async () => Promise.reject(Object.assign(new Error('spawn incus ENOENT'), {code: 'ENOENT'})), user: 'chris'}).procedures
	const s = await missing['containers.status'].run()
	assert.equal(s.available, false)
	assert.match(s.reason, /isn’t installed/)
	assert.equal(s.setupCommand, setupCommand('chris'))
	assert.match(s.setupCommand, /usermod -aG incus chris/)
	assert.doesNotMatch(s.setupCommand, /incus-admin/, 'never the admin group: that is root-equivalent')
	const denied = createContainers({run: async () => Promise.reject(Object.assign(new Error('x'), {stderr: 'Error: permission denied'}))}).procedures
	assert.match((await denied['containers.status'].run()).reason, /restart the server/)
	const ok = createContainers({run: fakeIncus().run}).procedures
	assert.deepEqual(await ok['containers.status'].run(), {available: true, version: '6.8', project: 'user-1000'})
})

test('the terminal opens a root shell only in a running container', async () => {
	const f = fakeIncus({list: [{name: 'up', type: 'container', status: 'Running'}, {name: 'down', type: 'container', status: 'Stopped'}]})
	const ct = createContainers({run: f.run})
	assert.deepEqual((await ct.shellFor('up')).command, ['incus', 'exec', 'up', '--env', 'TERM=xterm-256color', '--', 'su', '-l'])
	await assert.rejects(ct.shellFor('down'), /isn’t running/)
	await assert.rejects(ct.shellFor('missing'), /No such container/)
	await assert.rejects(ct.shellFor('../etc'), /lowercase/)
})

test('omarchyd: containers are owner-only, and the web app passes them through', async () => {
	const {mkdtemp, rm} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const {ALLOWED} = await import('../server/app.mjs')
	for (const name of ['containers.status', 'containers.list', 'containers.images', 'containers.create', 'containers.delete', 'containers.addPort']) assert.ok(ALLOWED[name], name)
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-ct-'))
	const accounts = await openAccounts(join(root, 'd'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'd'), home: root, containerOptions: {run: fakeIncus({list: [{name: 'web', type: 'container', status: 'Running'}]}).run}})
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		const res = await (await fetch(`${d.url}/trpc/containers.list`, {headers: {authorization: `Bearer ${login.result.data.accessToken}`}})).json()
		assert.equal(res.result.data[0].name, 'web')
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
