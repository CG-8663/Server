import assert from 'node:assert/strict'
import {test} from 'node:test'

import {batteryGroups, batterySweep, computerSample, fleetRings, serverSample} from '../web/src/fleet/aggregate.ts'
import {computerParent, computerPlacePath, filePlaces, parseComputerPlace} from '../web/src/fleet/filePlaces.ts'
import {groupApps} from '../web/src/fleet/groupApps.ts'
import {computerFleetInput, fleetAbility, fleetList, guestFleetInput, SERVER_FLEET_ID} from '../web/src/fleet/list.ts'
import {hasPin, loadPins, togglePin} from '../web/src/fleet/pins.ts'

test('the fleet list is online names, then offline names', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [
			computerFleetInput({id: 'kitchen', name: 'Kitchen', online: true, allowed: {files: true, terminal: true}, on: {files: true, terminal: true}}),
			computerFleetInput({id: 'garage', name: 'Garage', online: false, allowed: {files: true}, on: {files: true}}),
			computerFleetInput({id: 'loft', name: 'Loft', online: true}),
		],
		guests: [
			guestFleetInput({id: 'ubuntu', name: 'Ubuntu lab', state: 'running', connector: true}),
			guestFleetInput({id: 'haos', name: 'HA OS', state: 'running'}),
			guestFleetInput({id: 'win', name: 'Windows', state: 'stopped', connector: true}),
		],
	})
	assert.deepEqual(
		members.map((m) => [m.id, m.kind, m.online]),
		[
			[SERVER_FLEET_ID, 'server', true],
			['haos', 'guest', true],
			['kitchen', 'computer', true],
			['loft', 'computer', true],
			['ubuntu', 'guest', true],
			['garage', 'computer', false],
			['win', 'guest', false],
		],
	)
	assert.equal(members[0].meta, 'Computer · entrypoint · online')
	assert.equal(members[0].entrypoint, true)
	assert.equal(members.find((m) => m.id === 'haos')?.hostId, SERVER_FLEET_ID)
	assert.equal(members.find((m) => m.id === 'haos')?.meta, 'Virtual machine · running')
	assert.equal(members.find((m) => m.id === 'win')?.meta, 'Virtual machine · stopped')
	const loft = members.find((m) => m.id === 'loft')
	assert.equal(fleetAbility(loft, 'apps').reason, 'Loft can’t take app-store apps yet.')
	assert.equal(fleetAbility(loft, 'files').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'files').granted, true)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').granted, false)
	const haos = members.find((m) => m.id === 'haos')
	assert.match(fleetAbility(haos, 'apps').reason, /connector on HA OS/)
	assert.equal(fleetAbility(haos, 'storage').granted, false)
	assert.equal(fleetAbility(members.find((m) => m.id === 'ubuntu'), 'apps').granted, true)
	assert.equal(fleetAbility(members[0], 'apps').granted, true)
})

test('home rings weight CPU by cores, keep the hottest temperature, and share close batteries', () => {
	const rings = fleetRings([
		serverSample({name: 'Den', cores: 4, cpu: 50, memUsed: 4, memTotal: 8, diskUsed: 10, diskTotal: 100, temp: 40, gpus: [{id: 'g', used: 80}], battery: null}),
		computerSample({
			id: 'kitchen',
			name: 'Kitchen',
			online: true,
			metrics: {cpu: 10, cores: 8, mem: {used: 2, total: 8}, disks: [{mount: '/', used: 50, total: 100}], gpus: [{id: 'k', used: 20}], temp: 70},
		}),
		computerSample({id: 'loft', name: 'Loft', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 18, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'nook', name: 'Nook', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 21, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'patio', name: 'Patio', online: true, metrics: {cpu: 5, cores: 4, batteries: [{id: 'b', index: 0, name: 'BAT0', percent: 76, status: 'discharging', secondsRemaining: null, power: null, energyNow: null, energyFull: null}]}}),
		computerSample({id: 'garage', name: 'Garage', online: false, metrics: {cpu: 99, cores: 32, temp: 99}}),
	])
	// (4*50 + 8*10 + 4*5 + 4*5 + 4*5) / 24 = 14. Garage's 99 stays out.
	assert.equal(rings.cpu.percent, 14)
	assert.equal(rings.cpu.busiest, 'Den')
	assert.equal(rings.temp?.celsius, 70)
	assert.equal(rings.temp?.name, 'Kitchen')
	assert.equal(rings.gpu?.percent, 50)
	assert.equal(rings.gpu?.busiest, 'Den')
	assert.equal(rings.battery?.lowest.name, 'Loft')
	assert.equal(rings.battery?.lowest.percent, 18)
	assert.deepEqual(
		rings.battery?.groups.map((g) => [g.percent, g.members.map((m) => m.name).sort()]),
		[
			[76, ['Patio']],
			[20, ['Loft', 'Nook']],
		],
	)
	const shared = rings.battery?.groups[1]
	assert.equal(shared?.members.length, 2)
	assert.notEqual(shared?.members[0].color, shared?.members[1].color)
	const arc = batterySweep(76)
	assert.equal(arc.endLeft, true)
	assert.equal(batterySweep(20).endLeft, false)
	assert.equal(batteryGroups([{id: 'a', name: 'A', percent: 50}, {id: 'b', name: 'B', percent: 40}]).length, 2)
})

test('pins round-trip and apps stay in arrival order', () => {
	assert.deepEqual(loadPins(null), [])
	assert.deepEqual(loadPins('nope'), [])
	assert.deepEqual(loadPins(JSON.stringify([{kind: 'nope'}, {kind: 'app', id: 'jellyfin', computer: 'server'}])), [{kind: 'app', id: 'jellyfin', computer: 'server'}])
	const pin = {kind: 'machine', id: 'kitchen', computer: ''}
	const on = togglePin([], pin)
	assert.equal(hasPin(on, pin), true)
	assert.deepEqual(togglePin(on, pin), [])
	const groups = groupApps([
		{appId: 'jellyfin', name: 'Jellyfin', computerId: 'server', computerName: 'Den'},
		{appId: 'code', name: 'Code', computerId: 'server', computerName: 'Den'},
		{appId: 'jellyfin', name: 'Jellyfin', computerId: 'kitchen', computerName: 'Kitchen'},
	])
	assert.deepEqual(groups.map((g) => g.appId), ['jellyfin', 'code'])
	assert.deepEqual(groups[0].instances.map((i) => i.computerName), ['Den', 'Kitchen'])
	assert.equal(groups[1].instances.length, 1)
})

test('file places keep granted online computers and skip the rest', () => {
	const {places, note} = filePlaces([
		{id: 'kitchen', name: 'Kitchen', online: true, filesGranted: true},
		{id: 'loft', name: 'Loft', online: true, filesGranted: false},
		{id: 'garage', name: 'Garage', online: false, filesGranted: true},
	])
	assert.deepEqual(places, [{id: 'kitchen', name: 'Kitchen', path: '::computer/kitchen'}])
	assert.match(note ?? '', /Loft hasn’t granted Files/)
	assert.match(note ?? '', /Garage is offline/)
	assert.deepEqual(parseComputerPlace('::computer/kitchen/Photos/2024'), {id: 'kitchen', rel: 'Photos/2024'})
	assert.equal(parseComputerPlace('::computer/kitchen/../secret'), null)
	assert.equal(parseComputerPlace('::computer/..'), null)
	assert.equal(parseComputerPlace('::computer/../secret'), null)
	assert.equal(parseComputerPlace('::computer/.'), null)
	assert.equal(parseComputerPlace('::computer/a\\b'), null)
	assert.equal(computerPlacePath('..'), null)
	assert.equal(computerPlacePath('..', 'secret'), null)
	assert.equal(computerPlacePath(''), null)
	assert.equal(computerPlacePath('a/b'), null)
	assert.equal(computerParent(computerPlacePath('kitchen', 'Photos/2024')), '::computer/kitchen/Photos')
	assert.equal(computerParent('::computer/kitchen'), null)
	assert.equal(computerPlacePath('kitchen').startsWith('/'), false)
})
