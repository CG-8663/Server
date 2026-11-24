import assert from 'node:assert/strict'
import {test} from 'node:test'

import {connectorKind, guestReachableUrl} from '../omarchyd/guest-install.mjs'

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
