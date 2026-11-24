// Live machines.installConnector: qemu-ga ping/exec, a pairing token, then a connector task.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const CA = 'a'.repeat(64)
const TOKEN = 'pair-token'
const LAN = '192.168.84.81'

function record(id, extra = {}) {
	return {
		id,
		name: extra.name ?? 'Box',
		osId: extra.osId ?? 'ubuntu-24.04-server-amd64',
		cores: 1,
		memoryGb: 1,
		memoryMb: 1024,
		diskSizeGb: 10,
		portForwards: [],
		createdAt: 1,
		mac: '52:54:00:11:22:33',
		vmid: 100,
		options: {agent: true},
		tasks: [],
		snapshots: [],
		...(extra.cloudInit !== undefined ? (extra.cloudInit ? {cloudInit: extra.cloudInit} : {}) : {cloudInit: {username: 'chris'}}),
		layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: []},
	}
}

function virshList(stateByDomain = new Map()) {
	return async (cmd, args) => {
		if (cmd === 'qemu-system-x86_64') return ''
		if (cmd === 'virsh' && args.includes('list')) {
			const rows = [...stateByDomain].map(([name, state]) => ` -    ${name}   ${state}`).join('\n')
			return ` Id   Name   State\n------------------\n${rows}\n`
		}
		throw new Error(`unexpected ${cmd} ${(args ?? []).join(' ')}`)
	}
}

function fakePair(extra = {}) {
	return {
		token: TOKEN,
		ca: CA,
		source: 'https://example.test',
		port: 7780,
		addresses: [{address: LAN}],
		...extra,
	}
}

function fakeAgent() {
	const execs = []
	let pingCalls = 0
	const domains = []
	const qemuAgent = ({domain}) => {
		domains.push(domain)
		return {
			ping: async () => {
				pingCalls++
			},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: false, out: '', err: ''}),
		}
	}
	return {
		qemuAgent,
		execs,
		domains,
		pingCount: () => pingCalls,
	}
}

async function open({machines, run, qemuAgent, connector, connectorEnrollTimeoutMs = 200}) {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-install-rpc-'))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	if (machines?.length) await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines}))
	const api = createMachines({
		dataDir,
		catalogUrl: 'https://example.invalid/catalog.json',
		fetchImpl: async () => ({ok: false}),
		run: run ?? (async () => ''),
		kvmDevice: join(root, 'no-kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
		qemuAgent,
		connector,
		connectorEnrollTimeoutMs,
	})
	await api.ready
	return {root, dataDir, api, call: (name, input) => api.procedures[name].run(input)}
}

const until = async (fn, ms = 2000) => {
	const end = Date.now() + ms
	let last = null
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 20))
	}
	return last
}

test('alpine, haos, and macos are unsupported and never ping the guest agent', async () => {
	const agent = fakeAgent()
	const virsh = []
	const run = async (cmd, args) => {
		if (cmd === 'virsh') virsh.push(args)
		return ''
	}
	const {root, call} = await open({
		machines: [
			record('aaaa0001', {osId: 'alpine-3.24.1-amd64', name: 'Alpine'}),
			record('aaaa0002', {osId: 'haos', name: 'HAOS'}),
			record('aaaa0003', {osId: 'macos', name: 'Mac'}),
		],
		run,
		qemuAgent: agent.qemuAgent,
	})
	try {
		for (const id of ['aaaa0001', 'aaaa0002', 'aaaa0003']) {
			const out = await call('machines.installConnector', {id})
			assert.equal(out.status, 'unsupported')
			assert.equal(out.os, 'other')
			assert.equal(typeof out.message, 'string')
			assert.ok(out.message.length > 0)
		}
		assert.equal(agent.pingCount(), 0)
		assert.deepEqual(virsh, [])
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a stopped machine is PRECONDITION_FAILED before ping', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'shut off']])),
		qemuAgent: agent.qemuAgent,
	})
	try {
		await assert.rejects(
			() => call('machines.installConnector', {id}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /Start the machine first/.test(e.message),
		)
		assert.equal(agent.pingCount(), 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a running machine whose guest agent does not answer needs-agent', async () => {
	const id = 'abcd1234'
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: () => ({
			ping: async () => {
				throw new Error('Guest agent not available for now')
			},
			exec: async () => {
				throw new Error('exec must not run')
			},
		}),
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'needs-agent')
		assert.equal(out.os, 'linux')
		assert.equal(out.taskId, undefined)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('linux cloud running with qemu-ga starts a connector task through runuser', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const pairCalls = []
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'linux')
		assert.equal(typeof out.taskId, 'string')
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
		assert.equal(pairCalls[0].terminal, true)
		assert.equal(pairCalls[0].desktop, true)
		assert.equal(pairCalls[0].manage, true)
		assert.equal(pairCalls[0].files, true)
		assert.deepEqual(agent.domains, [`omarchy-${id}`])
		assert.equal(agent.execs.length, 1)
		assert.equal(agent.execs[0].path, 'runuser')
		assert.equal(agent.execs[0].args[0], '-u')
		assert.equal(agent.execs[0].args[1], 'chris')
		assert.deepEqual(agent.execs[0].args.slice(2, 5), ['--', 'bash', '-lc'])
		const command = agent.execs[0].args[5]
		assert.match(command, /--server https:\/\/192\.168\.84\.81:7780/)
		assert.equal(command.includes('127.0.0.1'), false)
		assert.match(command, new RegExp(`--token ${TOKEN}`))
		assert.match(command, new RegExp(`--ca ${CA}`))
		assert.match(command, /--allow terminal,desktop,manage,files/)
		assert.equal(command.includes('--user-enroll-only'), false)
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.id === out.taskId)
			return t?.status === 'ok' ? t : null
		})
		assert.equal(done?.type, 'connector')
		assert.equal(done.status, 'ok')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('windows guests exec powershell with the windows allow list', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const pairCalls = []
	const {root, call} = await open({
		machines: [record(id, {osId: 'windows-11', cloudInit: null})],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'windows')
		assert.equal(pairCalls[0].terminal, true)
		assert.equal(pairCalls[0].files, true)
		assert.equal(pairCalls[0].manage, true)
		assert.equal(pairCalls[0].desktop === true, false)
		assert.equal(agent.execs[0].path, 'powershell.exe')
		assert.deepEqual(agent.execs[0].args.slice(0, 2), ['-NoProfile', '-Command'])
		assert.match(agent.execs[0].args[2], /-Allow 'terminal,files,manage'/)
		assert.match(agent.execs[0].args[2], /-Server 'https:\/\/192\.168\.84\.81:7780'/)
		assert.match(agent.execs[0].args[2], new RegExp(`-Token '${TOKEN}'`))
		assert.match(agent.execs[0].args[2], new RegExp(`-Ca '${CA}'`))
		await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.id === out.taskId)
			return t?.status === 'ok' ? t : null
		})
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('sudoPassword is dropped and never written to tasks or machines.json', async () => {
	const id = 'abcd1234'
	const secret = 'secret-pw'
	const agent = fakeAgent()
	const {root, dataDir, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async () => fakePair(),
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id, sudoPassword: secret})
		assert.equal(out.status, 'started')
		assert.equal(out.status === 'needs-password', false)
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.id === out.taskId)
			return t && t.status !== 'running' ? t : null
		})
		assert.equal(done.status, 'ok')
		assert.equal(JSON.stringify(done).includes(secret), false)
		assert.equal(JSON.stringify(agent.execs).includes(secret), false)
		const saved = await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8')
		assert.equal(saved.includes(secret), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a member cannot call machines.installConnector', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-install-auth-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(home, {recursive: true})
	await writeFile(join(root, 'kvm'), '')
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
	state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
	await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))
	const d = await startOmarchyd({
		port: 0,
		dataDir: data,
		home,
		machineOptions: {run: async () => '', kvmDevice: join(root, 'kvm')},
		appOptions: {run: async () => '', defaultStores: [], systemApps: null},
		updaterOptions: {autoCheck: false},
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true})
	})
	const login = async (userId) => {
		const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
		const body = await r.json()
		return {authorization: `Bearer ${body.result.data.accessToken}`}
	}
	const member = await login('member')
	const r = await fetch(`${d.url}/trpc/machines.installConnector`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...member},
		body: JSON.stringify({id: 'abcd1234'}),
	})
	const body = await r.json()
	assert.equal(r.status, 403)
	assert.match(body.error.message, /Only the server’s owner can install a guest connector/)
})
