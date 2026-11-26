// A server with no screen must come back by itself after a restart or a power cut.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
const unit = (name) => {
	const m = new RegExp(`cat >"\\$UNITS/${name}" <<EOF\\n([\\s\\S]*?)\\nEOF`).exec(script)
	assert.ok(m, `${name} unit`)
	return m[1]
}

test('both services start at boot and never stop retrying', () => {
	for (const name of ['omarchyd.service', 'omarchy-server-web.service']) {
		const u = unit(name)
		assert.match(u, /^WantedBy=default\.target$/m, name)
		assert.match(u, /^Restart=on-failure$/m, name)
		assert.match(u, /^StartLimitIntervalSec=0$/m, `${name} must not give up after a few fast failures at boot`)
	}
	assert.match(script, /systemctl --user enable omarchyd\.service omarchy-server-web\.service/)
})

test('linger is turned on without sudo when allowed, never waits on a password in an in-app update, and says so when it fails', () => {
	const block = script.slice(script.indexOf('# Start at boot and keep running'), script.indexOf('# Everything above succeeded'))
	assert.match(block, /loginctl enable-linger "\$USER" 2>\/dev\/null \|\|/)
	assert.match(block, /sudo -n loginctl enable-linger/)
	assert.match(block, /stays off until you sign in/)
})
