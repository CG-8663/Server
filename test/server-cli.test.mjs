// `server/cli.mjs` option parsing, validation, error handling, and help output.
import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {mkdtemp, rm} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const CLI = fileURLToPath(new URL('../server/cli.mjs', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'server-cli-'))
after(() => rm(root, {recursive: true, force: true}))

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const {port} = s.address()
			s.close(() => resolve(port))
		})
	})

function runSync(args, extraEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: {...process.env, HOME: root, OMARCHY_TLS_DIR: join(root, 'tls'), ...extraEnv},
		encoding: 'utf8',
		timeout: 15_000,
	})
}

async function startAndWaitForBanner(args, extraEnv = {}) {
	const child = spawn(process.execPath, [CLI, ...args], {
		env: {...process.env, HOME: root, OMARCHY_TLS_DIR: join(root, 'tls'), ...extraEnv},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (d) => (stdout += d))
	child.stderr.on('data', (d) => (stderr += d))
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out\nstdout=${stdout}\nstderr=${stderr}`)), 10_000)
			const check = () => {
				if (stdout.includes('Open')) {
					clearTimeout(timer)
					resolve()
				}
			}
			child.stdout.on('data', check)
			child.on('exit', (code) => {
				clearTimeout(timer)
				reject(new Error(`exited early (${code})\nstdout=${stdout}\nstderr=${stderr}`))
			})
		})
		return {stdout, stderr, child}
	} catch (error) {
		child.kill('SIGKILL')
		throw error
	}
}

async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	child.kill('SIGTERM')
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			resolve()
		}, 5000)
		child.once('exit', () => {
			clearTimeout(timer)
			resolve()
		})
	})
}

test('#609: rejects unknown, mistyped, missing-value, and positional options with exit 2 and no stack trace', () => {
	const cases = [
		['--bogus'],
		['--prot', '7790'],
		['--host'],
		['--port', '--host', '127.0.0.1'],
		['extra'],
	]
	for (const args of cases) {
		const r = runSync(args)
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} (stderr=${r.stderr})`)
		assert.match(r.stderr, /\[omarchy-server\]/)
		assert.doesNotMatch(r.stderr, /^\s+at /m)
	}
})

test('#609: accepts --name=value and uses the last value for repeated options', async () => {
	const port1 = await freePort()
	const port2 = await freePort()
	const data = await mkdtemp(join(root, 'eq-'))
	const res = await startAndWaitForBanner([`--port=${port1}`, `--port=${port2}`, '--host=127.0.0.1', `--data=${data}`])
	try {
		assert.match(res.stdout, new RegExp(`:${port2}\\b`))
		const health = await fetch(`http://127.0.0.1:${port2}/api/health`)
		assert.equal(health.status, 200)
	} finally {
		await stopChild(res.child)
	}
})

test('#448: --help and -h document --app-hosts and all server environment variables', () => {
	for (const flag of ['--help', '-h']) {
		const r = runSync([flag])
		assert.equal(r.status, 0, `${flag}: ${r.stderr}`)
		assert.equal(r.stderr, '')
		for (const expected of [
			'--backend',
			'--port',
			'--host',
			'--data',
			'--app-hosts',
			'PORT',
			'HOST',
			'OMARCHY_BACKEND_URL',
			'OMARCHY_SERVER_DATA',
			'TOUCH_APP_HOSTS',
			'OMARCHY_SERVER_SECURE_COOKIES',
		]) {
			assert.ok(r.stdout.includes(expected), `${flag} output missing ${expected}`)
		}
	}
})
