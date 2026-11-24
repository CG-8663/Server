import assert from 'node:assert/strict'
import {test} from 'node:test'

import {connectorCloudInit, connectorInstallCommand, connectorInstallCommandWindows, connectorKind, guestConnectorExec, guestConnectorPrep, guestReachableUrl} from '../omarchyd/guest-install.mjs'

test('guestReachableUrl skips loopback and prefers a LAN address', () => {
	assert.equal(guestReachableUrl({addresses: [], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: '127.0.0.1'}], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: 'localhost'}], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: '::1'}], port: 7780}), '')
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}, {address: '192.168.84.81'}], port: 7780}),
		'https://192.168.84.81:7780',
	)
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}], port: 7780}),
		'https://100.64.1.2:7780',
	)
	assert.equal(guestReachableUrl({addresses: [{address: '10.0.0.4'}], port: 8443}), 'https://10.0.0.4:8443')
})

test('connectorKind matches Linux systemd and Windows guests', () => {
	assert.equal(connectorKind('ubuntu-24.04-server-amd64'), 'linux')
	assert.equal(connectorKind('debian-13-desktop-amd64'), 'linux')
	assert.equal(connectorKind('fedora-44-server-amd64'), 'linux')
	assert.equal(connectorKind('arch-server-amd64'), 'linux')
	assert.equal(connectorKind('omarchy-4.0.4-amd64'), 'linux')
	assert.equal(connectorKind(''), 'linux')
	assert.equal(connectorKind('windows-11'), 'windows')
	assert.equal(connectorKind('windows-server'), 'windows')
	assert.equal(connectorKind('macos'), 'unsupported')
	assert.equal(connectorKind('haos'), 'unsupported')
	assert.equal(connectorKind('home-assistant'), 'unsupported')
	assert.equal(connectorKind('alpine-3.24.1-amd64'), 'unsupported')
})

test('connectorCloudInit adds qemu-guest-agent and python without dropping catalog setup', () => {
	const debian = connectorCloudInit({
		familyId: 'debian',
		cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true, adminGroup: 'sudo'},
	})
	assert.deepEqual(debian.packages, ['qemu-guest-agent', 'python3', 'task-gnome-desktop'])
	assert.deepEqual(debian.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	assert.deepEqual(debian.commands[1], ['systemctl', 'set-default', 'graphical.target'])
	assert.equal(debian.graphical, true)
	assert.equal(debian.adminGroup, 'sudo')
	const arch = connectorCloudInit({familyId: 'arch'})
	assert.deepEqual(arch.packages, ['qemu-guest-agent', 'python'])
	assert.deepEqual(arch.commands, [['systemctl', 'enable', '--now', 'qemu-guest-agent']])
	const withUser = connectorCloudInit({
		familyId: 'debian',
		username: 'chris',
		cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true, adminGroup: 'sudo'},
	})
	assert.deepEqual(withUser.packages, ['qemu-guest-agent', 'python3', 'task-gnome-desktop'])
	assert.deepEqual(withUser.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	assert.deepEqual(withUser.commands[1], ['loginctl', 'enable-linger', 'chris'])
	assert.deepEqual(withUser.commands[2], ['systemctl', 'set-default', 'graphical.target'])
	assert.equal(withUser.graphical, true)
	const without = connectorCloudInit({familyId: 'debian', cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true}})
	assert.equal(without.commands.some((c) => c[0] === 'loginctl'), false)
	assert.deepEqual(without.packages, ['qemu-guest-agent', 'python3', 'task-gnome-desktop'])
	assert.equal(without.graphical, true)
})

test('guestConnectorPrep enables linger as argv and installs python only when it is missing', () => {
	const prep = guestConnectorPrep({username: 'chris'})
	assert.equal(prep.length >= 1, true)
	assert.deepEqual(prep[0], {path: 'loginctl', args: ['enable-linger', 'chris']})
	const python = prep.find((cmd) => cmd.path === 'bash')
	assert.ok(python, 'python install is a generated bash command')
	assert.equal(python.args[0], '-lc')
	assert.match(python.args[1], /python3/)
	assert.match(python.args[1], /\bpython\b/)
	assert.match(python.args[1], /apt-get/)
	assert.match(python.args[1], /pacman/)
	assert.equal(python.args[1].includes('chris'), false)
	assert.equal(prep[0].args.join(' ').includes('bash'), false)
})

test('guest-exec wraps the paste command as runuser or powershell', () => {
	const ca = 'a'.repeat(64)
	const linux = guestConnectorExec({
		os: 'linux',
		username: 'chris',
		source: 'https://example.test',
		server: 'https://192.168.84.81:7780',
		ca,
		token: 'tok',
		allow: 'terminal,desktop,manage,files',
	})
	assert.equal(linux.path, 'runuser')
	assert.deepEqual(linux.args.slice(0, 5), ['-u', 'chris', '--', 'bash', '-lc'])
	assert.equal(
		linux.args[5],
		`curl -fsSL https://example.test/main/connector/install.sh | bash -s -- --server https://192.168.84.81:7780 --ca ${ca} --token tok --allow terminal,desktop,manage,files --source https://example.test --user-enroll-only`,
	)
	assert.equal(linux.args[5].includes('--user-enroll-only'), true)
	assert.match(
		connectorInstallCommand({source: '/home/x/omarchy-server', server: 'https://10.1.2.3:7780', ca, token: 't', allow: 'terminal'}),
		/^curl -fsSLk https:\/\/10\.1\.2\.3:7780\/api\/connector\/install\.sh \| bash -s -- /,
	)
	const win = guestConnectorExec({
		os: 'windows',
		source: 'https://example.test',
		server: 'https://192.168.84.81:7780',
		ca,
		token: 'tok',
		allow: 'terminal,files,manage',
	})
	assert.equal(win.path, 'powershell.exe')
	assert.deepEqual(win.args.slice(0, 2), ['-NoProfile', '-Command'])
	assert.equal(
		win.args[2],
		`$s = irm 'https://example.test/main/connector/install.ps1'; & ([scriptblock]::Create($s)) -Server 'https://192.168.84.81:7780' -Ca '${ca}' -Token 'tok' -Allow 'terminal,files,manage' -Source 'https://example.test'`,
	)
	assert.match(connectorInstallCommandWindows({source: '/home/x/omarchy-server', server: 'https://10.1.2.3:7780', ca, token: 't', allow: ''}), /irm -SkipCertificateCheck 'https:\/\/10\.1\.2\.3:7780\/api\/connector\/install\.ps1'/)
})
