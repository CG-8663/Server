// Factory reset promises a first-time server. The next owner must not inherit the previous
// owner's assistant keys, chats, swarm computers, NAS password, or share password.
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const exists = (p) => readFile(p).then(() => true, () => false)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('factory reset drops keys, chats, swarm computers, backup secrets and shares', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-reset-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(join(home, 'Documents'), {recursive: true})
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	await mkdir(join(data, 'assistant/conversations'), {recursive: true})
	await writeFile(join(data, 'assistant/keys.json'), JSON.stringify({
		keys: [{
			id: 'k_abcdef123456', ownerUserId: 'owner', name: 'Grok', provider: 'spacexai',
			baseUrl: 'https://api.x.ai/v1', model: 'grok', apiKey: 'sk-secret-9999', last4: '9999',
			sharedWith: [], systemDefault: false, createdAt: 1, updatedAt: 1,
		}],
	}))
	await writeFile(join(data, 'assistant/conversations/c_abcdef123456.json'), JSON.stringify({
		userId: 'owner', title: 'Private chat', messages: [{role: 'user', content: 'secret chat'}], actions: [],
	}))
	await writeFile(join(data, 'swarm.json'), JSON.stringify({
		agents: [{id: 'computer-1', name: 'nixnet', keyHash: 'enrolled-key', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 1}],
	}))
	await mkdir(join(data, 'backups'), {recursive: true})
	await writeFile(join(data, 'backups/config.json'), JSON.stringify({nas: {host: 'nas.home', share: 'backups', username: 'chris'}}))
	await writeFile(join(data, 'backups/secrets.json'), JSON.stringify({nasPassword: 'nas-secret'}))
	await writeFile(join(data, 'backups/recovery-key'), 'restic-recovery-secret\n')
	await writeFile(join(data, 'shares.json'), JSON.stringify([{name: 'Docs', path: '/Home/Documents'}]))
	await writeFile(join(data, 'share-password'), 'share-secret')
	const d = await startOmarchyd({
		port: 0, dataDir: data, home,
		updaterOptions: {autoCheck: false},
		appOptions: {systemApps: null, run: async () => ''},
		machineOptions: {run: async () => ''},
		backupOptions: {timers: false, unshare: false},
	})
	try {
		const call = async (kind, path, input, headers = {}) => {
			const url = new URL(`${d.url}/trpc/${path}`)
			const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
			if (kind === 'mutation') {
				init.headers['content-type'] = 'application/json'
				init.body = JSON.stringify(input ?? null)
			}
			const r = await fetch(url, init)
			return {status: r.status, body: await r.json()}
		}
		const login = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
		const owner = {authorization: `Bearer ${login.body.result.data.accessToken}`}
		const listed = await call('query', 'assistant.keys', undefined, owner)
		assert.equal(listed.body.result.data[0].last4, '9999')
		const reset = await call('mutation', 'system.factoryReset', {password: 'correct horse'}, owner)
		assert.equal(reset.body.result.data, true)
		let users = []
		for (let i = 0; i < 50; i++) {
			users = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8')).users
			if (users.length === 0) break
			await sleep(100)
		}
		assert.equal(users.length, 0, 'accounts are cleared')
		await sleep(300)
		assert.equal(await exists(join(data, 'assistant/keys.json')), false, 'the API key file is gone')
		assert.equal(await exists(join(data, 'assistant/conversations/c_abcdef123456.json')), false, 'the chat is gone')
		const swarm = JSON.parse(await readFile(join(data, 'swarm.json'), 'utf8'))
		assert.deepEqual(swarm.agents, [], 'the enrolled computer is gone')
		assert.equal(JSON.stringify(swarm).includes('enrolled-key'), false)
		assert.equal(await exists(join(data, 'backups/secrets.json')), false, 'the NAS password is gone')
		assert.equal(await exists(join(data, 'backups/config.json')), false, 'the NAS address is gone')
		assert.equal(await exists(join(data, 'backups/recovery-key')), false, 'the recovery key is gone')
		assert.equal(await exists(join(data, 'share-password')), false, 'the share password is gone')
		assert.equal(await exists(join(data, 'shares.json')), false, 'the share list is gone')
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})
