import {lazy, Suspense, useEffect, useMemo, useState} from 'react'

import {SERVER_DESKTOP, type Machine, type UserApp} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useDesktop} from '../desktop/Desktop'
import {useApps, useBootstrap, useMachines, useUser} from '../data'
import {useMachineDetails} from '../machines/api'
import {PortForwarding} from '../machines/PortForwarding'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from '../machines/panels'
import {DevicesPanel} from '../usb'
import {Icon} from '../icons'
import {osLook} from '../osLook'
import {Disc} from '../fleet/Disc'
import {MachineGlance} from '../fleet/MachineGlance'
import {fleetAbility, fleetList, guestFleetInput, SERVER_FLEET_ID} from '../fleet/list'
import {OPEN_FLEET, takePendingFleet, type FleetOpen} from '../fleet/openMember'
import {openStore} from '../fleet/openStore'
import {PinButton} from '../fleet/PinButton'
import {AgentCard, LocalSwarm, useSwarm} from '../swarm/Swarm'
import {Row, Sheet, SheetHeader, StatusPill, haptic, machineStatus} from '../ui'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const CreateMachine = lazy(() => import('../CreateMachine').then((m) => ({default: m.CreateMachine})))

export function Machines({onOpenApp}: {onOpenApp?: (app: UserApp) => void} = {}) {
	const desk = useDesktop()
	const boot = useBootstrap()
	const machines = useMachines()
	const swarm = useSwarm()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(machines, browserOnline)
	const swarmProblem = queryProblem(swarm, browserOnline)
	const owner = useUser().data?.role !== 'member'
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [computerId, setComputerId] = useState<string | null>(null)
	const [serverOpen, setServerOpen] = useState(false)
	const [consoleId, setConsoleId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [adding, setAdding] = useState(false)
	const [expanded, setExpanded] = useState<string | null>(null)
	const apps = useApps()
	const list = machines.data ?? []
	const serverName = boot.server?.device || boot.server?.name || 'This server'
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: (swarm.data ?? []).map((a) => ({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on})),
				guests: list.map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state})),
			}),
		[serverName, swarm.data, list],
	)
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleMachine = consoleId === 'desktop' ? SERVER_DESKTOP : (list.find((m) => m.id === consoleId) ?? null)
	const online = members.filter((m) => m.online).length
	const agents = new Map((swarm.data ?? []).map((a) => [a.id, a]))
	useEffect(() => {
		const apply = (member: FleetOpen | null | undefined) => {
			if (!member) return
			if (member.kind === 'computer') setComputerId(member.id)
			else if (member.kind === 'guest') setSelectedId(member.id)
			else setServerOpen(true)
		}
		apply(takePendingFleet())
		const onOpen = (e: Event) => {
			takePendingFleet()
			apply((e as CustomEvent<FleetOpen>).detail)
		}
		window.addEventListener(OPEN_FLEET, onOpen)
		return () => window.removeEventListener(OPEN_FLEET, onOpen)
	}, [])
	const openApp = (app: UserApp) => {
		haptic(6)
		if (desk) desk.launch(app)
		else onOpenApp?.(app)
	}
	const glanceFor = (memberId: string, memberName: string, kind: 'server' | 'computer') => {
		const member = members.find((row) => row.id === memberId)
		const appsAbility = member ? fleetAbility(member, 'apps') : {granted: false, reason: ''}
		const vmsAbility = member ? fleetAbility(member, 'vms') : {granted: false, reason: ''}
		return (
			<MachineGlance
				name={memberName}
				apps={appsAbility.granted ? (kind === 'server' ? (apps.data ?? []) : []) : null}
				appsReason={appsAbility.reason}
				vms={vmsAbility.granted ? (kind === 'server' ? list : []) : null}
				vmsReason={vmsAbility.reason}
				onOpenApp={openApp}
				onOpenVm={(id) => (haptic(6), setSelectedId(id))}
			/>
		)
	}
	const openDesktop = () => {
		haptic(8)
		setServerOpen(false)
		if (desk) desk.openConsole('desktop')
		else setConsoleId('desktop')
	}

	return (
		<div className="stagger">
			<div style={{position: 'relative'}}>
				<button className="btn primary small" style={{position: 'absolute', right: 4, top: 14}} onClick={() => (haptic(6), setCreating(true))}>
					<Icon name="plus" size={18} stroke={2.4} /> New
				</button>
				<h1 className="title">Machines</h1>
				<p className="subtitle">{machines.isLoading ? 'Loading…' : problem && !machines.data ? 'Can’t reach your server' : `${online} of ${members.length} online`}</p>
			</div>
			{owner && (
				<button className="btn small" style={{marginBottom: 12}} onClick={() => (haptic(6), setAdding(true))}>
					<Icon name="plus" size={16} stroke={2.4} /> Add a computer
				</button>
			)}
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{owner && swarmProblem && !problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{swarmProblem}
				</div>
			)}
			{machines.isLoading && Array.from({length: 2}, (_, i) => <div key={i} className="skeleton" style={{height: 130, borderRadius: 26, marginBottom: 12}} />)}
			{members.filter((member) => member.kind !== 'guest').map((member) => {
				const open = expanded === member.id
				const toggle = () => setExpanded(open ? null : member.id)
				if (member.kind === 'server') {
					return (
						<article key={member.id} className={`glass vm-card mrow${open ? ' is-open' : ''}`}>
							<span className="top">
								<span className="vm-os" style={{background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)'}}>
									<Icon name="server" size={26} />
								</span>
								<span className="main" style={{flex: 1, minWidth: 0}}>
									<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{member.name}</b>
									<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>{member.meta}</span>
								</span>
								<StatusPill kind="running" label="Online" />
								<button type="button" className="btn small" onClick={() => (haptic(6), setServerOpen(true))}>
									Open
								</button>
							</span>
							<div className="mrow-foot">
								<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={member.name} />
								<Disc open={open} name={member.name} controls={`glance-${member.id}`} onClick={toggle} />
							</div>
							{open && (
								<div className="mrow-body" id={`glance-${member.id}`}>
									{glanceFor(member.id, member.name, 'server')}
								</div>
							)}
						</article>
					)
				}
				const agent = agents.get(member.id)
				if (!agent) return null
				return (
					<AgentCard
						key={member.id}
						className={`mrow${open ? ' is-open' : ''}`}
						a={agent}
						onClick={() => (haptic(6), setComputerId(agent.id))}
						footer={
							<div className="mrow-foot">
								<PinButton pin={{kind: 'machine', id: agent.id, computer: ''}} name={agent.name} />
								<Disc open={open} name={agent.name} controls={`glance-${member.id}`} onClick={toggle} />
							</div>
						}
						extra={open ? <div className="mrow-body" id={`glance-${member.id}`}>{glanceFor(member.id, member.name, 'computer')}</div> : null}
					/>
				)
			})}
			{selected && !consoleMachine && (
				<MachineSheet
					machine={selected}
					onClose={() => setSelectedId(null)}
					onConsole={() => {
						haptic(8)
						if (desk) {
							setSelectedId(null)
							desk.openConsole(selected.id)
						}						else setConsoleId(selected.id)
					}}
				/>
			)}
			<LocalSwarm hideList selectedId={computerId} onSelect={setComputerId} adding={adding} onAdding={setAdding} />
			{serverOpen && <ServerSheet name={serverName} owner={owner} onClose={() => setServerOpen(false)} onDesktop={openDesktop} />}
			{creating && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" aria-label="Loading" />
						</main>
					}
				>
					<CreateMachine open={creating} onClose={() => setCreating(false)} />
				</Suspense>
			)}
			{consoleMachine && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" aria-label="Loading" />
						</main>
					}
				>
					<Console machine={consoleMachine} onClose={() => setConsoleId(null)} />
				</Suspense>
			)}
		</div>
	)
}

function ServerSheet({name, owner, onClose, onDesktop}: {name: string; owner: boolean; onClose: () => void; onDesktop: () => void}) {
	return (
		<Sheet open onClose={onClose} label={name} tall>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)'}}>
						<Icon name="server" size={32} />
					</span>
				}
				title={name}
				subtitle="Computer · entrypoint · online"
				onClose={onClose}
			/>
			<div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 8}}>
				<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={name} />
			</div>
			{owner && (
				<div className="primary-row">
					<button className="btn primary" onClick={onDesktop}>
						<Icon name="terminal" size={20} /> Open desktop
					</button>
				</div>
			)}
			<div className="glass group" style={{marginTop: 12}}>
				<Row icon="store" label="App Store" sub={`Installs on ${name}`} onClick={() => (haptic(6), onClose(), openStore({id: SERVER_FLEET_ID, kind: 'server', name}))} />
			</div>
		</Sheet>
	)
}

function MachineSheet({machine: m, onClose, onConsole}: {machine: Machine; onClose: () => void; onConsole: () => void}) {
	const status = machineStatus(m.state)
	const details = useMachineDetails(m.id)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const busy = status.kind === 'busy' || power.pending
	const os = osLook(m.osId)
	const [tab, setTab] = useState<PanelId>('summary')
	const tabs = PANELS.filter((p) => p.id !== 'console' && (p.id !== 'cloudinit' || d?.cloudInit))

	return (
		<Sheet open onClose={onClose} label={m.name} tall>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={m.name}
				subtitle={
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
						<StatusPill {...status} />
						{m.vmid !== undefined && <span className="muted mono">ID {m.vmid}</span>}
					</span>
				}
				onClose={onClose}
			/>
			<div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 8}}>
				<PinButton pin={{kind: 'vm', id: m.id, computer: SERVER_FLEET_ID}} name={m.name} />
			</div>
			{m.errorMessage && (
				<div className="error">
					<Icon name="alert" size={18} />
					{/^\[[\w-]+\]$/.test(m.errorMessage) ? m.errorMessage.slice(1, -1).replace(/-/g, ' ') : m.errorMessage}
				</div>
			)}
			<div className="primary-row">
				{m.state === 'running' ? (
					<button className="btn primary" onClick={onConsole}>
						<Icon name="machine" size={20} />
						Open console
					</button>
				) : (
					<button className="btn primary" onClick={power.paused ? power.resume : power.start} disabled={busy || !(power.canStart || power.paused)}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={20} />}
						{busy ? 'Working…' : m.state === 'hibernated' || power.paused ? 'Resume' : 'Start'}
					</button>
				)}
			</div>
			<div className="glass group" style={{marginTop: 12}}>
				<Row icon="store" label="App Store" sub={`Installs on ${m.name}`} onClick={() => (haptic(6), onClose(), openStore({id: m.id, kind: 'guest', name: m.name}))} />
			</div>
			<div className="actions mx-power">
				<button className="action" onClick={power.reboot} disabled={busy || m.state !== 'running'}>
					<Icon name="restart" size={22} />
					Reboot
				</button>
				<button className="action" onClick={power.shutdown} disabled={busy || !power.on}>
					<Icon name="power" size={22} />
					Shut down
				</button>
				<button className="action" onClick={power.paused ? power.resume : power.pause} disabled={busy || !power.on}>
					<Icon name={power.paused ? 'play' : 'pulse'} size={22} />
					{power.paused ? 'Resume' : 'Pause'}
				</button>
				<button className="action" onClick={power.hibernate} disabled={busy || m.state !== 'running'}>
					<Icon name="download" size={22} />
					Hibernate
				</button>
				<button className="action" onClick={power.stop} disabled={busy || !power.on}>
					<Icon name="stop" size={22} />
					Stop
				</button>
				<button className="action" onClick={power.clone} disabled={busy || !power.canStart || m.state === 'error'}>
					<Icon name="copy" size={22} />
					Clone
				</button>
			</div>
			<div className="mx-tabs" role="tablist" aria-label={`${m.name} settings`}>
				{tabs.map((p) => (
					<button key={p.id} role="tab" aria-selected={tab === p.id} className={`chip${tab === p.id ? ' on' : ''}`} onClick={(e) => (haptic(5), setTab(p.id), e.currentTarget.scrollIntoView({behavior: 'smooth', inline: 'center', block: 'nearest'}))}>
						<Icon name={p.icon} size={15} />
						{p.label}
					</button>
				))}
			</div>
			<div className="mx-touch">
				{!d ? (
					<div className="skeleton" style={{height: 160, borderRadius: 20}} />
				) : tab === 'summary' ? (
					<SummaryPanel d={d} />
				) : tab === 'hardware' ? (
					<HardwarePanel d={d} />
				) : tab === 'cloudinit' ? (
					<CloudInitPanel d={d} />
				) : tab === 'options' ? (
					<OptionsPanel d={d} />
				) : tab === 'network' ? (
					<PortForwarding machine={m} />
				) : tab === 'usb' ? (
					<DevicesPanel guest={{kind: 'machine', id: m.id, name: m.name}} />
				) : tab === 'snapshots' ? (
					<SnapshotsPanel d={d} />
				) : tab === 'backups' ? (
					<BackupsPanel d={d} />
				) : tab === 'history' ? (
					<HistoryPanel d={d} />
				) : (
					<MonitorPanel d={d} />
				)}
			</div>
			<div className="stack" style={{marginTop: 18}}>
				<button className="btn danger block" onClick={() => power.remove(onClose)} disabled={busy}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</Sheet>
	)
}
