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
import {GuestLive} from '../fleet/GuestLive'
import {MachineShell, MachineTabs, type MachineTab} from '../fleet/MachineTabs'
import {PinButton} from '../fleet/PinButton'
import {ServerSheet} from '../fleet/ServerSheet'
import {ServerSpecs} from '../fleet/serverGauges'
import {guestAgent, isGuestAgent} from '../swarm/guestLink'
import {AgentCard, LocalSwarm, useSwarm} from '../swarm/Swarm'
import {StoragePanel} from './Storage'
import {SheetHeader, StatusPill, haptic, machineStatus} from '../ui'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const CreateMachine = lazy(() => import('../CreateMachine').then((m) => ({default: m.CreateMachine})))

export function Machines({onOpenApp, onTerminal}: {onOpenApp?: (app: UserApp) => void; onTerminal?: () => void} = {}) {
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
	const [createHost, setCreateHost] = useState<{id: string; name: string} | null>(null)
	const [adding, setAdding] = useState(false)
	const [expanded, setExpanded] = useState<string | null>(null)
	const apps = useApps()
	const list = machines.data ?? []
	const serverName = boot.server?.device || 'This server'
	const agents = swarm.data ?? []
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: agents.filter((a) => !isGuestAgent(a)).map((a) => ({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on})),
				guests: list.map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state, connector: !!guestAgent(agents, m.id)})),
			}),
		[serverName, agents, list],
	)
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleMachine = consoleId === 'desktop' ? SERVER_DESKTOP : (list.find((m) => m.id === consoleId) ?? null)
	const online = members.filter((m) => m.online).length
	const computers = members.filter((m) => m.kind === 'computer')
	const agentById = new Map(agents.filter((a) => !isGuestAgent(a)).map((a) => [a.id, a]))
	useEffect(() => {
		const apply = (member: FleetOpen | null | undefined) => {
			if (!member) return
			setSelectedId(member.kind === 'guest' ? member.id : null)
			setComputerId(member.kind === 'computer' ? member.id : null)
			setServerOpen(member.kind === 'server')
		}
		apply(takePendingFleet())
		const onOpen = (e: Event) => {
			takePendingFleet()
			apply((e as CustomEvent<FleetOpen>).detail)
		}
		window.addEventListener(OPEN_FLEET, onOpen)
		return () => window.removeEventListener(OPEN_FLEET, onOpen)
	}, [])
	const openMember = (kind: 'server' | 'computer' | 'guest', id: string) => {
		setSelectedId(kind === 'guest' ? id : null)
		setComputerId(kind === 'computer' ? id : null)
		setServerOpen(kind === 'server')
	}
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
				onOpenVm={(id) => (haptic(6), openMember('guest', id))}
				onCreateVm={vmsAbility.granted ? () => setCreateHost({id: memberId, name: memberName}) : undefined}
			/>
		)
	}
	const openDesktop = () => {
		haptic(8)
		if (!desk) setServerOpen(false)
		if (desk) desk.openConsole('desktop')
		else setConsoleId('desktop')
	}
	const wide = desk != null
	const detail = (
		<>
			{selected && !consoleMachine && (
				<MachineSheet
					bare={wide}
					machine={selected}
					onClose={() => setSelectedId(null)}
					onConsole={() => {
						haptic(8)
						if (desk) desk.openConsole(selected.id)
						else setConsoleId(selected.id)
					}}
				/>
			)}
			<LocalSwarm bare={wide} hideList selectedId={computerId} onSelect={(id) => (id ? openMember('computer', id) : setComputerId(null))} adding={adding} onAdding={setAdding} />
			{serverOpen && (
				<ServerSheet
					bare={wide}
					name={serverName}
					owner={owner}
					vms={list}
					onClose={() => setServerOpen(false)}
					onDesktop={openDesktop}
					onTerminal={desk ? () => desk.openTerminal() : onTerminal}
					onOpenVm={(id) => openMember('guest', id)}
					onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
				/>
			)}
		</>
	)
	const listBody = (
		<>
			<div style={{position: 'relative'}}>
				<button className="btn primary small" style={{position: 'absolute', right: 4, top: 14}} onClick={() => (haptic(6), setCreateHost({id: SERVER_FLEET_ID, name: serverName}))}>
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
			{members.filter((member) => member.kind === 'server').map((member) => renderMember(member))}
			{!machines.isLoading && (
				<>
					<div className="section-head machines-section">
						<h2>Virtual machines</h2>
						<span className="quiet">{list.length ? `${list.filter((m) => m.state === 'running').length} of ${list.length} running` : 'On this server'}</span>
					</div>
					{list.length === 0 ? (
						<div className="glass machines-empty">
							<p className="quiet">No virtual machines on {serverName} yet.</p>
							<button type="button" className="btn small" onClick={() => (haptic(6), setCreateHost({id: SERVER_FLEET_ID, name: serverName}))}>
								<Icon name="plus" size={15} /> Create a virtual machine
							</button>
						</div>
					) : (
						list.map((m) => (
							<VmCard
								key={m.id}
								m={m}
								onOpen={() => (haptic(6), openMember('guest', m.id))}
								onConsole={() => {
									haptic(8)
									if (desk) desk.openConsole(m.id)
									else setConsoleId(m.id)
								}}
							/>
						))
					)}
				</>
			)}
			{(owner || computers.length > 0) && (
				<div className="section-head machines-section">
					<h2>Connected computers</h2>
					<span className="quiet">{computers.length ? `${computers.filter((m) => m.online).length} of ${computers.length} online` : 'Other computers joined to this server'}</span>
				</div>
			)}
			{owner && computers.length === 0 && !swarm.isLoading && (
				<div className="glass machines-empty">
					<p className="quiet">No computers connected yet. Add one to manage it from here.</p>
				</div>
			)}
			{computers.map((member) => renderMember(member))}
		</>
	)

	function renderMember(member: (typeof members)[number]) {
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
									<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 4}}>{member.meta}</span>
								</span>
								<StatusPill kind="running" label="Online" />
								<button type="button" className="btn small" onClick={() => (haptic(6), openMember('server', member.id))}>
									Open
								</button>
							</span>
							<ServerSpecs />
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
				const agent = agentById.get(member.id)
				if (!agent) return null
				return (
					<AgentCard
						key={member.id}
						className={`mrow${open ? ' is-open' : ''}`}
						a={agent}
						onClick={() => (haptic(6), openMember('computer', agent.id))}
						footer={
							<div className="mrow-foot">
								<PinButton pin={{kind: 'machine', id: agent.id, computer: ''}} name={agent.name} />
								<Disc open={open} name={agent.name} controls={`glance-${member.id}`} onClick={toggle} />
							</div>
						}
						extra={open ? <div className="mrow-body" id={`glance-${member.id}`}>{glanceFor(member.id, member.name, 'computer')}</div> : null}
					/>
				)
	}

	return (
		<div className={wide ? 'machines-frame' : 'stagger'}>
			{wide && (selected || computerId || serverOpen) ? (
				<div className="machines-split">
					<div className="machines-list">{listBody}</div>
					<div className="machines-detail">{detail}</div>
				</div>
			) : (
				<>
					{listBody}
					{detail}
				</>
			)}
			{createHost && (
				<Suspense
					fallback={
						<main className="screen center">
							<span className="spinner" aria-label="Loading" />
						</main>
					}
				>
					<CreateMachine open host={createHost} onClose={() => setCreateHost(null)} />
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

function MachineSheet({machine: m, onClose, onConsole, bare}: {machine: Machine; onClose: () => void; onConsole: () => void; bare?: boolean}) {
	const status = machineStatus(m.state)
	const details = useMachineDetails(m.id)
	const d = details.data
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const busy = status.kind === 'busy' || power.pending
	const os = osLook(m.osId)
	// A machine that isn't running opens on Power, where Start is.
	const [tab, setTab] = useState(m.state === 'running' ? 'files' : 'power')
	const [storage, setStorage] = useState<{agentId: string; name: string} | null>(null)
	const hostTabs = PANELS.filter((p) => p.id !== 'console' && p.id !== 'backups' && (p.id !== 'cloudinit' || d?.cloudInit))
	const panel = (id: PanelId) => {
		if (!d) return <div className="skeleton" style={{height: 160, borderRadius: 20}} />
		if (id === 'summary') return <SummaryPanel d={d} />
		if (id === 'hardware') return <HardwarePanel d={d} />
		if (id === 'cloudinit') return <CloudInitPanel d={d} />
		if (id === 'options') return <OptionsPanel d={d} />
		if (id === 'network') return <PortForwarding machine={m} />
		if (id === 'usb') return <DevicesPanel guest={{kind: 'machine', id: m.id, name: m.name}} />
		if (id === 'snapshots') return <SnapshotsPanel d={d} />
		if (id === 'history') return <HistoryPanel d={d} />
		return <MonitorPanel d={d} />
	}
	const powerBody = (
		<>
			<div className="actions mx-power">
				{m.state !== 'running' && (
					<button className="action" onClick={power.paused ? power.resume : power.start} disabled={busy || !(power.canStart || power.paused)}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={22} />}
						{busy ? 'Working…' : m.state === 'hibernated' || power.paused ? 'Resume' : 'Start'}
					</button>
				)}
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
			<div className="stack" style={{marginTop: 18}}>
				<button className="btn danger block" onClick={() => power.remove(onClose)} disabled={busy}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</>
	)

	if (storage) return <StoragePanel bare={bare} target={storage} onClose={() => setStorage(null)} />

	return (
		<MachineShell bare={bare} label={m.name} onClose={onClose}>
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
			<GuestLive machine={m} onOpenStore={() => (onClose(), openStore({id: m.id, kind: 'guest', name: m.name}))} onOpenDesktop={onConsole} onOpenStorage={setStorage} onBackups={() => setTab('backups')} tabs={(sections) => {
				const rows: MachineTab[] = [
					...(sections.files ? [{id: 'files', label: 'Files', body: sections.files}] : []),
					...(sections.apps ? [{id: 'apps', label: 'Apps', body: sections.apps}] : []),
					...(sections.storage ? [{id: 'storage', label: 'Storage', body: sections.storage}] : []),
					...(sections.backups ? [{id: 'backups', label: 'Backups', body: d ? <BackupsPanel d={d} /> : sections.backups}] : []),
					{id: 'power', label: 'Power', body: powerBody},
					...(sections.manage ? [{id: 'manage', label: 'Manage', body: sections.manage}] : []),
					...hostTabs.map((p) => ({id: p.id, label: p.label, body: panel(p.id)})),
				]
				return <MachineTabs label={`${m.name} sections`} tabs={rows} tab={tab} onTab={setTab} />
			}} />
		</MachineShell>
	)
}

// A virtual machine on this server, in its own section of the Machines list.
// Start, stop and the rest are right on it; Open has everything else.
function VmCard({m, onOpen, onConsole}: {m: Machine; onOpen: () => void; onConsole: () => void}) {
	const os = osLook(m.osId)
	const power = usePowerActions({id: m.id, name: m.name, state: m.state, protected: m.protected})!
	const status = machineStatus(m.state)
	const busy = status.kind === 'busy' || power.pending || !!m.pending
	const memory = m.memoryGb ?? (m.memoryMb ? Math.round(m.memoryMb / 1024) : undefined)
	const meta = [os.name, m.cores ? `${m.cores} CPU` : '', memory ? `${memory} GB` : '', m.state === 'running' && m.ipAddress ? m.ipAddress : ''].filter(Boolean).join(' · ')
	return (
		<article className="glass vm-card mrow">
			<span className="top">
				<span className="vm-os" style={{background: os.bg}}>
					<Icon name={os.icon} size={26} />
				</span>
				<span className="main" style={{flex: 1, minWidth: 0}}>
					<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{m.name}</b>
					<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 4}}>{meta || 'Virtual machine'}</span>
				</span>
				<StatusPill {...machineStatus(m.state)} />
				<button type="button" className="btn small" onClick={onOpen}>
					Open
				</button>
			</span>
			<div className="vm-controls" role="group" aria-label={`${m.name} power`}>
				{busy ? (
					<span className="vm-working">
						<span className="spinner" /> Working…
					</span>
				) : power.paused ? (
					<>
						<button type="button" className="btn small primary" onClick={power.resume}>
							<Icon name="play" size={16} /> Resume
						</button>
						<button type="button" className="btn small" onClick={power.stop}>
							<Icon name="stop" size={16} /> Stop
						</button>
					</>
				) : m.state === 'running' ? (
					<>
						<button type="button" className="btn small" onClick={onConsole}>
							<Icon name="window" size={16} /> Console
						</button>
						<button type="button" className="btn small" onClick={power.shutdown}>
							<Icon name="power" size={16} /> Shut down
						</button>
						<button type="button" className="btn small" onClick={power.reboot}>
							<Icon name="restart" size={16} /> Reboot
						</button>
						<button type="button" className="btn small" onClick={power.pause}>
							<Icon name="pulse" size={16} /> Pause
						</button>
					</>
				) : power.canStart ? (
					<button type="button" className="btn small primary" onClick={power.start}>
						<Icon name="play" size={16} /> {m.state === 'hibernated' ? 'Resume' : 'Start'}
					</button>
				) : null}
			</div>
		</article>
	)
}
