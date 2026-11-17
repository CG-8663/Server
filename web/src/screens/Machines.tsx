import {lazy, Suspense, useState} from 'react'

import {SERVER_DESKTOP, type Machine} from '../api'
import {useDesktop} from '../desktop/Desktop'
import {useMachines} from '../data'
import {useMachineDetails} from '../machines/api'
import {PortForwarding} from '../machines/PortForwarding'
import {BackupsPanel, CloudInitPanel, HardwarePanel, HistoryPanel, MonitorPanel, OptionsPanel, PANELS, SnapshotsPanel, SummaryPanel, usePowerActions, type PanelId} from '../machines/panels'
import {Icon} from '../icons'
import {osLook} from '../osLook'
import {Sheet, SheetHeader, StatusPill, haptic, machineStatus} from '../ui'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const CreateMachine = lazy(() => import('../CreateMachine').then((m) => ({default: m.CreateMachine})))
const LocalSwarm = lazy(() => import('../swarm/Swarm').then((m) => ({default: m.LocalSwarm})))

export function Machines() {
	const desk = useDesktop()
	const machines = useMachines()
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [consoleId, setConsoleId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const list = machines.data ?? []
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleMachine = consoleId === 'desktop' ? SERVER_DESKTOP : (list.find((m) => m.id === consoleId) ?? null)
	const running = list.filter((m) => m.state === 'running').length

	return (
		<div className="stagger">
			<div style={{position: 'relative'}}>
				<button
					className="btn primary small"
					style={{position: 'absolute', right: 4, top: 14}}
					onClick={() => {
						haptic(6)
						setCreating(true)
					}}
				>
					<Icon name="plus" size={18} stroke={2.4} /> New
				</button>
				<h1 className="title">Machines</h1>
				<p className="subtitle">{machines.isLoading ? 'Loading…' : list.length ? `${running} of ${list.length} running` : 'Virtual machines on your server'}</p>
			</div>
			<button
				className="glass vm-card desktop-card"
				onClick={() => {
					haptic(8)
					if (desk) desk.openConsole('desktop')
					else setConsoleId('desktop')
				}}
			>
				<span className="vm-ico" style={{background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)', width: 52, height: 52, borderRadius: 15, display: 'grid', placeItems: 'center', color: '#fff'}}>
					<Icon name="terminal" size={26} />
				</span>
				<span className="main" style={{display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', flex: 1, minWidth: 0}}>
					<b style={{fontSize: 17}}>Omarchy desktop</b>
					<span className="muted" style={{fontSize: 13}}>This server’s own desktop, live. Needs someone signed in to Omarchy on the server.</span>
				</span>
				<Icon name="chevron" size={18} className="chev" />
			</button>
			{machines.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(machines.error as Error).message}
				</div>
			)}
			{machines.isLoading && Array.from({length: 2}, (_, i) => <div key={i} className="skeleton" style={{height: 130, borderRadius: 26, marginBottom: 12}} />)}
			{list.map((m) => {
				const os = osLook(m.osId)
				return (
					<button
						key={m.id}
						className="glass vm-card press"
						onClick={() => {
							haptic(6)
							setSelectedId(m.id)
						}}
					>
						<span className="top">
							<span className="vm-os" style={{background: os.bg, filter: m.state === 'running' ? undefined : 'saturate(.7) brightness(.9)'}}>
								<Icon name={os.icon} size={26} />
							</span>
							<span className="main" style={{flex: 1, minWidth: 0}}>
								<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{m.name}</b>
								<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>
									{m.vmid !== undefined ? `${m.vmid} · ` : ''}
									{os.name}
									{m.pending ? ' · changes pending' : ''}
								</span>
							</span>
							<StatusPill {...machineStatus(m.state)} />
						</span>
						{m.state === 'installing' && m.installProgress !== undefined ? (
							<span className="progress" aria-label={`Installing ${m.installProgress}%`}>
								<i style={{width: `${m.installProgress}%`}} />
							</span>
						) : (
							<span className="specs">
								{m.cores ? (
									<span className="spec">
										<Icon name="cpu" size={14} /> {m.cores} cores
									</span>
								) : null}
								{m.memoryGb ? (
									<span className="spec">
										<Icon name="memory" size={14} /> {m.memoryGb} GB
									</span>
								) : null}
								{m.diskSizeGb ? (
									<span className="spec">
										<Icon name="disk" size={14} /> {m.diskSizeGb} GB
									</span>
								) : null}
							</span>
						)}
					</button>
				)
			})}
			{!machines.isLoading && !machines.error && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="machine" size={30} />
					</span>
					<b>No machines yet</b>
					<span>Run Ubuntu, Debian, Windows and more right on your server.</span>
					<button className="btn primary small" onClick={() => setCreating(true)}>
						Create a machine
					</button>
				</div>
			)}
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
			<Suspense
				fallback={
					<main className="screen center">
						<span className="spinner" aria-label="Loading" />
					</main>
				}
			>
				<LocalSwarm />
			</Suspense>
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
			{m.errorMessage && (
				<div className="error">
					<Icon name="alert" size={18} />
					{m.errorMessage.replace(/^\[|\]$/g, '').replace(/-/g, ' ')}
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
