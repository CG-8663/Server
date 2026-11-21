// One account-wide way to show a machine's readings. Every view lists the same readings.
import {managerStats, type ManagerStat} from './machineManagerLogic.ts'

export const STAT_VIEWS = ['line', 'blocks', 'gauges'] as const
export type StatView = (typeof STAT_VIEWS)[number]

export const STAT_VIEW_NAME: Record<StatView, string> = {
	line: 'one line',
	blocks: 'three lines',
	gauges: 'gauges',
}

export function statViewOf(value: unknown): StatView {
	return value === 'line' || value === 'blocks' || value === 'gauges' ? value : 'line'
}

/** line → three-line blocks → gauges → line. */
export function nextStatView(current: StatView): StatView {
	return STAT_VIEWS[(STAT_VIEWS.indexOf(current) + 1) % STAT_VIEWS.length]
}

export type PostureSummary = {
	rebootRequired?: boolean
	rebootReason?: string
	securityUpdates?: number | null
	listeningPorts?: {port: number; proto: string; addr: string}[]
	failedUnits?: number
} | null

export type StatReading = {
	id: string
	label: string
	icon: ManagerStat['icon'] | 'restart' | 'update' | 'alert' | 'network'
	/** The value, the same words on the line, the block, and a gauge that has no percent. */
	text: string
	/** Set only when a ring can show a real percent. Temperature and a size-only disk stay null. */
	percent: number | null
	/** Longer caption under a percent gauge, when it says more than `text`. */
	sub: string
	color?: string
}

export type StatGauge = {k: string; icon: string; p: number; ready: boolean; key?: string; sub?: string; color?: string}

/** A percent ring, or the value alone. A missing percent is not drawn as an empty arc. */
export function readingFace(reading: StatReading): 'arc' | 'value' {
	return reading.percent == null ? 'value' : 'arc'
}

/** Caption under a gauge. Omitted when it only repeats the value. */
export function gaugeCaption(reading: StatReading): string | null {
	if (readingFace(reading) !== 'arc') return null
	if (!reading.sub || reading.sub === reading.text || reading.sub === '–') return null
	return reading.sub
}

function postureReadings(posture: PostureSummary | undefined): StatReading[] {
	if (!posture) return []
	const out: StatReading[] = []
	if (posture.rebootRequired) {
		out.push({
			id: 'reboot',
			label: 'Restart',
			icon: 'restart',
			text: 'Needed',
			percent: null,
			sub: posture.rebootReason || 'Restart needed',
			color: 'var(--yellow)',
		})
	}
	if (typeof posture.securityUpdates === 'number' && posture.securityUpdates > 0) {
		const n = Math.round(posture.securityUpdates)
		out.push({
			id: 'security',
			label: 'Security',
			icon: 'update',
			text: String(n),
			percent: null,
			sub: `${n} security update${n === 1 ? '' : 's'}`,
			color: 'var(--yellow)',
		})
	}
	if (typeof posture.failedUnits === 'number' && posture.failedUnits > 0) {
		const n = Math.round(posture.failedUnits)
		out.push({
			id: 'failed',
			label: 'Failed',
			icon: 'alert',
			text: String(n),
			percent: null,
			sub: `${n} failed service${n === 1 ? '' : 's'}`,
			color: 'var(--red)',
		})
	}
	if (Array.isArray(posture.listeningPorts) && posture.listeningPorts.length > 0) {
		const n = posture.listeningPorts.length
		out.push({
			id: 'ports',
			label: 'Ports',
			icon: 'network',
			text: String(n),
			percent: null,
			sub: posture.listeningPorts
				.slice(0, 6)
				.map((p) => `${p.port}/${p.proto}`)
				.join(', '),
		})
	}
	return out
}

/**
 * The readings every view shows, in one order: the usage gauges, then a size-only disk, then temperature, then host posture readings.
 * `diskSizeGb` is used only when no storage gauge is present.
 */
export function statReadings(input: {gauges: readonly StatGauge[]; temp: number | null; diskSizeGb: number | null; posture?: PostureSummary}): StatReading[] {
	const stats = managerStats({gauges: input.gauges, temp: input.temp, diskSizeGb: input.diskSizeGb})
	const extra = new Map(input.gauges.map((g) => [g.key ?? g.k, g]))
	const base: StatReading[] = stats.map((s) => {
		const g = extra.get(s.id)
		const text = s.id === 'temp' && input.temp != null && Number.isFinite(input.temp) ? `${Math.round(input.temp)}°C` : s.text
		return {
			id: s.id,
			label: s.label,
			icon: s.icon,
			text,
			percent: s.percent,
			sub: g?.sub && g.sub !== '–' ? g.sub : text,
			color: g?.color,
		}
	})
	return [...base, ...postureReadings(input.posture)]
}
