// Where an App Store install can go.
// The main store asks. A store opened from a machine is already aimed at that machine.
// This server can take an install today. A joined computer can take one only after it has
// granted Apps. A virtual machine can take one only after its connector is installed.

export type InstallKind = 'server' | 'computer' | 'guest'
export type InstallAbility = 'ready' | 'offline' | 'refused' | 'needs-connector'

export type InstallTarget = {
	id: string
	kind: InstallKind
	name: string
	ability: InstallAbility
	/** Empty when the install can proceed. */
	reason: string
}

export const SERVER_INSTALL_ID = 'server'

/** Id to send, or null when that machine can no longer take the install. Never substitute this server. */
export function confirmInstallTarget(chosen: {id: string; ability: InstallAbility} | null): string | null {
	if (!chosen || chosen.ability !== 'ready') return null
	return chosen.id
}

export type ComputerInstallInput = {
	id: string
	name: string
	online: boolean
	/** Both the grant at join and the connector currently offering Apps. */
	appsGranted: boolean
}

export type GuestInstallInput = {
	id: string
	name: string
	state: string
	connector: boolean
}

const byName = (a: {name: string}, b: {name: string}) => a.name.localeCompare(b.name)

export function computerInstallInput(row: {id: string; name: string; online: boolean; allowed?: {apps?: boolean}; on?: {apps?: boolean}}): ComputerInstallInput {
	return {id: row.id, name: row.name, online: row.online, appsGranted: !!(row.allowed?.apps && row.on?.apps)}
}

export function guestInstallInput(row: {id: string; name: string; state: string; connector?: boolean}): GuestInstallInput {
	return {id: row.id, name: row.name, state: row.state, connector: !!row.connector}
}

function computerTarget(row: ComputerInstallInput): InstallTarget {
	if (!row.online) return {id: row.id, kind: 'computer', name: row.name, ability: 'offline', reason: `${row.name} is offline.`}
	if (!row.appsGranted) return {id: row.id, kind: 'computer', name: row.name, ability: 'refused', reason: `${row.name} can’t take app-store apps yet.`}
	return {id: row.id, kind: 'computer', name: row.name, ability: 'ready', reason: ''}
}

function guestTarget(row: GuestInstallInput): InstallTarget {
	if (!row.connector) return {id: row.id, kind: 'guest', name: row.name, ability: 'needs-connector', reason: `Install the connector on ${row.name} before apps can be installed there.`}
	if (row.state !== 'running') return {id: row.id, kind: 'guest', name: row.name, ability: 'offline', reason: `${row.name} is not running.`}
	return {id: row.id, kind: 'guest', name: row.name, ability: 'ready', reason: ''}
}

export function installTargets(input: {serverName: string; computers: readonly ComputerInstallInput[]; guests: readonly GuestInstallInput[]}): InstallTarget[] {
	const server: InstallTarget = {id: SERVER_INSTALL_ID, kind: 'server', name: input.serverName || 'This server', ability: 'ready', reason: ''}
	const computers = [...input.computers].sort(byName)
	const guests = [...input.guests].sort(byName)
	return [
		server,
		...computers.filter((c) => c.online).map(computerTarget),
		...computers.filter((c) => !c.online).map(computerTarget),
		...guests.filter((g) => g.state === 'running').map(guestTarget),
		...guests.filter((g) => g.state !== 'running').map(guestTarget),
	]
}

export function installKindLabel(kind: InstallKind): string {
	if (kind === 'server') return 'This server'
	if (kind === 'computer') return 'Computer'
	return 'Virtual machine'
}

/** A count is shown only when the same app is installed on more than one machine. */
export function machineCountLabel(count: number): string | null {
	return count > 1 ? String(count) : null
}

export function installsOf(appId: string, places: readonly {appIds: readonly string[]}[]): number {
	return places.reduce((n, place) => n + (place.appIds.includes(appId) ? 1 : 0), 0)
}
