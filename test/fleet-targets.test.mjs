import assert from 'node:assert/strict'
import {test} from 'node:test'

import {refuseForeignInstall} from '../omarchyd/install-target.mjs'
import {computerInstallInput, confirmInstallTarget, guestInstallInput, installKindLabel, installTargets, installsOf, machineCountLabel, SERVER_INSTALL_ID} from '../web/src/fleet/installTargets.ts'
import {matchThemeName} from '../web/src/swarm/themePicker.ts'
import {themeAction} from '../web/src/theme/themeAction.ts'

test('install targets keep this server ready and explain the others', () => {
	const targets = installTargets({
		serverName: 'Den',
		computers: [
			computerInstallInput({id: 'kitchen', name: 'Kitchen', online: true, allowed: {apps: true}, on: {apps: true}}),
			computerInstallInput({id: 'loft', name: 'Loft', online: true}),
			computerInstallInput({id: 'garage', name: 'Garage', online: false, allowed: {apps: true}, on: {apps: true}}),
		],
		guests: [
			guestInstallInput({id: 'ubuntu', name: 'Ubuntu lab', state: 'running', connector: true}),
			guestInstallInput({id: 'haos', name: 'HA OS', state: 'running'}),
			guestInstallInput({id: 'win', name: 'Windows', state: 'stopped', connector: true}),
		],
	})
	assert.deepEqual(
		targets.map((t) => [t.id, t.ability]),
		[
			[SERVER_INSTALL_ID, 'ready'],
			['kitchen', 'ready'],
			['loft', 'refused'],
			['garage', 'offline'],
			['haos', 'needs-connector'],
			['ubuntu', 'ready'],
			['win', 'offline'],
		],
	)
	assert.equal(targets[0].name, 'Den')
	assert.equal(targets.find((t) => t.id === 'loft')?.reason, 'Loft can’t take app-store apps yet.')
	assert.equal(targets.find((t) => t.id === 'haos')?.reason, 'Install the connector on HA OS before apps can be installed there.')
	assert.equal(installKindLabel('guest'), 'Virtual machine')
	assert.equal(confirmInstallTarget({id: 'kitchen', ability: 'ready'}), 'kitchen')
	assert.equal(confirmInstallTarget({id: 'kitchen', ability: 'offline'}), null)
	assert.equal(confirmInstallTarget({id: SERVER_INSTALL_ID, ability: 'ready'}), SERVER_INSTALL_ID)
	assert.equal(confirmInstallTarget(null), null)
})

test('an app count is shown only when it is on more than one machine', () => {
	assert.equal(machineCountLabel(0), null)
	assert.equal(machineCountLabel(1), null)
	assert.equal(machineCountLabel(2), '2')
	assert.equal(installsOf('jellyfin', [{appIds: ['jellyfin']}, {appIds: ['jellyfin', 'code']}, {appIds: []}]), 2)
	assert.equal(installsOf('code', [{appIds: ['jellyfin']}]), 0)
})

test('apps.install refuses a machine that cannot host the app', () => {
	assert.equal(refuseForeignInstall(undefined), null)
	assert.equal(refuseForeignInstall(''), null)
	assert.equal(refuseForeignInstall('server'), null)
	assert.match(refuseForeignInstall('kitchen') ?? '', /can’t take this install yet/)
})

test('theme changes go through one action', () => {
	assert.deepEqual(themeAction({kind: 'server', slug: 'tokyo-night'}), {path: 'omarchy.setTheme', input: {slug: 'tokyo-night'}})
	assert.deepEqual(themeAction({kind: 'computer', id: 'kitchen', theme: 'osaka-jade'}), {path: 'swarm.action', input: {id: 'kitchen', name: 'theme-set', theme: 'osaka-jade'}})
	assert.match(themeAction({kind: 'guest', name: 'HA OS'}).error ?? '', /connector on HA OS/)
	assert.equal(matchThemeName(['Tokyo Night', 'osaka-jade'], 'tokyo-night'), 'Tokyo Night')
	assert.equal(matchThemeName(['osaka-jade'], 'missing'), 'missing')
})
