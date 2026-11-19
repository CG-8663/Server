import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {createConnector} from '../omarchyd/connector.mjs'

test('connector helper.py unit tests', () => {
	execFileSync('python3', [fileURLToPath(new URL('../connector/test_helper.py', import.meta.url))], {stdio: 'inherit'})
})

test('swarm.storage.status: missing computer is NOT_FOUND, offline is PRECONDITION_FAILED', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'swarm-storage-'))
	try {
		const id = 'aabbccddeeff'
		await writeFile(
			join(dataDir, 'swarm.json'),
			JSON.stringify({
				agents: [
					{
						id,
						name: 'pi',
						keyHash: '0'.repeat(64),
						allowed: {terminal: false, desktop: false, manage: false, storage: true},
						on: {terminal: false, desktop: false, manage: false, storage: true},
						enrolledAt: Date.now(),
						lastSeen: null,
						info: {hostname: 'pi'},
					},
				],
			}),
		)
		const c = createConnector({dataDir, tlsDir: dataDir})
		await assert.rejects(() => c.procedures['swarm.storage.status'].run({id: 'nope'}), /isn’t in your swarm/)
		await assert.rejects(() => c.procedures['swarm.storage.status'].run({id}), /offline/)
		await assert.rejects(() => c.procedures['swarm.storage.disks'].run({id}), /offline/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
