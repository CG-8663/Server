import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('Terminal opens from the server screen, not the Apps page', async () => {
	const apps = await read('../web/src/screens/Apps.tsx')
	assert.doesNotMatch(apps, /onTerminal/)
	assert.doesNotMatch(apps, /TerminalIcon/)
	const phone = await read('../web/src/screens/Machines.tsx')
	assert.match(phone, /onTerminal=\{onTerminal\}/)
	const sheet = await read('../web/src/fleet/ServerSheet.tsx')
	assert.match(sheet, /primary-row/)
	assert.match(sheet, /onTerminal\?\.\(\)/)
	assert.match(sheet, /> Terminal/)
	assert.match(sheet, /> Open desktop/)
	const desk = await read('../web/src/machines/Desktop.tsx')
	assert.match(desk, /pve-launch-row/)
	assert.match(desk, /<b>Terminal<\/b>/)
	assert.match(desk, /<b>Open desktop<\/b>/)
	assert.match(desk, /desk\?\.openTerminal\(\)/)
	const shell = await read('../web/src/App.tsx')
	assert.match(shell, /<Machines onOpenApp=\{\(a\) => setAppId\(a\.id\)\} onTerminal=\{openTerminal\}/)
	assert.doesNotMatch(shell, /<Apps onOpenApp=\{\(a\) => setAppId\(a\.id\)\} onTerminal=/)
	const appsWindow = await read('../web/src/desktop/Desktop.tsx')
	assert.match(appsWindow, /<Apps onOpenApp=\{\(a\) => setAppId\(a\.id\)\} onStore=\{\(\) => desk\.open\('store'\)\} \/>/)
})
