import type {ReactNode} from 'react'

import {useBattery, useCpu, useDisk, useGpus, useMemory, useTemp, useUptime} from '../data'
import {BatteryRing} from './BatteryRing'
import type {FleetRings, GaugeKind} from './aggregate'
import {Icon, type IconName} from '../icons'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {Ring, StatChip, levelColor} from '../ui'

export type GaugeModel = {
	k: string
	key?: string
	icon: IconName
	p: number
	sub: string
	ready: boolean
	color?: string
	battery?: FleetRings['battery']
	/** A reading that is not a percent. The ring stays empty and this text sits in the center. */
	reading?: {text: string}
}

/** High use is a warning at 75% and danger at 90%. A low battery flips that: 25% and 15%. */
function gaugeLevel(name: string, p: number, ready: boolean): 'ok' | 'warning' | 'danger' {
	if (!ready) return 'ok'
	if (name === 'Battery') return p <= 15 ? 'danger' : p <= 25 ? 'warning' : 'ok'
	return p >= 90 ? 'danger' : p >= 75 ? 'warning' : 'ok'
}

function gaugeKind(name: string): GaugeKind {
	if (name === 'Memory' || name === 'Storage' || name === 'Battery') return name
	if (name.startsWith('GPU')) return 'GPU'
	return 'CPU'
}

export function useServerGaugeMetrics(): {metrics: SwarmMetrics; temp: number | null; uptime: number | undefined} {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const temp = useTemp()
	const uptime = useUptime()
	return {
		metrics: {
			cpu: cpu.data ? cpu.data.totalUsed : null,
			cores: cpu.data?.threads,
			mem: mem.data ? {total: mem.data.size, used: mem.data.totalUsed} : null,
			disks: disk.data ? [{mount: '/', total: disk.data.totalUsed + disk.data.available, used: disk.data.totalUsed}] : [],
			gpus: (gpus.data?.gpus ?? []).map((g) => ({id: g.id, index: g.index, name: g.name, used: g.used})),
			batteries: battery.data?.batteries ?? [],
		},
		temp: temp.data?.temperature ?? null,
		uptime: uptime.data,
	}
}

/** The same spec chips a joined computer shows on its card. */
export function ServerSpecs() {
	const {metrics, temp} = useServerGaugeMetrics()
	const items = swarmGaugeItems(metrics)
	if (!items.length && temp == null) return null
	return (
		<span className="specs">
			{items.map((g) =>
				g.ready ? (
					<StatChip key={'key' in g && g.key ? g.key : g.k} icon={g.icon} label={g.k}>
						{Math.round(g.p)}%
					</StatChip>
				) : null,
			)}
			{temp != null && (
				<StatChip icon="thermo" label="Temperature">
					{Math.round(temp)}°C
				</StatChip>
			)}
		</span>
	)
}

function gaugeFace(g: GaugeModel): ReactNode {
	if (g.battery) return <BatteryRing groups={g.battery.groups} lowest={g.battery.lowest} color={g.color} />
	if (g.reading) {
		return (
			<Ring value={0} empty color="var(--muted)" label={`${g.k}, ${g.reading.text}`}>
				<span className="plain">{g.reading.text}</span>
			</Ring>
		)
	}
	return (
		<Ring value={g.p} color={g.color ?? levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
			<span className="pct">
				{g.ready ? Math.round(g.p) : '–'}
				<small>%</small>
			</span>
		</Ring>
	)
}

/**
 * One gauge row for Home and for a machine.
 * The click is part of the component. A machine page leaves it off, so the line stays the measure.
 */
export function GaugeCluster({
	metrics,
	items,
	interactive = false,
	onOpen,
}: {
	metrics?: SwarmMetrics | null
	items?: readonly GaugeModel[]
	interactive?: boolean
	onOpen?: (gauge: {title: string; kind: GaugeKind; gpuId?: string}) => void
}) {
	const rows: GaugeModel[] = items
		? [...items]
		: swarmGaugeItems(metrics).map((g) => ({
				k: g.k,
				icon: g.icon,
				p: g.p,
				sub: g.sub,
				ready: g.ready,
				key: 'key' in g ? g.key : undefined,
				color: 'color' in g ? g.color : undefined,
			}))
	if (!rows.length) return null
	return (
		<div className="glass gauges" data-n={rows.length} role="group" aria-label="System usage" style={items ? undefined : {marginTop: 16}}>
			{rows.map((g) => {
				const level = gaugeLevel(g.k, g.p, g.ready)
				const face = (
					<>
						{gaugeFace(g)}
						<span className="k">{g.k}</span>
						{interactive && level !== 'ok' ? (
							<span className={`sub gauge-alert${level === 'danger' ? ' danger' : ''}`}>
								<Icon name={level === 'danger' ? 'exclaim' : 'alert'} size={13} />
								Tap for details
							</span>
						) : (
							<span className="sub">{g.sub}</span>
						)}
					</>
				)
				const key = g.key ?? g.k
				if (!interactive) {
					return (
						<div className="gauge" key={key}>
							{face}
						</div>
					)
				}
				return (
					<button
						type="button"
						className="gauge press"
						key={key}
						aria-label={level === 'ok' ? `${g.k}, ${g.sub}` : `${g.k}, tap for details`}
						onClick={() => onOpen?.({title: g.k, kind: gaugeKind(g.k), gpuId: g.key})}
					>
						{face}
					</button>
				)
			})}
		</div>
	)
}

export function ServerRings() {
	const {metrics} = useServerGaugeMetrics()
	return <GaugeCluster metrics={metrics} />
}
