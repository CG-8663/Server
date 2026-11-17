import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import YAML from 'yaml'

import {createApps, parseMcp, prepareCompose} from '../omarchyd/apps.mjs'

test('parseMcp accepts a listing block and rejects junk', () => {
	assert.deepEqual(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'http'}), {service: 'web', port: 8080, path: '/mcp', transport: 'http'})
	assert.equal(parseMcp({service: 'web', port: 0}), null)
	assert.equal(parseMcp(null), null)
	assert.equal(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'stdio'}), null)
	assert.equal(parseMcp({service: 'web', port: 8080, path: 'mcp', transport: 'http'}), null)
	assert.deepEqual(parseMcp({service: 'web', port: 8080, path: '/mcp', transport: 'sse'}), {service: 'web', port: 8080, path: '/mcp', transport: 'sse'})
})

test('prepareCompose publishes mcp on loopback and never as a public port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => 19001, {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8090, path: '/mcp', transport: 'http'}})
	assert.match(text, /127\.0\.0\.1:19001:8090/)
	assert.doesNotMatch(text, /0\.0\.0\.0/)
	assert.ok(mcpInternalPort)
	assert.equal(internalPort, 19001)
})

test('prepareCompose leaves mcpInternalPort null when the listing has no mcp', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	const {mcpInternalPort} = prepareCompose('demo', compose, () => 19001, {web: {service: 'web', port: 8080}})
	assert.equal(mcpInternalPort, null)
})

test('prepareCompose reuses the web loopback when mcp uses that container port', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n'
	let calls = 0
	const {text, internalPort, mcpInternalPort} = prepareCompose('demo', compose, () => (calls++, 19001), {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8080, path: '/mcp', transport: 'sse'}})
	assert.equal(calls, 1)
	assert.equal(internalPort, 19001)
	assert.equal(mcpInternalPort, 19001)
	assert.deepEqual(YAML.parse(text).services.web.ports, ['127.0.0.1:19001:8080'])
})

test('prepareCompose replaces a public mcp publish with loopback', () => {
	const compose = 'services:\n  web:\n    image: x\n    ports: ["8080:8080", "0.0.0.0:8090:8090"]\n'
	let n = 0
	const {text, mcpInternalPort} = prepareCompose('demo', compose, () => 19001 + n++, {web: {service: 'web', port: 8080}, mcp: {service: 'web', port: 8090, path: '/mcp', transport: 'http'}})
	assert.equal(mcpInternalPort, 19002)
	assert.deepEqual(YAML.parse(text).services.web.ports, ['127.0.0.1:19001:8080', '127.0.0.1:19002:8090'])
	assert.doesNotMatch(text, /0\.0\.0\.0/)
})

test('install keeps mcp on the app, publishes it on loopback, and mcpTargets skips the rest', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-mcp-'))
	const data = join(root, 'data')
	const home = join(root, 'home')
	const store = join(root, 'store')
	const sock = join(root, 'podman.sock')
	const gateway = 34000 + Math.floor(Math.random() * 2000)
	const up = new Set()
	const opened = []
	const prevDocker = process.env.DOCKER_HOST
	process.env.DOCKER_HOST = `unix://${sock}`
	const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'})
	const run = async (cmd, args) => {
		if (cmd === 'git') return git(args, undefined).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			return ''
		}
		if (cmd === 'podman') {
			if (args[0] === 'ps') return JSON.stringify([...up].map((project) => ({Labels: {'com.docker.compose.project': project}, State: 'running'})))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
	const until = async (fn, ms = 8000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 30))
		}
	}
	let apps
	try {
		await writeFile(sock, '')
		await mkdir(join(store, 'mcpapp'), {recursive: true})
		await mkdir(join(store, 'plain'), {recursive: true})
		await writeFile(join(store, 'omarchy-app-store.yml'), 'id: demo\nname: Demo\n')
		await writeFile(join(store, 'mcpapp', 'omarchy-app.yml'), `manifestVersion: 1\nid: mcpapp\nname: Mcp App\nversion: "1"\nport: ${gateway}\nweb:\n  service: web\n  port: 8080\nmcp:\n  service: web\n  port: 8090\n  path: /mcp\n  transport: http\nopenPorts: [6881, 8090]\n`)
		await writeFile(join(store, 'mcpapp', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports:\n      - "8080:8080"\n      - "8090:8090"\n      - "6881:6881"\n')
		await writeFile(join(store, 'plain', 'omarchy-app.yml'), `manifestVersion: 1\nid: plain\nname: Plain\nversion: "1"\nport: ${gateway + 1}\nweb:\n  service: web\n  port: 8080\n`)
		await writeFile(join(store, 'plain', 'docker-compose.yml'), 'services:\n  web:\n    image: x\n    ports: ["8080:8080"]\n')
		git(['init', '-q', '-b', 'main'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
		git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'apps'], store)
		apps = createApps({dataDir: data, home, allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [], systemApps: null, run, firewall: {open: async (p) => opened.push(p), close: async () => {}}})
		const call = (name, input) => apps.procedures[name].run(input)
		await call('appStore.addRepository', {url: `file://${store}`})
		const listed = (await call('appStore.registry')).find((r) => r.url.endsWith('/store')).apps.find((a) => a.id === 'mcpapp')
		assert.equal(listed.mcp, undefined, 'the store browse payload does not grow an mcp field')
		assert.deepEqual(listed.openPorts, [6881])
		await call('apps.install', {appId: 'mcpapp'})
		await until(async () => (await call('apps.list')).find((a) => a.id === 'mcpapp' && a.state === 'running'))
		await call('apps.install', {appId: 'plain'})
		await until(async () => (await call('apps.list')).find((a) => a.id === 'plain' && a.state === 'running'))
		const saved = JSON.parse(await readFile(join(data, 'apps', 'apps.json'), 'utf8')).apps.find((a) => a.id === 'mcpapp')
		assert.deepEqual(saved.mcp, {service: 'web', port: 8090, path: '/mcp', transport: 'http'})
		assert.equal(typeof saved.mcpInternalPort, 'number')
		assert.notEqual(saved.mcpInternalPort, saved.internalPort)
		assert.deepEqual(saved.openPorts, [6881])
		const ports = YAML.parse(await readFile(join(data, 'apps', 'installed', 'mcpapp', 'compose.omarchy.yml'), 'utf8')).services.web.ports
		assert.ok(ports.includes(`127.0.0.1:${saved.internalPort}:8080`))
		assert.ok(ports.includes(`127.0.0.1:${saved.mcpInternalPort}:8090`))
		assert.ok(!ports.some((p) => String(p).includes('0.0.0.0') || String(p) === '8090:8090'))
		assert.ok(ports.includes('6881:6881'))
		assert.ok(opened.includes(6881))
		assert.ok(!opened.includes(8090))
		assert.deepEqual(await apps.mcpTargets(), [{appId: 'mcpapp', name: 'Mcp App', url: `http://127.0.0.1:${saved.mcpInternalPort}/mcp`, transport: 'http', running: true}])
		await call('apps.stop', {appId: 'mcpapp'})
		await new Promise((r) => setTimeout(r, 1700))
		assert.deepEqual(await apps.mcpTargets(), [])
	} finally {
		await apps?.close()
		if (prevDocker === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prevDocker
		await rm(root, {recursive: true, force: true})
	}
})
