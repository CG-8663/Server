// connector/install.sh --user-enroll-only and noninteractive sudo, in a temporary home with
// stand-ins for sudo, systemctl, curl and python3. A sudo that needs a terminal must not hang.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile, access} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false
const root = await mkdtemp(join(os.tmpdir(), 'connector-noint-'))
after(() => rm(root, {recursive: true, force: true}))

const PEM = `-----BEGIN CERTIFICATE-----\n${Buffer.from('not really a certificate, just bytes').toString('base64')}\n-----END CERTIFICATE-----\n`
const CA = createHash('sha256').update(Buffer.from('not really a certificate, just bytes')).digest('hex')
const ARGS = ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,storage,files']

async function stubs({python3 = true} = {}) {
	const bin = join(root, `bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(bin)
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put('uname', 'exec /usr/bin/uname "$@"')
	await put('id', 'exec /usr/bin/id "$@"')
	await put(
		'sudo',
		`echo "sudo $*" >>"$FAKE_LOG"
if [ -n "$FAKE_SUDO_FAILS" ]; then
	echo "sudo: a terminal is required to read the password" >&2
	exit 1
fi
exit 0`,
	)
	await put('systemctl', 'echo "systemctl $*" >>"$FAKE_LOG"; exit 0')
	await put('apt-get', 'echo "apt-get $*" >>"$FAKE_LOG"; exit 0')
	await put(
		'curl',
		`out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
echo "curl $*" >>"$FAKE_LOG"
case "$*" in *ca.crt*) printf '%s' "$FAKE_PEM" >"$out" ;; *agent.py*) cp "$FAKE_AGENT" "$out" ;; esac`,
	)
	if (python3) {
		await put(
			'python3',
			`if [ "$2" = enroll ]; then echo "enroll $*" >>"$FAKE_LOG"; echo "Guest box"; exit 0; fi
exec /usr/bin/python3 "$@"`,
		)
	}
	return bin
}

function install(home, bin, args, extra = {}) {
	const log = join(home, 'log')
	const r = spawnSync('/usr/bin/bash', [SCRIPT, ...args], {
		env: {
			HOME: home,
			PATH: extra.path ?? `${bin}:/usr/bin:/bin`,
			USER: extra.USER ?? 'chris',
			FAKE_LOG: log,
			FAKE_PEM: PEM,
			FAKE_AGENT: AGENT,
			FAKE_SUDO_FAILS: extra.FAKE_SUDO_FAILS,
			OMARCHY_CONNECTOR_NONINTERACTIVE: extra.OMARCHY_CONNECTOR_NONINTERACTIVE,
		},
		encoding: 'utf8',
		timeout: 20000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`, log, error: r.error}
}

test('--user-enroll-only enrolls without sudo and enables the user unit', {skip}, async () => {
	const home = join(root, 'enroll-only')
	await mkdir(home)
	const r = install(home, await stubs(), [...ARGS, '--user-enroll-only'])
	assert.equal(r.status, 0, r.out)
	assert.equal(r.error, undefined)
	const log = await readFile(r.log, 'utf8')
	assert.equal(/sudo/.test(log), false, log)
	assert.match(log, /systemctl --user enable --now omarchy-connector\.service/)
	assert.match(log, /enroll https:\/\/192\.168\.1\.20:7780 abc123 terminal,desktop,manage,storage,files$/m)
	const unit = await readFile(join(home, '.config/systemd/user/omarchy-connector.service'), 'utf8')
	assert.match(unit, /ExecStart=\/usr\/bin\/env python3 .*\/omarchy-connector\/agent\.py/)
	await access(join(home, '.config/omarchy-connector/server-ca.crt'))
	assert.match(r.out, /Guest box" is now in your server/)
})

test('noninteractive sudo that needs a terminal exits 4 instead of hanging', {skip}, async () => {
	const home = join(root, 'need-sudo')
	await mkdir(home)
	const bin = await stubs({python3: false})
	const r = install(home, bin, ARGS, {
		path: bin,
		FAKE_SUDO_FAILS: '1',
		OMARCHY_CONNECTOR_NONINTERACTIVE: '1',
	})
	assert.equal(r.error, undefined, r.out)
	assert.equal(r.status, 4, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /sudo -n /)
	assert.doesNotMatch(r.out, /Done\./)
	assert.match(r.out, /password to finish installing|administrator permission/i)
	assert.doesNotMatch(r.out, /secret-pw|hunter2/)
})

test('--user-enroll-only with no python3 exits 1, not 4', {skip}, async () => {
	const home = join(root, 'no-python')
	await mkdir(home)
	const bin = await stubs({python3: false})
	const r = install(home, bin, [...ARGS, '--user-enroll-only'], {path: bin, FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1, r.out)
	assert.match(r.out, /Python 3 is needed/)
	assert.doesNotMatch(r.out, /Done\./)
	try {
		const log = await readFile(r.log, 'utf8')
		assert.doesNotMatch(log, /sudo/)
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
})
