// `bin/omarchy-server` option handling, help output, and service status exit codes.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'omarchy-server')
const root = await mkdtemp(join(os.tmpdir(), 'omarchy-server-cli-'))
after(() => rm(root, {recursive: true, force: true}))

async function makeSandbox(name, overrides = {}) {
	const home = join(root, name)
	const bin = join(root, `${name}-bin`)
	const log = join(root, `${name}.log`)
	await mkdir(home, {recursive: true})
	await mkdir(bin, {recursive: true})

	const stubs = {
		systemctl: overrides.systemctl ?? 'echo "systemctl $*" >>"$FAKE_LOG"\nexit 0',
		journalctl: overrides.journalctl ?? 'echo "journalctl $*" >>"$FAKE_LOG"\nexit 0',
		'xdg-open': overrides['xdg-open'] ?? 'echo "xdg-open $*" >>"$FAKE_LOG"\nexit 0',
		ip: overrides.ip ?? 'exit 1',
		'notify-send': overrides['notify-send'] ?? 'exit 0',
	}
	for (const [cmd, body] of Object.entries(stubs)) {
		await writeFile(join(bin, cmd), `#!/bin/sh\n${body}\n`)
		await chmod(join(bin, cmd), 0o755)
	}
	return {home, bin, log}
}

function runCli(box, args, extraEnv = {}) {
	const r = spawnSync('bash', [SCRIPT, ...args], {
		env: {
			HOME: box.home,
			PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
			FAKE_LOG: box.log,
			...extraEnv,
		},
		encoding: 'utf8',
		timeout: 15_000,
	})
	return {status: r.status, stdout: r.stdout, stderr: r.stderr}
}

const readLog = (box) => readFile(box.log, 'utf8').catch(() => '')

test('#607: --help and -h after any command print help to stdout, exit 0, and run nothing', async () => {
	const box = await makeSandbox('help-after-cmd')
	const cases = [
		['stop', '--help'],
		['restart', '-h'],
		['start', '--help'],
		['open', '--help'],
		['status', '--help'],
		['waybar', '--help'],
		['widget', '--help'],
		['widget', 'on', '--help'],
		['logs', '--help'],
		['uninstall', '--help'],
		['uninstall', '--purge', '--help'],
	]
	for (const args of cases) {
		const r = runCli(box, args)
		assert.equal(r.status, 0, `${args.join(' ')} status: stderr=${r.stderr}`)
		assert.equal(r.stderr, '', `${args.join(' ')} stderr should be empty`)
		assert.match(r.stdout, /omarchy-server/, `${args.join(' ')} stdout should show usage`)
	}
	assert.equal(await readLog(box), '', 'no side-effect binaries should be called for --help/-h')

	const helpStop = runCli(box, ['help', 'stop'])
	assert.equal(helpStop.status, 0, helpStop.stderr)
	assert.match(helpStop.stdout, /omarchy-server stop/)

	const helpUnknown = runCli(box, ['help', 'bogus'])
	assert.equal(helpUnknown.status, 2)
	assert.match(helpUnknown.stderr, /Unknown command: bogus/)
})

test('#607: unknown or extra options after commands are refused with exit 2 and run nothing', async () => {
	const box = await makeSandbox('extra-args')
	const cases = [
		['start', '--version'],
		['stop', '--bogus'],
		['restart', '--bogus'],
		['open', '--bogus'],
		['status', '--bogus'],
		['waybar', '--bogus'],
		['widget', 'on', 'extra'],
		['widget', 'bogus'],
		['logs', '--bogus'],
		['logs', '-n', 'abc'],
		['logs', '-n'],
		['logs', '--lines=abc'],
		['logs', '--since'],
	]
	for (const args of cases) {
		const r = runCli(box, args)
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} (stdout=${r.stdout} stderr=${r.stderr})`)
		assert.match(r.stderr, /Use: omarchy-server /, `${args.join(' ')} should print Use: on stderr`)
	}
	assert.equal(await readLog(box), '', 'no side-effect binaries should be called on bad options')
})

test('#607: logs handles -f, --follow, -n, --lines, and --since', async () => {
	const box = await makeSandbox('logs-opts')

	assert.equal(runCli(box, ['logs']).status, 0)
	assert.equal(runCli(box, ['logs', '-f']).status, 0)
	assert.equal(runCli(box, ['logs', '--follow']).status, 0)
	assert.equal(runCli(box, ['logs', '-n', '200']).status, 0)
	assert.equal(runCli(box, ['logs', '-n200']).status, 0)
	assert.equal(runCli(box, ['logs', '--lines=200']).status, 0)
	assert.equal(runCli(box, ['logs', '--since', 'today']).status, 0)
	assert.equal(runCli(box, ['logs', '--follow', '-n', '50']).status, 0)

	const lines = (await readLog(box)).trim().split('\n')
	assert.deepEqual(lines, [
		'journalctl --user -u omarchyd -u omarchy-server-web -n 80 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -f',
		'journalctl --user -u omarchyd -u omarchy-server-web -f',
		'journalctl --user -u omarchyd -u omarchy-server-web -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web --since today --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -n 50 -f',
	])
})
