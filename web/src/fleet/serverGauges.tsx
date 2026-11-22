import {useBattery, useCpu, useDisk, useGpus, useMemory, useTemp, useUptime} from '../data'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {Ring, StatChip, levelColor} from '../ui'

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

/** The ring row on this server, a joined computer, and a guest. */
export function GaugeCluster({metrics}: {metrics: SwarmMetrics}) {
	const items = swarmGaugeItems(metrics)
	if (!items.length) return null
	return (
		<div className="glass gauges" data-n={items.length} aria-label="System usage" style={{marginTop: 16}}>
			{items.map((g) => (
				<div className="gauge" key={'key' in g && g.key ? g.key : g.k}>
					<Ring value={g.p} color={'color' in g && g.color ? g.color : levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
						<span className="pct">
							{g.ready ? Math.round(g.p) : '–'}
							<small>%</small>
						</span>
					</Ring>
					<span className="k">{g.k}</span>
					<span className="sub">{g.sub}</span>
				</div>
			))}
		</div>
	)
}

export function ServerRings() {
	const {metrics} = useServerGaugeMetrics()
	return <GaugeCluster metrics={metrics} />
}
