import {useMemo, useState, type CSSProperties} from 'react'

import {diskPct, type UserApp} from '../api'
import {batteryColor, batteryGaugeItem, combineBatteries} from '../battery'
import {queryProblem, useBrowserOnline} from '../connection'
import {useApps, useBattery, useBootstrap, useCpu, useDisk, useGpus, useMachines, useMemory, useTemp, useUptime, useUser} from '../data'
import {computerSample, fleetRings, serverSample, type FleetRings} from '../fleet/aggregate'
import {BatteryRing} from '../fleet/BatteryRing'
import {fleetList, guestFleetInput} from '../fleet/list'
import {openFleetMember} from '../fleet/openMember'
import {usePins} from '../fleet/PinButton'
import {pinKey, type DashboardPin} from '../fleet/pins'
import {gpuGaugeItems} from '../gauges'
import {Icon, type IconName} from '../icons'
import {useSwarm} from '../swarm/Swarm'
import {AppIcon, Ring, Row, Sheet, SheetHeader, appStatus, bytes, duration, greeting, haptic, levelColor, pct, today} from '../ui'

type GaugeItem = {
	k: string
	key?: string
	icon: IconName
	p: number
	sub: string
	ready: boolean
	color?: string
	battery?: FleetRings['battery']
}

export function Gauges({onClick, fleet}: {onClick?: () => void; fleet?: FleetRings | null}) {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const items: GaugeItem[] = fleet
		? [
				{k: 'CPU', icon: 'cpu', p: fleet.cpu.percent, sub: fleet.cpu.busiest ?? '–', ready: fleet.cpu.ready},
				{k: 'Memory', icon: 'memory', p: fleet.memory.percent, sub: fleet.memory.busiest ?? '–', ready: fleet.memory.ready},
				{k: 'Storage', icon: 'disk', p: fleet.storage.percent, sub: fleet.storage.busiest ?? '–', ready: fleet.storage.ready},
				...(fleet.gpu ? [{k: 'GPU', icon: 'gpu' as const, p: fleet.gpu.percent, sub: fleet.gpu.busiest ?? '–', ready: fleet.gpu.ready}] : []),
				...(fleet.battery
					? [{k: 'Battery', icon: 'battery' as const, p: fleet.battery.lowest.percent, sub: fleet.battery.lowest.name, ready: true, color: batteryColor(fleet.battery.lowest.percent), battery: fleet.battery}]
					: []),
			]
		: [
				{
					k: 'CPU',
					icon: 'cpu' as const,
					p: cpu.data?.totalUsed ?? 0,
					sub: cpu.data ? `${cpu.data.threads} threads` : '–',
					ready: !!cpu.data,
				},
				{
					k: 'Memory',
					icon: 'memory' as const,
					p: mem.data ? pct(mem.data.totalUsed, mem.data.size) : 0,
					sub: mem.data ? `${bytes(mem.data.totalUsed, 1, 1024)} of ${bytes(mem.data.size, 0, 1024)}` : '–',
					ready: !!mem.data,
				},
				{
					k: 'Storage',
					icon: 'disk' as const,
					p: disk.data ? diskPct(disk.data) : 0,
					sub: disk.data ? `${bytes(disk.data.available, 0)} free` : '–',
					ready: !!disk.data,
				},
				...gpuGaugeItems(gpus.data?.gpus ?? []),
				...batteryGaugeItem(battery.data?.batteries ?? []),
			]
	return (
		<button className="glass gauges press" data-n={items.length} onClick={onClick} aria-label="System usage, open details">
			{items.map((g) => (
				<div className="gauge" key={g.key ?? g.k}>
					{g.battery ? (
						<BatteryRing groups={g.battery.groups} lowest={g.battery.lowest} color={g.color} />
					) : (
						<Ring value={g.p} color={g.color ?? levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
							<span className="pct">
								{g.ready ? Math.round(g.p) : '–'}
								<small>%</small>
							</span>
						</Ring>
					)}
					<span className="k">{g.k}</span>
					<span className="sub">{g.sub}</span>
				</div>
			))}
		</button>
	)
}

export function Home({onOpenApp, go}: {onOpenApp: (app: UserApp) => void; go: (tab: 'apps' | 'more' | 'store') => void; onTerminal?: () => void; onAssistant?: () => void}) {
	const user = useUser()
	const apps = useApps()
	const boot = useBootstrap()
	const machines = useMachines()
	const swarm = useSwarm()
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(apps, browserOnline)
	const temp = useTemp()
	const uptime = useUptime()
	const {pins} = usePins()
	const [listOpen, setListOpen] = useState(false)
	const list = apps.data ?? []
	const running = list.filter((a) => appStatus(a.state).kind === 'running').length
	const problems = list.filter((a) => a.error || a.state === 'unknown')
	const serverName = boot.server?.device || boot.server?.name || 'This server'
	const samples = useMemo(
		() => [
			serverSample({
				name: serverName,
				cores: cpu.data?.threads ?? 0,
				cpu: cpu.data ? cpu.data.totalUsed : null,
				memUsed: mem.data?.totalUsed ?? null,
				memTotal: mem.data?.size ?? null,
				diskUsed: disk.data?.totalUsed ?? null,
				diskTotal: disk.data ? disk.data.totalUsed + disk.data.available : null,
				temp: temp.data?.temperature ?? null,
				gpus: (gpus.data?.gpus ?? []).map((g) => ({id: g.id, used: g.used})),
				battery: combineBatteries(battery.data?.batteries ?? [])?.percent ?? null,
			}),
			...(swarm.data ?? []).map(computerSample),
		],
		[serverName, cpu.data, mem.data, disk.data, temp.data, gpus.data, battery.data, swarm.data],
	)
	const multi = samples.filter((s) => s.online).length >= 2
	const rings = multi ? fleetRings(samples) : null
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: (swarm.data ?? []).map((a) => ({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on})),
				guests: (machines.data ?? []).map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state})),
			}),
		[serverName, swarm.data, machines.data],
	)
	const machinePins = pins.filter((p) => p.kind === 'machine' || p.kind === 'vm')
	const appPins = pins.filter((p) => p.kind === 'app')

	const summary = apps.isLoading
		? 'Checking on your apps…'
		: problem && !apps.data
			? 'Can’t reach your server right now.'
			: problems.length
				? `${problems.length} app${problems.length > 1 ? 's need' : ' needs'} attention`
				: list.length
					? 'Everything is running smoothly.'
					: 'Your server is ready for its first app.'

	const openPin = (pin: DashboardPin) => {
		haptic(6)
		if (pin.kind === 'app') {
			const app = list.find((a) => a.id === pin.id)
			if (app) onOpenApp(app)
			return
		}
		const member = members.find((m) => m.id === pin.id && (pin.kind === 'vm' ? m.kind === 'guest' : m.kind !== 'guest'))
		if (!member) return
		openFleetMember({kind: member.kind, id: member.id})
	}

	return (
		<div className="stagger">
			<header className="hero">
				<div className="eyebrow">{today()}</div>
				<h1>
					{greeting()}
					{user.data?.name ? `, ${user.data.name.split(' ')[0]}` : ''}
				</h1>
				<p>{summary}</p>
			</header>

			<div className="home-meters">
				<Gauges fleet={rings} onClick={() => (multi ? setListOpen(true) : go('more'))} />
				<div className="facts">
					{rings?.temp ? (
						<span className="fact">
							<Icon name="thermo" size={15} />
							{Math.round(rings.temp.celsius)}°C · {rings.temp.name}
						</span>
					) : (
						temp.data?.temperature != null && (
							<span className="fact">
								<Icon name="thermo" size={15} />
								{Math.round(temp.data.temperature)}°C
							</span>
						)
					)}
					<span className="fact">
						<Icon name="clock" size={15} />
						Up {duration(uptime.data)}
					</span>
					<span className="fact">
						<Icon name="apps" size={15} />
						{running}/{list.length} apps running
					</span>
				</div>
			</div>

			{machinePins.length === 0 && appPins.length === 0 ? (
				<div className="glass empty">
					<b>Nothing is pinned</b>
					<span>Pin a machine, a guest, or an app and it stays on this page.</span>
				</div>
			) : (
				<>
					{machinePins.length > 0 && (
						<section>
							<div className="section-head">
								<h2>Pinned machines</h2>
							</div>
							<div className="glass group">
								{machinePins.map((pin) => {
									const member = members.find((m) => m.id === pin.id)
									const host = member?.hostId ? (members.find((m) => m.id === member.hostId)?.name ?? serverName) : ''
									return (
										<button key={pinKey(pin)} type="button" className="row" onClick={() => openPin(pin)}>
											<span className="main">
												<b>{member?.name ?? pin.id}</b>
												<span>{pin.kind === 'vm' ? `Pinned virtual machine${host ? ` · ${host}` : ''}${member ? ` · ${member.online ? 'running' : 'stopped'}` : ''}` : 'Pinned machine'}</span>
											</span>
											<span className="muted">Pinned</span>
										</button>
									)
								})}
							</div>
						</section>
					)}
					{appPins.length > 0 && (
						<section>
							<div className="section-head">
								<h2>Pinned applications</h2>
							</div>
							<div className="glass group" style={{'--inset': '74px'} as CSSProperties}>
								{appPins.map((pin) => {
									const app = list.find((a) => a.id === pin.id)
									const where = pin.computer === 'server' || pin.computer === '' ? serverName : (members.find((m) => m.id === pin.computer)?.name ?? pin.computer)
									return (
										<button key={pinKey(pin)} type="button" className="row" onClick={() => openPin(pin)}>
											<AppIcon src={app?.icon} name={app?.name ?? pin.id} size={46} />
											<span className="main">
												<b>{app?.name ?? pin.id}</b>
												<span>Pinned application · {where}</span>
											</span>
										</button>
									)
								})}
							</div>
						</section>
					)}
				</>
			)}
			{listOpen && (
				<Sheet open onClose={() => setListOpen(false)} label="Computers" tall>
					<SheetHeader title="Computers" subtitle="Online computers in these rings" onClose={() => setListOpen(false)} />
					<div className="glass group" style={{marginTop: 12}}>
						{samples
							.filter((s) => s.online)
							.map((s) => (
								<Row
									key={s.id}
									icon="server"
									label={s.name}
									sub={[s.cpu != null ? `CPU ${Math.round(s.cpu)}%` : '', s.memUsed != null && s.memTotal ? `Memory ${Math.round(pct(s.memUsed, s.memTotal))}%` : ''].filter(Boolean).join(' · ') || 'Online'}
									onClick={() => {
										setListOpen(false)
										openFleetMember({kind: s.id === 'server' ? 'server' : 'computer', id: s.id})
									}}
								/>
							))}
					</div>
				</Sheet>
			)}
		</div>
	)
}
