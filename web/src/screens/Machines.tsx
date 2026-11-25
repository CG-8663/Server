import {lazy, Suspense, useEffect, useMemo, useState} from 'react'

import {SERVER_DESKTOP, type Machine, type UserApp} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useDesktop} from '../desktop/Desktop'
import {useBootstrap, useMachines, useUser} from '../data'
import {useMachineDetails} from '../machines/api'
import {PortForwarding} from '../machines/PortForwarding'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from '../machines/panels'
import {DevicesPanel} from '../usb'
import {Icon} from '../icons'
import {osLook} from '../osLook'
import {hostedVms} from '../fleet/hostedVms'
import {computerFleetInput, fleetList, guestFleetInput, SERVER_FLEET_ID} from '../fleet/list'
import {OPEN_FLEET, takePendingFleet, type FleetOpen} from '../fleet/openMember'
import {openStore} from '../fleet/openStore'
import {GuestLive} from '../fleet/GuestLive'
import {MachineShell, MachineTabs, type MachineTab} from '../fleet/MachineTabs'
import {PinButton} from '../fleet/PinButton'
import {ServerSheet} from '../fleet/ServerSheet'
import {guestAgent, isGuestAgent} from '../swarm/guestLink'
import {LocalSwarm, useSwarm} from '../swarm/Swarm'
import {StoragePanel} from './Storage'
import {SheetHeader, StatusPill, haptic, machineStatus} from '../ui'
import {MachineManager} from '../fleet/MachineManager'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const CreateMachine = lazy(() => import('../CreateMachine').then((m) => ({default: m.CreateMachine})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

export function Machines({onOpenApp, onTerminal, windowId}: {onOpenApp?: (app: UserApp) => void; onTerminal?: () => void; windowId?: string} = {}) {
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
	const list = machines.data ?? []
	const serverName = boot.server?.device || 'This server'
	const agents = swarm.data ?? []
	const members = useMemo(
		() =>
			fleetList({
				server: {name: serverName},
				computers: agents.filter((a) => !isGuestAgent(a)).map((a) => computerFleetInput({id: a.id, name: a.name, online: a.online, allowed: a.allowed, on: a.on, libvirt: a.libvirt === true})),
				guests: list.map((m) => guestFleetInput({id: m.id, name: m.name, state: m.state, hostId: m.hostId, connector: !!guestAgent(agents, m.id)})),
			}),
		[serverName, agents, list],
	)
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleAgent = consoleId?.startsWith('agent-') ? agents.find((a) => `agent-${a.id}` === consoleId) : undefined
	const consoleMachine =
		consoleId === 'desktop' ? SERVER_DESKTOP : consoleAgent ? {id: `agent-${consoleAgent.id}`, name: consoleAgent.name, state: 'running' as const} : (list.find((m) => m.id === consoleId) ?? null)
	const online = members.filter((m) => m.online).length
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
	const openDesktop = () => {
		haptic(8)
		if (!desk) setServerOpen(false)
		if (desk) desk.openConsole('desktop')
		else setConsoleId('desktop')
	}
	// The machine page is a sheet on the phone and a pane in the Machines window on the desktop.
	// Leave it open and the terminal paints behind it. Close it, then open the terminal.
	const openServerTerminal = () => {
		setServerOpen(false)
		if (desk) {
			desk.openTerminal()
			if (windowId) desk.close(windowId)
			return
		}
		onTerminal?.()
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
			<LocalSwarm
				bare={wide}
				hideList
				selectedId={computerId}
				onSelect={(id) => (id ? openMember('computer', id) : setComputerId(null))}
				adding={adding}
				onAdding={setAdding}
				vms={list}
				onCreateVm={setCreateHost}
				onOpenVm={(id) => openMember('guest', id)}
			/>
			{serverOpen && (
				<ServerSheet
					bare={wide}
					name={serverName}
					owner={owner}
					vms={hostedVms(list, SERVER_FLEET_ID)}
					onClose={() => setServerOpen(false)}
					onDesktop={openDesktop}
					onTerminal={openServerTerminal}
					onOpenVm={(id) => openMember('guest', id)}
					onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
				/>
			)}
		</>
	)
	const manager = (
		<MachineManager
			owner={owner}
			serverTerminal={!!onTerminal}
			online={online}
			total={members.length}
			loading={machines.isLoading}
			problem={problem}
			swarmProblem={swarmProblem}
			members={members}
			machines={list}
			agents={agents}
			onManage={openMember}
			onServerTerminal={openServerTerminal}
			onServerDesktop={openDesktop}
			onGuestDesktop={(id) => {
				haptic(8)
				if (desk) desk.openConsole(id)
				else setConsoleId(id)
			}}
			onAddComputer={() => setAdding(true)}
			onCreateVm={() => setCreateHost({id: SERVER_FLEET_ID, name: serverName})}
		/>
	)
	return (
		<div className={wide ? 'machines-frame' : 'stagger'}>
			{wide && (selected || computerId || serverOpen) ? (
				<div className="machines-split">
					<div className="machines-list">{manager}</div>
					<div className="machines-detail">{detail}</div>
				</div>
			) : (
				<>
					{manager}
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
	const [guestTerm, setGuestTerm] = useState<{id: string; name: string; input?: string} | null>(null)
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

	if (guestTerm) {
		return (
			<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
				<TerminalScreen agent={{id: guestTerm.id, name: guestTerm.name}} input={guestTerm.input} onClose={() => setGuestTerm(null)} />
			</Suspense>
		)
	}

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
			{m.errorMessage && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{/^\[[\w-]+\]$/.test(m.errorMessage) ? m.errorMessage.slice(1, -1).replace(/-/g, ' ') : m.errorMessage}
				</div>
			)}
			<GuestLive machine={m} pin={<PinButton pin={{kind: 'vm', id: m.id, computer: SERVER_FLEET_ID}} name={m.name} />} onOpenStore={() => (onClose(), openStore({id: m.id, kind: 'guest', name: m.name}))} onOpenDesktop={onConsole} onOpenStorage={setStorage} onBackups={() => setTab('backups')} onOpenTerminal={(agent, input) => setGuestTerm({id: agent.id, name: agent.name, input})} tabs={(sections) => {
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
