// Containers (LXC, run by Incus in its per-user mode) on this server: the library of Linux systems,
// and each container's power, terminal, ports and snapshots. Owner-only, like the server's terminal.
import {Suspense, lazy, useState, type CSSProperties} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {openTerminalWith} from '../terminalEvent'
import {Group, Row, StatusPill, haptic, useConfirm, useToast} from '../ui'

const TerminalScreen = lazy(() => import('../Terminal').then((m) => ({default: m.TerminalScreen})))

export type ContainerStatus = {available: true; version: string | null} | {available: false; reason: string; setupCommand: string}
export type Container = {
	name: string
	status: string
	os: string
	release: string
	description: string
	cpus: number | null
	memory: string | null
	disk: string | null
	memoryUsedGiB: number | null
	addresses: {family: string; address: string}[]
	ports: {protocol: 'tcp' | 'udp'; hostPort: number; containerPort: number | null}[]
	snapshots: {name: string; createdAt: string | null}[]
	error?: string | null
}
type Distro = {os: string; name: string; releases: {alias: string; release: string; description: string}[]}

const OS_LOOK: Record<string, {bg: string}> = {
	debian: {bg: 'linear-gradient(140deg,#d70a53,#a80030)'},
	ubuntu: {bg: 'linear-gradient(140deg,#f47421,#c34113)'},
	alpine: {bg: 'linear-gradient(140deg,#2d6ab3,#0d597f)'},
	archlinux: {bg: 'linear-gradient(140deg,#1793d1,#0f5f8a)'},
	fedora: {bg: 'linear-gradient(140deg,#3c6eb4,#294172)'},
	rockylinux: {bg: 'linear-gradient(140deg,#10b981,#047857)'},
	almalinux: {bg: 'linear-gradient(140deg,#0f4266,#082d47)'},
	opensuse: {bg: 'linear-gradient(140deg,#73ba25,#35b9ab)'},
}
const look = (os: string) => OS_LOOK[os] ?? {bg: 'linear-gradient(140deg,#4b5563,#1f2937)'}

/** What the list shows for a container's state. */
export function containerPill(status: string): {kind: 'running' | 'stopped' | 'busy' | 'error'; label: string} {
	if (status === 'running') return {kind: 'running', label: 'running'}
	if (status === 'stopped') return {kind: 'stopped', label: 'stopped'}
	if (status === 'creating' || status === 'starting' || status === 'stopping') return {kind: 'busy', label: status}
	if (status === 'frozen') return {kind: 'stopped', label: 'paused'}
	return {kind: 'error', label: status === 'error' ? 'failed' : status}
}

function useContainers(enabled: boolean) {
	return useQuery({
		queryKey: ['containers.list'],
		queryFn: () => query<Container[]>('containers.list'),
		enabled,
		refetchInterval: (q) => ((q.state.data ?? []).some((c) => containerPill(c.status).kind === 'busy') ? 2000 : 8000),
	})
}

function useContainerAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input: unknown; done?: string}) => mutate(a.path, a.input),
		onSuccess: (_r, a) => a.done && toast(a.done),
		onError: (e: Error) => toast(e.message.replace(/^[A-Z_]+: /, ''), true),
		onSettled: () => qc.invalidateQueries({queryKey: ['containers.list']}),
	})
}

export function ContainersPanel({serverName}: {serverName: string}) {
	const status = useQuery({queryKey: ['containers.status'], queryFn: () => query<ContainerStatus>('containers.status'), retry: false})
	const ready = status.data?.available === true
	const list = useContainers(ready)
	const [open, setOpen] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	if (status.isLoading) return <div className="skeleton" style={{height: 120, borderRadius: 16}} />
	if (status.data && !status.data.available) return <SetUp status={status.data} onCheck={() => status.refetch()} checking={status.isFetching} />
	if (status.isError) return <p className="quiet">{(status.error as Error).message}</p>

	const rows = list.data ?? []
	const current = open ? rows.find((c) => c.name === open) : null
	if (open && current) return <ContainerDetail c={current} onBack={() => setOpen(null)} />
	if (creating) return <CreateContainer onDone={(name) => (setCreating(false), name && setOpen(null))} existing={rows.map((c) => c.name)} />
	return (
		<>
			{list.isLoading ? (
				<div className="skeleton" style={{height: 80, borderRadius: 16}} />
			) : rows.length === 0 ? (
				<p className="quiet">No containers on {serverName}. A container is a lightweight Linux system that shares this server’s kernel: it starts in seconds and uses far less memory than a virtual machine.</p>
			) : (
				rows.map((c) => {
					const pill = containerPill(c.status)
					return (
						<Row
							key={c.name}
							icon="category"
							color={pill.kind === 'running' ? 'var(--green)' : pill.kind === 'error' ? 'var(--red)' : 'var(--muted)'}
							label={c.name}
							sub={[c.os && `${c.os} ${c.release}`.trim(), c.addresses.find((a) => a.family === 'IPv4')?.address].filter(Boolean).join(' · ') || 'Container'}
							trailing={<StatusPill {...pill} />}
							onClick={() => (haptic(6), setOpen(c.name))}
						/>
					)
				})
			)}
			<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), setCreating(true))}>
				<Icon name="plus" size={15} /> New container
			</button>
		</>
	)
}

function SetUp({status, onCheck, checking}: {status: Extract<ContainerStatus, {available: false}>; onCheck: () => void; checking: boolean}) {
	const toast = useToast()
	return (
		<div className="glass" style={{padding: 16, display: 'grid', gap: 12}}>
			<b>Set up containers</b>
			<span className="quiet">{status.reason}</span>
			<span className="quiet">
				Containers run on Incus in its per-user mode: your account gets its own walled-off space for them, and nothing is opened to the network until you add a port. Setting it up needs your password once, so run this in a terminal on this server, then restart the server:
			</span>
			<pre className="mono" style={{fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0}}>
				{status.setupCommand}
			</pre>
			<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
				<button type="button" className="btn small" onClick={() => (haptic(6), openTerminalWith(status.setupCommand))}>
					<Icon name="terminal" size={15} /> Open in Terminal
				</button>
				<button
					type="button"
					className="btn small"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(status.setupCommand)
							toast('Copied')
						} catch {
							toast('Couldn’t copy here. Select the text instead.', true)
						}
					}}
				>
					<Icon name="copy" size={15} /> Copy
				</button>
				<button type="button" className="btn small" disabled={checking} onClick={onCheck}>
					{checking ? <span className="spinner" /> : <Icon name="restart" size={15} />} Check again
				</button>
			</div>
		</div>
	)
}

const NAME = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

function CreateContainer({onDone, existing}: {onDone: (name?: string) => void; existing: string[]}) {
	const library = useQuery({queryKey: ['containers.images'], queryFn: () => query<Distro[]>('containers.images'), staleTime: 30 * 60_000, retry: false})
	const action = useContainerAction()
	const [alias, setAlias] = useState<string | null>(null)
	const [name, setName] = useState('')
	const [cpus, setCpus] = useState('1')
	const [memory, setMemory] = useState('1024')
	const [disk, setDisk] = useState('8')
	const picked = library.data?.flatMap((d) => d.releases.map((r) => ({...r, distro: d}))).find((r) => r.alias === alias)
	const nameProblem = !name ? 'Give it a name' : !NAME.test(name) ? 'Lowercase letters, numbers and dashes, starting with a letter' : existing.includes(name) ? 'That name is taken' : null
	const create = () =>
		action.mutate(
			{path: 'containers.create', input: {name, image: alias, cpus: Number(cpus), memoryMiB: Number(memory), diskGiB: Number(disk)}, done: `Creating ${name}. The first container of a system takes a minute to download.`},
			{onSuccess: () => onDone(name)},
		)
	return (
		<div style={{display: 'grid', gap: 12}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 8}}>
				<button type="button" className="btn small" onClick={() => onDone()}>
					<Icon name="back" size={15} /> Containers
				</button>
				<b>New container</b>
			</div>
			{!picked ? (
				library.isLoading ? (
					<div className="skeleton" style={{height: 200, borderRadius: 16}} />
				) : library.isError ? (
					<p className="quiet">{(library.error as Error).message}</p>
				) : (
					(library.data ?? []).map((d) => (
						<Group key={d.os} title={d.name}>
							{d.releases.map((r) => (
								<Row key={r.alias} icon="category" color={look(d.os).bg.match(/#[0-9a-f]{6}/i)?.[0]} label={`${d.name} ${r.release}`} sub={r.alias} onClick={() => (haptic(6), setAlias(r.alias), setName(name || `${d.os === 'archlinux' ? 'arch' : d.os}-1`))} />
							))}
						</Group>
					))
				)
			) : (
				<div className="glass group" style={{padding: '12px 14px'}}>
					<Row icon="category" color={look(picked.distro.os).bg.match(/#[0-9a-f]{6}/i)?.[0]} label={`${picked.distro.name} ${picked.release}`} sub="Change" onClick={() => setAlias(null)} />
					<div className="field">
						<label htmlFor="ct-name">Name</label>
						<input id="ct-name" value={name} maxLength={63} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value.toLowerCase())} />
						{name && nameProblem && <span className="hint">{nameProblem}</span>}
					</div>
					<div className="field">
						<label htmlFor="ct-cpu">CPUs</label>
						<input id="ct-cpu" inputMode="numeric" value={cpus} onChange={(e) => setCpus(e.target.value.replace(/\D/g, ''))} />
					</div>
					<div className="field">
						<label htmlFor="ct-mem">Memory (MB)</label>
						<input id="ct-mem" inputMode="numeric" value={memory} onChange={(e) => setMemory(e.target.value.replace(/\D/g, ''))} />
					</div>
					<div className="field">
						<label htmlFor="ct-disk">Disk (GB)</label>
						<input id="ct-disk" inputMode="numeric" value={disk} onChange={(e) => setDisk(e.target.value.replace(/\D/g, ''))} />
					</div>
					<button type="button" className="btn block" style={{marginTop: 8}} disabled={!!nameProblem || action.isPending} onClick={create}>
						{action.isPending ? <span className="spinner" /> : <Icon name="plus" size={18} />} Create container
					</button>
				</div>
			)}
		</div>
	)
}

function ContainerDetail({c, onBack}: {c: Container; onBack: () => void}) {
	const action = useContainerAction()
	const confirm = useConfirm()
	const [term, setTerm] = useState(false)
	const [snap, setSnap] = useState('')
	const [port, setPort] = useState({host: '', inner: '', protocol: 'tcp' as 'tcp' | 'udp'})
	const pill = containerPill(c.status)
	const busy = action.isPending || pill.kind === 'busy'
	const run = (path: string, done?: string, extra: Record<string, unknown> = {}) => action.mutate({path, input: {name: c.name, ...extra}, done})

	if (term)
		return (
			<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
				<TerminalScreen container={{name: c.name}} onClose={() => setTerm(false)} />
			</Suspense>
		)

	const stop = () =>
		action.mutate(
			{path: 'containers.stop', input: {name: c.name}, done: `${c.name} is shut down`},
			{
				onError: async (e) => {
					if (!/STOP_TIMED_OUT/.test(e.message)) return
					if (await confirm({title: `Force stop ${c.name}?`, body: 'It didn’t shut down within a minute. Force stop turns it off straight away, like pulling the plug: unsaved work inside it is lost.', confirm: 'Force stop', danger: true, icon: 'alert'}))
						run('containers.forceStop', `${c.name} is off`)
				},
			},
		)

	return (
		<div style={{display: 'grid', gap: 12}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 10}}>
				<button type="button" className="btn small" onClick={onBack}>
					<Icon name="back" size={15} /> Containers
				</button>
			</div>
			<div style={{display: 'flex', alignItems: 'center', gap: 12}}>
				<span className="vm-os" style={{width: 52, height: 52, borderRadius: 16, background: look(c.os).bg, display: 'grid', placeItems: 'center'} as CSSProperties}>
					<Icon name="category" size={26} />
				</span>
				<div style={{display: 'grid', gap: 4}}>
					<b style={{fontSize: 18}}>{c.name}</b>
					<span style={{display: 'inline-flex', gap: 8, alignItems: 'center'}}>
						<StatusPill {...pill} />
						<span className="muted">{[c.os, c.release].filter(Boolean).join(' ')}</span>
					</span>
				</div>
			</div>
			{c.error && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{c.error}
				</div>
			)}
			<div className="actions mx-power">
				{c.status !== 'running' ? (
					<button className="action" disabled={busy || c.status === 'error'} onClick={() => run('containers.start', `${c.name} is starting`)}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={22} />}
						Start
					</button>
				) : (
					<button className="action" disabled={busy} onClick={() => setTerm(true)}>
						<Icon name="terminal" size={22} />
						Terminal
					</button>
				)}
				<button className="action" disabled={busy || c.status !== 'running'} onClick={() => run('containers.restart', `${c.name} is restarting`)}>
					<Icon name="restart" size={22} />
					Restart
				</button>
				<button className="action" disabled={busy || c.status !== 'running'} onClick={stop}>
					<Icon name="power" size={22} />
					Shut down
				</button>
				<button
					className="action"
					disabled={busy || c.status !== 'running'}
					onClick={async () => (await confirm({title: `Force stop ${c.name}?`, body: 'Turns it off straight away, like pulling the plug: unsaved work inside it is lost.', confirm: 'Force stop', danger: true, icon: 'alert'})) && run('containers.forceStop', `${c.name} is off`)}
				>
					<Icon name="stop" size={22} />
					Force stop
				</button>
			</div>

			<Group title="Details">
				<Row icon="cpu" label="CPUs" value={c.cpus ?? 'Any'} />
				<Row icon="memory" label="Memory" value={[c.memoryUsedGiB !== null ? `${c.memoryUsedGiB} GB used` : null, c.memory ? `of ${c.memory}` : null].filter(Boolean).join(' ') || '—'} />
				<Row icon="disk" label="Disk" value={c.disk ?? '—'} />
				<Row icon="network" label="Address" value={c.addresses.map((a) => a.address).join(', ') || (c.status === 'running' ? 'Waiting for an address…' : '—')} />
			</Group>

			<Group title="Open ports" footer="Opens a port on this server to your home network and passes it to the container. Only the ports listed here are reachable from outside the server.">
				{c.ports.map((p) => (
					<Row
						key={`${p.protocol}-${p.hostPort}`}
						icon="link"
						label={`${p.hostPort} → ${p.containerPort ?? '?'}`}
						sub={p.protocol.toUpperCase()}
						trailing={
							<button type="button" className="btn small" disabled={busy} aria-label={`Close port ${p.hostPort}`} onClick={() => run('containers.removePort', `Closed port ${p.hostPort}`, {protocol: p.protocol, hostPort: p.hostPort})}>
								<Icon name="trash" size={14} />
							</button>
						}
					/>
				))}
				<div style={{display: 'flex', gap: 8, padding: '10px 12px', alignItems: 'end', flexWrap: 'wrap'}}>
					<div className="field" style={{flex: '1 1 90px', margin: 0}}>
						<label htmlFor="ct-hp">Server port</label>
						<input id="ct-hp" inputMode="numeric" placeholder="8080" value={port.host} onChange={(e) => setPort({...port, host: e.target.value.replace(/\D/g, '')})} />
					</div>
					<div className="field" style={{flex: '1 1 90px', margin: 0}}>
						<label htmlFor="ct-cp">Container port</label>
						<input id="ct-cp" inputMode="numeric" placeholder="80" value={port.inner} onChange={(e) => setPort({...port, inner: e.target.value.replace(/\D/g, '')})} />
					</div>
					<button type="button" className="btn small" onClick={() => setPort({...port, protocol: port.protocol === 'tcp' ? 'udp' : 'tcp'})}>
						{port.protocol.toUpperCase()}
					</button>
					<button
						type="button"
						className="btn small"
						disabled={busy || !port.host || !port.inner}
						onClick={() => action.mutate({path: 'containers.addPort', input: {name: c.name, protocol: port.protocol, hostPort: Number(port.host), containerPort: Number(port.inner)}, done: `Port ${port.host} is open`}, {onSuccess: () => setPort({host: '', inner: '', protocol: port.protocol})})}
					>
						<Icon name="plus" size={14} /> Open
					</button>
				</div>
			</Group>

			<Group title="Snapshots">
				{c.snapshots.length === 0 && <p className="quiet" style={{padding: '4px 12px'}}>No snapshots yet.</p>}
				{c.snapshots.map((s) => (
					<Row
						key={s.name}
						icon="history"
						label={s.name}
						sub={s.createdAt ? new Date(s.createdAt).toLocaleString() : undefined}
						trailing={
							<span style={{display: 'inline-flex', gap: 6}}>
								<button
									type="button"
									className="btn small"
									disabled={busy}
									onClick={async () => (await confirm({title: `Go back to ${s.name}?`, body: `${c.name} returns to how it was when this snapshot was taken. Changes since then are lost.`, confirm: 'Restore', danger: true, icon: 'restart'})) && run('containers.restoreSnapshot', `${c.name} is back at ${s.name}`, {snapshot: s.name})}
								>
									Restore
								</button>
								<button type="button" className="btn small" disabled={busy} aria-label={`Delete snapshot ${s.name}`} onClick={async () => (await confirm({title: `Delete snapshot ${s.name}?`, body: 'This can’t be undone.', confirm: 'Delete', danger: true, icon: 'alert'})) && run('containers.deleteSnapshot', 'Snapshot deleted', {snapshot: s.name})}>
									<Icon name="trash" size={14} />
								</button>
							</span>
						}
					/>
				))}
				<div style={{display: 'flex', gap: 8, padding: '10px 12px', alignItems: 'end'}}>
					<div className="field" style={{flex: 1, margin: 0}}>
						<label htmlFor="ct-snap">New snapshot</label>
						<input id="ct-snap" placeholder="before-update" value={snap} onChange={(e) => setSnap(e.target.value.replace(/[^A-Za-z0-9._-]/g, ''))} />
					</div>
					<button type="button" className="btn small" disabled={busy || !snap} onClick={() => action.mutate({path: 'containers.snapshot', input: {name: c.name, snapshot: snap}, done: `Snapshot ${snap} taken`}, {onSuccess: () => setSnap('')})}>
						<Icon name="camera" size={14} /> Take
					</button>
				</div>
			</Group>

			<button
				className="btn danger block"
				disabled={action.isPending}
				onClick={async () => {
					if (!(await confirm({title: `Delete ${c.name}?`, body: `The container, its files and its snapshots are deleted. This can’t be undone.`, confirm: 'Delete container', danger: true, icon: 'alert'}))) return
					action.mutate({path: 'containers.delete', input: {name: c.name}, done: `${c.name} deleted`}, {onSuccess: onBack})
				}}
			>
				<Icon name="trash" size={18} /> Delete container
			</button>
		</div>
	)
}
