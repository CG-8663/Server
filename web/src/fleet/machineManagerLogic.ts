// Rules for the pre-release phone Machines list. The screen renders these. It does not invent readings.

export type ManagerKind = 'server' | 'computer' | 'guest'
export type ManagerFilter = 'all' | 'physical' | 'virtual' | 'unhealthy' | 'healthy' | 'offline' | 'online'
/** The four places on the filter bar. Three of them flip to the other word in that pair. */
export type FilterSlot = 'all' | 'kind' | 'health' | 'reach'
export type ManagerHealth = 'healthy' | 'warning' | 'danger' | 'unknown'
export type ManagerPower = 'start' | 'resume' | 'shutdown' | 'reboot' | 'pause' | 'stop' | 'suspend'
export type ReachKind = 'running' | 'stopped' | 'busy' | 'error'

export type ManagerStat = {
	id: string
	label: string
	icon: 'cpu' | 'memory' | 'disk' | 'gpu' | 'battery' | 'thermo'
	text: string
	percent: number | null
	ready: boolean
	/** Every reading has a dial. A percent fills the ring. A temperature or a size uses the reading itself. */
	dial: boolean
}

const ICONS = new Set<ManagerStat['icon']>(['cpu', 'memory', 'disk', 'gpu', 'battery', 'thermo'])

/** Browser-only. Squares are the first visit. Gauges stay chosen across machines. */
export const MANAGER_DIALS_KEY = 'omarchy-server:mm-dials'

export function loadManagerDials(raw: string | null): boolean {
	return raw === '1'
}

export function saveManagerDials(on: boolean): '1' | '0' {
	return on ? '1' : '0'
}

export function passesFilter(kind: ManagerKind, filter: ManagerFilter, facts?: {offline?: boolean; online?: boolean; health?: ManagerHealth}): boolean {
	if (filter === 'all') return true
	if (filter === 'virtual') return kind === 'guest'
	if (filter === 'physical') return kind === 'server' || kind === 'computer'
	if (filter === 'offline') return facts?.offline === true
	if (filter === 'online') return facts?.online === true
	if (filter === 'unhealthy') return facts?.health === 'warning' || facts?.health === 'danger'
	if (filter === 'healthy') return facts?.health === 'healthy'
	return false
}

const FILTER_LABEL: Record<ManagerFilter, string> = {
	all: 'All',
	physical: 'Physical',
	virtual: 'Virtual',
	unhealthy: 'Unhealthy',
	healthy: 'Healthy',
	offline: 'Offline',
	online: 'Online',
}

/** The word on one slot. A pair shows its first word until that slot is the active filter. */
export function filterLabel(filter: ManagerFilter, slot: FilterSlot): string {
	if (slot === 'kind') return filter === 'virtual' ? FILTER_LABEL.virtual : FILTER_LABEL.physical
	if (slot === 'health') return filter === 'healthy' ? FILTER_LABEL.healthy : FILTER_LABEL.unhealthy
	if (slot === 'reach') return filter === 'online' ? FILTER_LABEL.online : FILTER_LABEL.offline
	return FILTER_LABEL.all
}

/** Which slot is selected for the current filter. */
export function filterSlot(filter: ManagerFilter): FilterSlot {
	if (filter === 'physical' || filter === 'virtual') return 'kind'
	if (filter === 'unhealthy' || filter === 'healthy') return 'health'
	if (filter === 'offline' || filter === 'online') return 'reach'
	return 'all'
}

/**
 * Pick a slot. The first press selects that pair's first word.
 * Pressing the selected slot again swaps to the other word, in the same place.
 */
export function nextFilter(current: ManagerFilter, slot: FilterSlot): ManagerFilter {
	if (slot === 'all') return 'all'
	if (slot === 'kind') return current === 'physical' ? 'virtual' : current === 'virtual' ? 'physical' : 'physical'
	if (slot === 'health') return current === 'unhealthy' ? 'healthy' : current === 'healthy' ? 'unhealthy' : 'unhealthy'
	return current === 'offline' ? 'online' : current === 'online' ? 'offline' : 'offline'
}

export function matchesName(name: string, query: string): boolean {
	const q = query.trim().toLowerCase()
	if (!q) return true
	return name.toLowerCase().includes(q)
}

export function managerRows<T extends {kind: ManagerKind; name: string; offline?: boolean; online?: boolean; health?: ManagerHealth}>(rows: readonly T[], filter: ManagerFilter, query: string): T[] {
	return rows.filter((row) => passesFilter(row.kind, filter, row) && matchesName(row.name, query))
}

/** The Offline pill only. Paused, hibernated, error, and a busy word are not offline. */
export function isOffline(kind: ManagerKind, online: boolean, state?: string): boolean {
	return reachLabel(kind, online, state).label === 'Offline'
}

/** The Online pill only. Paused, hibernated, error, and a busy word are not online. */
export function isOnline(kind: ManagerKind, online: boolean, state?: string): boolean {
	return reachLabel(kind, online, state).label === 'Online'
}

export function reachLabel(kind: ManagerKind, online: boolean, state?: string): {kind: ReachKind; label: string} {
	if (kind !== 'guest') return online ? {kind: 'running', label: 'Online'} : {kind: 'stopped', label: 'Offline'}
	switch (state) {
		case 'running':
			return {kind: 'running', label: 'Online'}
		case 'stopped':
			return {kind: 'stopped', label: 'Offline'}
		case 'suspended':
			return {kind: 'stopped', label: 'Paused'}
		case 'hibernated':
			return {kind: 'stopped', label: 'Hibernated'}
		case 'error':
			return {kind: 'error', label: 'Error'}
		case 'installing':
			return {kind: 'busy', label: 'Installing'}
		case 'starting':
			return {kind: 'busy', label: 'Starting'}
		case 'stopping':
			return {kind: 'busy', label: 'Stopping'}
		case 'restarting':
			return {kind: 'busy', label: 'Restarting'}
		default:
			return {kind: 'busy', label: state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Unknown'}
	}
}

export type GaugeSnap = {name: string; percent: number; ready: boolean}

/** The Home lines: high use warns at 75% and is danger at 90%. Battery flips that. */
export function gaugeHealth(gauges: readonly GaugeSnap[]): 'ok' | 'warning' | 'danger' | 'none' {
	const ready = gauges.filter((g) => g.ready)
	if (!ready.length) return 'none'
	let warning = false
	for (const g of ready) {
		const battery = g.name === 'Battery'
		if (battery ? g.percent <= 15 : g.percent >= 90) return 'danger'
		if (battery ? g.percent <= 25 : g.percent >= 75) warning = true
	}
	return warning ? 'warning' : 'ok'
}

export function worstAlert(severities: readonly ('info' | 'warning' | 'critical')[]): 'warning' | 'critical' | null {
	if (severities.includes('critical')) return 'critical'
	if (severities.includes('warning')) return 'warning'
	return null
}

export function managerHealth(input: {kind: ManagerKind; online: boolean; connectorOnline: boolean; alert: 'warning' | 'critical' | null; gauges: readonly GaugeSnap[]}): ManagerHealth {
	// A guest with no live connector has no health reading, even while its power is on.
	if (input.kind === 'guest' && !input.connectorOnline) return 'unknown'
	if (!input.online) return 'unknown'
	if (input.alert === 'critical') return 'danger'
	if (input.alert === 'warning') return 'warning'
	const level = gaugeHealth(input.gauges)
	if (level === 'danger') return 'danger'
	if (level === 'warning') return 'warning'
	if (level === 'none') return 'unknown'
	return 'healthy'
}

export function healthPill(health: ManagerHealth): {kind: ReachKind | 'update'; label: string} {
	if (health === 'healthy') return {kind: 'running', label: 'Healthy'}
	if (health === 'warning') return {kind: 'update', label: 'Warning'}
	if (health === 'danger') return {kind: 'error', label: 'Danger'}
	return {kind: 'stopped', label: 'Unknown'}
}

const VM_BUSY = new Set(['installing', 'starting', 'stopping', 'restarting'])

export function managerBusy(kind: ManagerKind, state: string | undefined, pending: boolean): boolean {
	if (kind !== 'guest') return false
	if (pending) return true
	return !!state && VM_BUSY.has(state)
}

export function managerPower(input: {kind: ManagerKind; online: boolean; manage: boolean; state?: string; pending?: boolean}): ManagerPower[] {
	if (input.kind === 'server') return []
	if (input.kind === 'computer') {
		if (!input.online || !input.manage) return []
		return ['suspend', 'reboot', 'shutdown']
	}
	if (managerBusy('guest', input.state, !!input.pending)) return []
	if (input.state === 'suspended') return ['resume', 'stop']
	if (input.state === 'running') return ['shutdown', 'reboot', 'pause']
	if (input.state === 'hibernated') return ['resume']
	if (input.state === 'stopped' || input.state === 'error') return ['start']
	return []
}

export function managerAccess(input: {
	kind: ManagerKind
	/** Connector or this server, reachable. For a guest this is the connector, not the power state. */
	linkOnline: boolean
	owner: boolean
	serverTerminal: boolean
	terminalGranted: boolean
	desktopGranted: boolean
	desktopOk: boolean
	guestRunning: boolean
}): {terminal: boolean; desktop: boolean} {
	if (input.kind === 'server') return {terminal: input.serverTerminal, desktop: input.owner}
	if (input.kind === 'computer')
		return {
			terminal: input.linkOnline && input.terminalGranted,
			desktop: input.linkOnline && input.desktopGranted && input.desktopOk,
		}
	return {
		terminal: input.guestRunning && input.linkOnline && input.terminalGranted,
		desktop: input.guestRunning,
	}
}

function formatDuration(seconds: number): string {
	const s = Math.floor(seconds)
	const d = Math.floor(s / 86400)
	const h = Math.floor((s % 86400) / 3600)
	const m = Math.floor((s % 3600) / 60)
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

/** Up time replaces last seen while the machine is running, and only when we actually have a time. */
export function seenFact(online: boolean, uptime: number | undefined, lastSeen: number | null | undefined, now: number): {label: 'Up time' | 'Last seen'; text: string} | null {
	if (online) {
		if (uptime == null || !Number.isFinite(uptime) || uptime <= 0) return null
		return {label: 'Up time', text: formatDuration(uptime)}
	}
	if (lastSeen == null || !Number.isFinite(lastSeen) || lastSeen <= 0) return null
	const seconds = Math.max(0, (now - lastSeen) / 1000)
	if (seconds < 60) return {label: 'Last seen', text: 'just now'}
	return {label: 'Last seen', text: `${formatDuration(seconds)} ago`}
}

function asIcon(icon: string): ManagerStat['icon'] {
	return ICONS.has(icon as ManagerStat['icon']) ? (icon as ManagerStat['icon']) : 'cpu'
}

export function managerStats(input: {
	gauges: readonly {k: string; icon: string; p: number; ready: boolean; key?: string}[]
	temp: number | null
	diskSizeGb: number | null
}): ManagerStat[] {
	const stats: ManagerStat[] = input.gauges.map((g) => ({
		id: g.key ?? g.k,
		label: g.k,
		icon: asIcon(g.icon),
		text: g.ready ? `${Math.round(g.p)}%` : '–',
		percent: g.ready ? g.p : null,
		ready: g.ready,
		dial: true,
	}))
	if (!stats.some((s) => s.label === 'Storage') && input.diskSizeGb != null && input.diskSizeGb > 0) {
		stats.push({id: 'disk-size', label: 'Storage', icon: 'disk', text: `${input.diskSizeGb} GB`, percent: null, ready: true, dial: true})
	}
	if (input.temp != null && Number.isFinite(input.temp)) {
		stats.push({id: 'temp', label: 'Temperature', icon: 'thermo', text: `${Math.round(input.temp)}°`, percent: null, ready: true, dial: true})
	}
	return stats
}

export type ValueDial = {
	id: string
	label: string
	icon: ManagerStat['icon']
	value: string
	unit: string
	/** 0–100. Temperature uses degrees, capped at 100. A size fills the ring because it is not a usage percent. */
	fill: number
	sub: string
}

/** Temperature and a size-only disk. Percent readings stay on the gauge row they already have. */
export function valueDials(stats: readonly ManagerStat[]): ValueDial[] {
	const out: ValueDial[] = []
	for (const stat of stats) {
		if (stat.id === 'temp') {
			const n = Number.parseFloat(stat.text)
			const rounded = Number.isFinite(n) ? Math.round(n) : null
			out.push({
				id: stat.id,
				label: stat.label,
				icon: stat.icon,
				value: rounded == null ? '–' : String(rounded),
				unit: '°',
				fill: rounded == null ? 0 : Math.max(0, Math.min(100, rounded)),
				sub: stat.text,
			})
			continue
		}
		if (stat.id !== 'disk-size') continue
		const split = stat.text.lastIndexOf(' ')
		out.push({
			id: stat.id,
			label: stat.label,
			icon: stat.icon,
			value: split > 0 ? stat.text.slice(0, split) : stat.text,
			unit: split > 0 ? stat.text.slice(split + 1) : '',
			fill: 100,
			sub: stat.text,
		})
	}
	return out
}

export type MotionPhase = 'stay' | 'enter' | 'leave'

/**
 * Order for a filter change. Rows that remain keep their places. A row that no longer matches
 * stays in the gap it occupied and leaves. A new row is inserted where the new list puts it.
 * When a gap has both, the new row comes first so it does not fade in under a collapsing one.
 */
export function mergeMotion(prevIds: readonly string[], nextIds: readonly string[]): {id: string; phase: MotionPhase}[] {
	const nextSet = new Set(nextIds)
	const prevAt = new Map<string, number>()
	prevIds.forEach((id, index) => {
		if (!prevAt.has(id)) prevAt.set(id, index)
	})
	const leaversAfter = new Map<number, string[]>()
	let lastKeep = -1
	for (let i = 0; i < prevIds.length; i++) {
		const id = prevIds[i]
		if (nextSet.has(id)) {
			lastKeep = i
			continue
		}
		const bucket = leaversAfter.get(lastKeep)
		if (bucket) bucket.push(id)
		else leaversAfter.set(lastKeep, [id])
	}
	const out: {id: string; phase: MotionPhase}[] = []
	const pending: {id: string; phase: MotionPhase}[] = []
	let seenKeep = false
	let prevKeep = -1
	const flushGap = (after: number) => {
		out.push(...pending.splice(0))
		for (const id of leaversAfter.get(after) ?? []) out.push({id, phase: 'leave'})
	}
	for (const id of nextIds) {
		const at = prevAt.get(id)
		if (at == null) {
			pending.push({id, phase: 'enter'})
			continue
		}
		flushGap(seenKeep ? prevKeep : -1)
		out.push({id, phase: 'stay'})
		seenKeep = true
		prevKeep = at
	}
	if (!seenKeep) {
		out.push(...pending.splice(0))
		for (const id of prevIds) {
			if (!nextSet.has(id)) out.push({id, phase: 'leave'})
		}
		return out
	}
	flushGap(prevKeep)
	return out
}
