import {lazy, Suspense, useState, type ReactNode} from 'react'

import type {Machine} from '../api'
import {Icon} from '../icons'
import {useStats} from '../machines/api'
import {extraDisks, rootDisk} from '../swarm/gauges'
import {guestAgent, hostGuestMetrics, linuxConnectorOs} from '../swarm/guestLink'
import {storageRowSub} from '../swarm/storageHint'
import {AddComputer, ConnectorControls, agentMay, useSwarm} from '../swarm/Swarm'
import {Row, Sheet, SheetHeader, bytes, duration, haptic} from '../ui'
import {GaugeCluster} from './serverGauges'
import {MachineActions} from './machineActions'
import {openStore} from './openStore'
import {SheetGroup} from './sheetGroup'

const Console = lazy(() => import('../Console').then((m) => ({default: m.Console})))
const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))
const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

const pct = (u?: {total: number; used: number}) => (u && u.total ? Math.round((100 * u.used) / u.total) : null)

/**
 * The computer sections of a virtual machine. Power, USB, and snapshots stay with the host page.
 * Terminal is the connector shell. Desktop is the virtual machine's screen.
 * Files and gauges use the guest's connector when it is installed.
 */
export type GuestSections = {files?: ReactNode; apps?: ReactNode; storage?: ReactNode; backups?: ReactNode; manage?: ReactNode}

export function GuestLive({machine, onOpenStore, onOpenDesktop, onOpenStorage, onBackups, onOpenTerminal, tabs}: {machine: Machine; onOpenStore?: () => void; onOpenDesktop?: () => void; onOpenStorage: (target: {agentId: string; name: string}) => void; onBackups?: () => void; onOpenTerminal?: (agent: {id: string; name: string}, input?: string) => void; tabs: (sections: GuestSections) => ReactNode}) {
	const swarm = useSwarm()
	const agent = guestAgent(swarm.data ?? [], machine.id)
	const [install, setInstall] = useState(false)
	const [terminal, setTerminal] = useState<{input?: string} | null>(null)
	const [desktop, setDesktop] = useState(false)
	const [storageNote, setStorageNote] = useState(false)
	const live = machine.state === 'running' && !!agent?.online
	const metrics = agent?.online ? agent.metrics : null
	const stats = useStats(machine.id, machine.state === 'running' && !metrics)
	const host = !metrics && machine.state === 'running' ? hostGuestMetrics(stats.data?.last, machine.memoryMb ?? (machine.memoryGb ? machine.memoryGb * 1024 : 0), machine.cores ?? 0) : null
	const disk = metrics ? rootDisk(metrics.disks ?? []) : undefined
	const linux = linuxConnectorOs(machine.osId)
	const canStorage = !!(agent?.online && agentMay(agent, 'storage'))
	const storageSub = !linux
		? 'The connector runs on Linux with systemd. It can’t manage drives here.'
		: !agent
			? 'Install the connector and allow Storage.'
			: !agent.online
				? 'Offline.'
				: storageRowSub(agent.allowed.storage, agent.on.storage)
	const openTerminal = (input?: string) => {
		if (onOpenTerminal && agent) {
			onOpenTerminal({id: agent.id, name: machine.name}, input)
			return
		}
		setTerminal({input})
	}
	const hostScreen = !!onOpenDesktop && machine.state === 'running'
	const connectorDesktop = live && !!agent && agentMay(agent, 'desktop') && agent.info?.desktop?.ok !== false
	return (
		<>
			<MachineActions terminal={live && !!agent && agentMay(agent, 'terminal')} desktop={hostScreen || connectorDesktop} onTerminal={() => openTerminal()} onDesktop={() => (onOpenDesktop && machine.state === 'running' ? onOpenDesktop() : setDesktop(true))} />
			{swarm.isFetched && !agent && linux && (
				<div className="actions">
					<button type="button" className="btn primary" onClick={() => (haptic(6), setInstall(true))}>
						<Icon name="plus" size={20} /> Install connector
					</button>
				</div>
			)}
			{swarm.isFetched && !agent && !linux && <p className="quiet">The connector runs on Linux with systemd. It can’t be installed on this guest.</p>}
			{metrics ? <GaugeCluster metrics={metrics} /> : host ? <GaugeCluster metrics={host} /> : null}
			<SheetGroup title="Now">
				<Row
					icon="disk"
					color="var(--teal)"
					label={disk && disk.mount !== '/' ? disk.mount : 'Disk'}
					sub={disk ? `${bytes(disk.used, 1)} of ${bytes(disk.total, 0)}` : machine.diskSizeGb ? `${machine.diskSizeGb} GB` : undefined}
					trailing={disk ? <b>{pct(disk)}%</b> : undefined}
				/>
				{extraDisks(metrics?.disks).map((d) => (
					<Row key={d.mount} icon="disk" color="#f0a020" label={d.mount} sub={`${bytes(d.used)} of ${bytes(d.total)}`} trailing={<b>{pct(d)}%</b>} />
				))}
				{typeof metrics?.temp === 'number' && <Row icon="thermo" color="#ef5350" label="Temperature" trailing={<b>{Math.round(metrics.temp)}°C</b>} />}
				{metrics?.uptime !== undefined && <Row icon="clock" color="#8e8e93" label="Up for" trailing={<b>{duration(metrics.uptime)}</b>} />}
			</SheetGroup>
			{tabs({
				files:
					live && agent && agentMay(agent, 'files') ? (
						<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
							<MachineFiles scope={{kind: 'computer', id: agent.id, name: machine.name}} windowId={`guest:${machine.id}`} />
						</Suspense>
					) : undefined,
				apps: live ? (
					<Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${machine.name}`} onClick={() => (haptic(6), onOpenStore ? onOpenStore() : openStore({id: machine.id, kind: 'guest', name: machine.name}))} />
				) : undefined,
				storage: <Row icon="disk" color="var(--teal)" label="Storage" sub={storageSub} onClick={() => (haptic(8), canStorage && agent ? onOpenStorage({agentId: agent.id, name: machine.name}) : setStorageNote(true))} />,
				backups: onBackups ? <Row icon="history" color="var(--green)" label="Backups" sub="Back up this virtual machine" onClick={() => (haptic(8), onBackups())} /> : undefined,
				manage: agent ? <ConnectorControls a={agent} onTerminal={openTerminal} /> : undefined,
			})}
			{storageNote && (
				<Sheet open onClose={() => setStorageNote(false)} label="Storage">
					<SheetHeader title="Storage" subtitle={machine.name} onClose={() => setStorageNote(false)} />
					<p className="prose" style={{fontSize: 14.5}}>
						{storageSub}
					</p>
					{!agent && linux && (
						<button type="button" className="btn primary" onClick={() => (setStorageNote(false), setInstall(true))}>
							<Icon name="plus" size={18} /> Install connector
						</button>
					)}
				</Sheet>
			)}
			{install && (
				<AddComputer
					guest={{id: machine.id, name: machine.name}}
					before={(swarm.data ?? []).map((a) => a.id)}
					onClose={() => setInstall(false)}
					onJoined={() => setInstall(false)}
				/>
			)}
			{terminal && !onOpenTerminal && agent && (
				<Suspense fallback={null}>
					<TerminalScreen agent={{id: agent.id, name: machine.name}} input={terminal.input} onClose={() => setTerminal(null)} />
				</Suspense>
			)}
			{desktop && agent && (
				<Suspense fallback={null}>
					<Console machine={{id: `agent-${agent.id}`, name: machine.name, state: 'running'}} onClose={() => setDesktop(false)} />
				</Suspense>
			)}
		</>
	)
}
