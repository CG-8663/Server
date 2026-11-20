// Settings › Move from Unraid: connect over SSH, choose what to bring over, watch it come across.
import {useEffect, useMemo, useState, type CSSProperties, type FormEvent} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query, type Listing} from './api'
import {Icon, type IconName} from './icons'
import {Group, Row, Switch, haptic, useConfirm, useToast} from './ui'
import {isKeyChangedError, itemStatusForView, jobSummary, type UnraidItem as Item, type UnraidJob as Job} from './unraidView'

type Share = {name: string; size: number | null; kind: 'share' | 'appdata' | 'system' | 'domains' | 'isos'}
type Container = {id: string; name: string; image: string; running: boolean; icon: string | null; web: {port: number} | null; copies: {from: string; to: string; file?: boolean}[]; shares: string[]; notes: string[]; problems: string[]; size: number; installed: boolean}
type Vm = {name: string; state: string; cores: number; memoryMb: number; firmware: string; disks: {file: string}[]; notes: string[]; problems: string[]; size: number}
type Scan = {shares: Share[]; containers: Container[]; vms: Vm[]; at: number}
type Status = {connected: {host: string; version: string; fingerprint: string | null} | null; scanned: boolean; job: Job | null}

const bytes = (n: number | null | undefined) => {
	if (n == null) return 'size unknown'
	if (n < 1024) return `${n} B`
	const u = ['KB', 'MB', 'GB', 'TB']
	let i = -1
	let v = n
	do {
		v /= 1024
		i++
	} while (v >= 1024 && i < u.length - 1)
	return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`
}
const SHARE_NOTE: Record<Share['kind'], string> = {
	share: '',
	appdata: 'Your containers’ files. They come over with each container you choose.',
	system: 'Unraid’s own Docker and VM files. Not needed here.',
	domains: 'VM disks. They come over with each VM you choose.',
	isos: 'Installer images for VMs.',
}

function Field({id, label, hint, ...input}: {id: string; label: string; hint?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<div className="field">
			<label htmlFor={id}>{label}</label>
			<input id={id} {...input} />
			{hint && <span className="hint">{hint}</span>}
		</div>
	)
}

function Check({on}: {on: boolean}) {
	return <Icon name={on ? 'checked' : 'unchecked'} size={20} />
}

export function UnraidPage({onBack}: {onBack: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const status = useQuery({queryKey: ['unraid.status'], queryFn: () => query<Status>('unraid.status'), retry: false, refetchInterval: (q) => (q.state.data?.job && !q.state.data.job.endedAt ? 1500 : false)})
	const [scan, setScan] = useState<Scan | null>(null)
	const [scanning, setScanning] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// A finished move stays on show until you choose Done (or look again).
	const [dismissed, setDismissed] = useState<string | null>(() => sessionStorage.getItem('omarchy-server:unraid-dismissed'))
	const s = status.data
	const refresh = () => qc.invalidateQueries({queryKey: ['unraid.status']})

	const look = async () => {
		setScanning(true)
		setError(null)
		try {
			setScan(await mutate<Scan>('unraid.scan'))
			if (s?.job) dismiss(s.job.id)
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setScanning(false)
		}
	}
	const running = !!s?.job && !s.job.endedAt
	const showJob = s?.job && (running || s.job.id !== dismissed)
	function dismiss(id: string) {
		sessionStorage.setItem('omarchy-server:unraid-dismissed', id)
		setDismissed(id)
	}
	const disconnect = async () => {
		await mutate('unraid.disconnect').catch(() => {})
		setScan(null)
		refresh()
	}

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Move from Unraid
				</h1>
			</div>
			{status.isLoading && (
				<div className="glass group">
					<div className="row static">
						<span className="spinner" />
					</div>
				</div>
			)}
			{showJob ? (
				<JobView
					job={s!.job!}
					connected={!!s?.connected}
					onCancel={async () => {
						const ok = await confirm({title: 'Stop the move?', body: 'What’s being copied right now finishes; the rest is skipped. You can start again later, and copies pick up where they left off.', confirm: 'Stop', danger: true, icon: 'stop'})
						if (ok) await mutate('unraid.cancel').then(refresh)
					}}
					onAgain={look}
					onDone={() => (dismiss(s!.job!.id), disconnect())}
				/>
			) : !s?.connected ? (
				<ConnectCard onConnected={() => (refresh(), look())} />
			) : scanning || !scan ? (
				<div className="glass card bk-status">
					<div className="bk-status-line">
						{scanning ? <span className="spinner" /> : <Icon name="server" size={18} />}
						<b>{scanning ? `Looking at ${s.connected.host}…` : `Connected to ${s.connected.host}`}</b>
					</div>
					<p className="muted bk-next">{scanning ? 'Measuring shares and containers. Big shares take a minute or two.' : `Unraid ${s.connected.version}`}</p>
					{error && <p className="bk-err">{error}</p>}
					{!scanning && (
						<button className="btn primary" onClick={look}>
							Look again
						</button>
					)}
				</div>
			) : (
				<Choose
					scan={scan}
					host={s.connected.host}
					fingerprint={s.connected.fingerprint}
					version={s.connected.version}
					onStart={async (input) => {
						try {
							await mutate('unraid.start', input)
							toast('Moving from Unraid')
							refresh()
						} catch (e) {
							toast((e as Error).message, true)
						}
					}}
					onDisconnect={disconnect}
				/>
			)}
		</div>
	)
}

function ConnectCard({onConnected}: {onConnected: () => void}) {
	const toast = useToast()
	const [host, setHost] = useState('tower.local')
	const [password, setPassword] = useState('')
	const [busy, setBusy] = useState(false)
	const [forgetting, setForgetting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const go = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			await mutate('unraid.connect', {host, password})
			setPassword('')
			onConnected()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	const forget = async () => {
		setForgetting(true)
		try {
			await mutate('unraid.forgetHost', {host})
			setError(null)
			toast('Forgot this server’s key. Connect again.')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setForgetting(false)
		}
	}
	return (
		<>
			<div className="glass empty bk-hero">
				<span className="big">
					<Icon name="move" size={30} />
				</span>
				<b>Bring your Unraid server over</b>
				<p className="muted" style={{margin: 0, fontSize: 14.5, lineHeight: 1.45}}>
					Your shares and files, your Docker containers (as apps, with their settings and data) and your VMs. Unraid keeps running and isn’t changed: you choose what comes over, and you can switch it off once you’re happy.
				</p>
			</div>
			<form onSubmit={go} style={{marginTop: 14}}>
				<Field id="ur-host" label="Unraid server" hint="Its name or address, as you’d type it to open Unraid’s page." value={host} onChange={(e) => setHost(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
				<Field id="ur-pass" label="Root password" type="password" hint="The one you sign in to Unraid with. It’s used only for this move and never saved. SSH must be on in Unraid (Settings › Management Access)." value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
				{error && (
					<div className="error">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				{isKeyChangedError(error) && (
					<button type="button" className="btn block" disabled={busy || forgetting || !host} onClick={forget} style={{marginBottom: 8}}>
						{forgetting && <span className="spinner" />}
						Forget this server’s key
					</button>
				)}
				<button className="btn block primary" disabled={busy || forgetting || !host || !password} style={{marginTop: 6}}>
					{busy && <span className="spinner" />}
					Connect
				</button>
			</form>
		</>
	)
}

function Choose({scan, host, fingerprint, version, onStart, onDisconnect}: {scan: Scan; host: string; fingerprint: string | null; version: string; onStart: (input: Record<string, unknown>) => Promise<void>; onDisconnect: () => void}) {
	const [shares, setShares] = useState<Set<string>>(() => new Set(scan.shares.filter((x) => x.kind === 'share').map((x) => x.name)))
	const [containers, setContainers] = useState<Set<string>>(() => new Set(scan.containers.filter((c) => !c.installed && !c.problems.length).map((c) => c.id)))
	const [vms, setVms] = useState<Set<string>>(() => new Set(scan.vms.filter((v) => v.state === 'shut off' && !v.problems.length).map((v) => v.name)))
	const [shareOnNetwork, setShareOnNetwork] = useState(true)
	const [pauseContainers, setPauseContainers] = useState(true)
	const [destination, setDestination] = useState('/Home/Unraid')
	const [open, setOpen] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const pools = useQuery({queryKey: ['files.list', '/Home/Pools'], queryFn: () => query<Listing>('files.list', {path: '/Home/Pools'}), retry: false, staleTime: 60_000})
	const places = ['/Home/Unraid', ...(pools.data?.files ?? []).filter((f) => f.type === 'directory').map((f) => `${f.path}/Unraid`)]
	const flip = (set: Set<string>, put: (s: Set<string>) => void, key: string) => {
		haptic(5)
		const n = new Set(set)
		if (n.has(key)) n.delete(key)
		else n.add(key)
		put(n)
	}
	const total = useMemo(
		() =>
			scan.shares.filter((x) => shares.has(x.name)).reduce((t, x) => t + (x.size ?? 0), 0) +
			scan.containers.filter((c) => containers.has(c.id)).reduce((t, c) => t + c.size, 0) +
			scan.vms.filter((v) => vms.has(v.name)).reduce((t, v) => t + v.size, 0),
		[scan, shares, containers, vms],
	)
	const count = shares.size + containers.size + vms.size
	return (
		<>
			<div className="glass card bk-status">
				<div className="bk-status-line">
					<span className="bk-dot" style={{'--c': 'var(--green)'} as CSSProperties}>
						<Icon name="check" size={16} />
					</span>
					<b>
						{host} · Unraid {version}
					</b>
				</div>
				{fingerprint && <p className="muted bk-next" style={{fontSize: 12.5, wordBreak: 'break-all'}}>Its key: {fingerprint}. If you want to be sure it’s your server, it matches the one Unraid shows in a terminal with: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</p>}
			</div>

			<Group title="Shares" footer="Each share is copied into a folder here and shared on your network again, with the same name.">
				{scan.shares.map((x) => {
					const choosable = x.kind === 'share' || x.kind === 'isos'
					return (
						<button key={x.name} type="button" className="row" style={{minHeight: 56}} disabled={!choosable} onClick={() => choosable && flip(shares, setShares, x.name)}>
							<span className="row-ico" style={{'--c': shares.has(x.name) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
								{choosable ? <Check on={shares.has(x.name)} /> : <Icon name="folder" size={18} />}
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>{x.name}</b>
								<span>{[bytes(x.size), SHARE_NOTE[x.kind]].filter(Boolean).join(' · ')}</span>
							</span>
						</button>
					)
				})}
			</Group>

			{scan.containers.length > 0 && (
				<Group title="Docker containers" footer="Each one becomes an app here: the same image, settings and ports, with its files from appdata. Folders it uses from your shares point at where those shares are copied.">
					{scan.containers.map((c) => (
						<div key={c.id}>
							<button type="button" className="row" style={{minHeight: 60}} disabled={c.installed} onClick={() => flip(containers, setContainers, c.id)}>
								<span className="row-ico" style={{'--c': containers.has(c.id) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
									<Check on={containers.has(c.id)} />
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>{c.name}</b>
									<span>{c.installed ? 'Already here' : [c.image, bytes(c.size), c.notes.length ? `${c.notes.length} note${c.notes.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</span>
								</span>
							</button>
							{c.notes.length > 0 && (
								<button type="button" className="row bk-item" onClick={() => setOpen(open === c.id ? null : c.id)}>
									<Icon name="info" size={15} />
									<span className="main">
										<span>{open === c.id ? c.notes.join(' ') : 'What’s different here'}</span>
									</span>
								</button>
							)}
						</div>
					))}
				</Group>
			)}

			{scan.vms.length > 0 && (
				<Group title="VMs" footer="Shut a VM down on Unraid before it comes over: its disks are copied as they are.">
					{scan.vms.map((v) => {
						const off = v.state === 'shut off'
						return (
							<div key={v.name}>
								<button type="button" className="row" style={{minHeight: 60}} disabled={!!v.problems.length} onClick={() => flip(vms, setVms, v.name)}>
									<span className="row-ico" style={{'--c': vms.has(v.name) ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
										<Check on={vms.has(v.name)} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>{v.name}</b>
										<span>{v.problems[0] ?? [`${v.cores} cores`, `${Math.round(v.memoryMb / 1024)} GB`, bytes(v.size), off ? '' : `${v.state} on Unraid: shut it down first`].filter(Boolean).join(' · ')}</span>
									</span>
								</button>
								{v.notes.length > 0 && (
									<div className="row static bk-item">
										<Icon name="info" size={15} />
										<span className="main">
											<span>{v.notes.join(' ')}</span>
										</span>
									</div>
								)}
							</div>
						)
					})}
				</Group>
			)}

			<Group title="Where and how">
				<div className="row static bk-pick">
					<label>
						<span>Copy shares to</span>
						<select className="field" value={destination} onChange={(e) => setDestination(e.target.value)}>
							{places.map((p) => (
								<option key={p} value={p}>
									{p.replace(/^\/Home/, 'Home').replace(/\//g, ' › ')}
								</option>
							))}
						</select>
					</label>
				</div>
				<Row icon="folder-share" color="var(--teal)" label="Share on the network" sub="With the same names as on Unraid" trailing={<Switch label="Share on the network" on={shareOnNetwork} onChange={setShareOnNetwork} />} />
				<Row icon="stop" color="#8e8e93" label="Pause for the last copy" sub="Each container pauses on Unraid for a moment, so its databases come over whole, then starts again." trailing={<Switch label="Pause each container on Unraid for its last copy" on={pauseContainers} onChange={setPauseContainers} />} />
			</Group>

			<button
				className="btn block primary"
				style={{marginTop: 16}}
				disabled={busy || !count}
				onClick={async () => {
					setBusy(true)
					await onStart({shares: [...shares], containers: [...containers], vms: [...vms], destination, shareOnNetwork, pauseContainers})
					setBusy(false)
				}}
			>
				{busy && <span className="spinner" />}
				Bring {count} thing{count === 1 ? '' : 's'} over · {bytes(total)}
			</button>
			<button className="btn block ghost" style={{marginTop: 8}} onClick={onDisconnect}>
				Disconnect
			</button>
		</>
	)
}

const STATUS_ICON: Record<Item['status'], IconName> = {waiting: 'clock', running: 'clock', done: 'check', failed: 'alert', skipped: 'stop'}
const KIND_LABEL: Record<Item['kind'], string> = {share: 'Share', container: 'App', vm: 'VM'}

function JobView({job, connected, onCancel, onAgain, onDone}: {job: Job; connected: boolean; onCancel: () => void; onAgain: () => void; onDone: () => void}) {
	const summary = jobSummary(job, connected)
	useEffect(() => {
		if (!summary.running) haptic(summary.incomplete ? [20, 40, 20] : 12)
	}, [summary.running, summary.incomplete])
	return (
		<>
			<div className="glass card bk-status">
				<div className="bk-status-line">
					{summary.running ? (
						<span className="spinner" />
					) : (
						<span className="bk-dot" style={{'--c': summary.incomplete ? 'var(--orange, #f59e0b)' : 'var(--green)'} as CSSProperties}>
							<Icon name={summary.incomplete ? 'alert' : 'check'} size={16} />
						</span>
					)}
					<b>{summary.heading}</b>
				</div>
				{job.stopped && <p className="bk-err">{job.stopped}</p>}
				{summary.running ? (
					<button className="btn" onClick={onCancel} disabled={job.cancelled}>
						{job.cancelled ? 'Stopping…' : 'Stop'}
					</button>
				) : (
					<div style={{display: 'flex', gap: 8}}>
						{summary.canRetry && (
							<button className="btn primary" style={{flex: 1}} onClick={onAgain}>
								Try the rest again
							</button>
						)}
						<button className={`btn ${summary.canRetry ? '' : 'primary'}`} style={{flex: 1}} onClick={onDone}>
							Done
						</button>
					</div>
				)}
			</div>
			<Group title="Progress" footer={summary.running ? 'You can leave this page: the move carries on, and copies pick up where they left off if anything stops them.' : undefined}>
				{job.items.map((i) => {
					const st = itemStatusForView(i, summary.running)
					return (
						<div key={`${i.kind}-${i.key}`}>
							<div className="row static" style={{minHeight: 60}}>
								<span className="row-ico" style={{'--c': st === 'done' ? 'var(--green)' : st === 'failed' ? 'var(--red)' : st === 'running' ? 'var(--accent)' : '#8e8e93'} as CSSProperties}>
									{st === 'running' ? <span className="spinner" /> : <Icon name={STATUS_ICON[st]} size={18} />}
								</span>
								<span className="main">
									<b style={{fontWeight: 550}}>
										{KIND_LABEL[i.kind]} · {i.name}
									</b>
									<span>
										{st === 'running'
											? `${i.step ?? 'Starting'}${i.progress ? ` · ${Math.round(i.progress * 100)}%` : ''}`
											: st === 'failed'
												? i.error || 'Stopped'
												: st === 'done'
													? i.path
														? i.path.replace(/^\/Home/, 'Home').replace(/\//g, ' › ')
														: 'Here now'
													: st === 'skipped'
														? 'Skipped'
														: bytes(i.size)}
									</span>
								</span>
							</div>
							{summary.running && st === 'running' && (
								<div className="row static" style={{minHeight: 0, paddingTop: 0}}>
									<div className="bk-bar" style={{flex: 1}}>
										<span style={{width: `${Math.max(3, Math.round((i.progress ?? 0) * 100))}%`}} />
									</div>
								</div>
							)}
							{i.note && (
								<div className="row static bk-item">
									<Icon name="info" size={15} />
									<span className="main">
										<span>{i.note}</span>
									</span>
								</div>
							)}
						</div>
					)
				})}
			</Group>
		</>
	)
}
