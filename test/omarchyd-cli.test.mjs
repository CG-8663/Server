// `omarchyd/cli.mjs` option parsing, validation, error handling, and help output.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {parsePort} from '../omarchyd/cli-args.mjs'

const CLI = fileURLToPath(new URL('../omarchyd/cli.mjs', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-cli-'))
after(() => rm(root, {recursive: true, force: true}))

function runSync(args, extraEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: {...process.env, HOME: root, XDG_DATA_HOME: join(root, 'xdg-data'), OMARCHY_TLS_DIR: join(root, 'tls'), ...extraEnv},
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15_000,
	})
}

test('#611: --help, -h, and help print usage and exit 0', () => {
	const cases = [
		['--help'],
		['-h'],
		['help'],
		['serve', '--help'],
		['create-owner', '-h'],
		['has-owner', '--help'],
	]
	for (const args of cases) {
		const r = runSync(args)
		assert.equal(r.status, 0, `${args.join(' ')} status=${r.status} stderr=${r.stderr}`)
		assert.equal(r.stderr, '')
		for (const token of ['serve', '--port', '--web-port', 'create-owner', '--name', 'has-owner', '--data']) {
			assert.ok(r.stdout.includes(token), `${args.join(' ')} stdout missing ${token}`)
		}
	}
})

test('#611: unknown options, missing values, and extra arguments exit 2 with no stack trace', () => {
	const cases = [
		['--bogus'],
		['create-owner', '--name'],
		['serve', 'extra'],
		['bogus'],
	]
	for (const args of cases) {
		const r = runSync(args)
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} stderr=${r.stderr}`)
		assert.doesNotMatch(r.stderr, /ERR_PARSE_ARGS/)
		assert.doesNotMatch(r.stderr, /^\s+at /m)
	}
})

test('#611: create-owner without a terminal prints a friendly message and exits 1 with no stack trace', async () => {
	const data = await mkdtemp(join(root, 'owner-notty-'))
	const r = runSync(['create-owner', '--data', data])
	assert.equal(r.status, 1)
	assert.match(r.stderr, /Run this in a terminal so the password can be typed privately/)
	assert.doesNotMatch(r.stderr, /^\s+at /m)
})

test('#439: serve rejects invalid --port and --web-port with exit 1 and no stack trace', () => {
	const data = join(root, 'omarchyd-bad-port-does-not-exist')
	for (const val of ['70000', 'abc', '']) {
		const r = runSync(['serve', '--port', val, '--data', data])
		assert.equal(r.status, 1, `serve --port ${JSON.stringify(val)} expected exit 1, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /--port must be a number from 1 to 65535/)
		assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|^\s+at /m)
	}
	for (const val of ['0', '70000']) {
		const r = runSync(['serve', '--web-port', val, '--data', data])
		assert.equal(r.status, 1, `serve --web-port ${val} expected exit 1, got ${r.status} stderr=${r.stderr}`)
		assert.match(r.stderr, /--web-port must be a number from 1 to 65535/)
		assert.doesNotMatch(r.stderr, /ERR_SOCKET_BAD_PORT|^\s+at /m)
	}
	assert.equal(existsSync(data), false)
})

test('#439: parsePort validates ranges, handles empty env vs explicit flag, and overrides bad env', () => {
	assert.equal(parsePort(undefined, undefined, {fallback: 7780}), 7780)
	assert.equal(parsePort(undefined, '', {env: 'PORT', fallback: 7780}), 7780)
	assert.equal(parsePort(undefined, '   ', {env: 'PORT', fallback: 7780}), 7780)
	assert.equal(parsePort('1', undefined, {fallback: 7780}), 1)
	assert.equal(parsePort('65535', undefined, {fallback: 7780}), 65535)
	assert.equal(parsePort('8080', 'bad', {env: 'PORT', fallback: 7780}), 8080)
	assert.throws(() => parsePort('', undefined, {flag: '--port', fallback: 7780}), /--port must be a number from 1 to 65535/)
	for (const bad of ['0', '-1', '65536', '70000', 'abc', '1.5']) {
		assert.throws(() => parsePort(bad, undefined, {flag: '--port', fallback: 7780}), /--port must be a number from 1 to 65535/)
		assert.throws(() => parsePort(undefined, bad, {flag: '--port', env: 'PORT', fallback: 7780}), /PORT must be a number from 1 to 65535/)
	}
})

test('#614: has-owner does not create missing folder, exits 2 on errors, and serves clean errors on unusable --data', async () => {
	const missingDir = join(root, 'has-owner-missing-dir')
	const rMissing = runSync(['has-owner', '--data', missingDir])
	assert.equal(rMissing.status, 1)
	assert.equal(rMissing.stdout.trim(), 'no')
	assert.equal(existsSync(missingDir), false, 'has-owner must not create missing --data directory')

	const ownerDir = await mkdtemp(join(root, 'has-owner-yes-'))
	const accts = await openAccounts(ownerDir)
	await accts.createOwner({name: 'Chris', password: 'correct horse'})
	const rYes = runSync(['has-owner', '--data', ownerDir])
	assert.equal(rYes.status, 0)
	assert.equal(rYes.stdout.trim(), 'yes')

	const filePath = join(root, 'not-a-dir-file')
	await writeFile(filePath, 'x')

	const rFile = runSync(['has-owner', '--data', filePath])
	assert.equal(rFile.status, 2)
	assert.match(rFile.stderr, /not a directory/)
	assert.doesNotMatch(rFile.stderr, /^\s+at /m)

	const rFileSub = runSync(['has-owner', '--data', join(filePath, 'sub')])
	assert.equal(rFileSub.status, 2)
	assert.match(rFileSub.stderr, /not a directory/)
	assert.doesNotMatch(rFileSub.stderr, /^\s+at /m)

	const rEmpty = runSync(['has-owner', '--data', ''])
	assert.equal(rEmpty.status, 2)
	assert.match(rEmpty.stderr, /--data cannot be empty/)
	assert.doesNotMatch(rEmpty.stderr, /^\s+at /m)

	const damagedDir = await mkdtemp(join(root, 'damaged-accts-'))
	await writeFile(join(damagedDir, 'accounts.json'), '{bad json')
	const rDamaged = runSync(['has-owner', '--data', damagedDir])
	assert.equal(rDamaged.status, 2)
	assert.match(rDamaged.stderr, /accounts\.json is damaged or unreadable/)
	assert.doesNotMatch(rDamaged.stderr, /^\s+at /m)

	for (const cmd of ['serve', 'create-owner']) {
		const rCmdFile = runSync([cmd, '--data', filePath])
		assert.equal(rCmdFile.status, 1, `${cmd} on file`)
		assert.match(rCmdFile.stderr, /not a directory/)
		assert.doesNotMatch(rCmdFile.stderr, /^\s+at /m)
	}

	const rServeEmpty = runSync(['serve', '--data', ''])
	assert.equal(rServeEmpty.status, 1)
	assert.match(rServeEmpty.stderr, /--data cannot be empty/)
	assert.doesNotMatch(rServeEmpty.stderr, /^\s+at /m)

	if (process.getuid?.() !== 0) {
		const locked = await mkdtemp(join(root, 'locked-parent-'))
		await chmod(locked, 0o000)
		try {
			const rLockedCheck = runSync(['has-owner', '--data', join(locked, 'sub')])
			assert.equal(rLockedCheck.status, 2)
			assert.match(rLockedCheck.stderr, /permission denied/)
			assert.doesNotMatch(rLockedCheck.stderr, /^\s+at /m)

			const rLockedServe = runSync(['serve', '--data', join(locked, 'sub')])
			assert.equal(rLockedServe.status, 1)
			assert.match(rLockedServe.stderr, /permission denied/)
			assert.doesNotMatch(rLockedServe.stderr, /^\s+at /m)
		} finally {
			await chmod(locked, 0o700)
		}
	}
})
