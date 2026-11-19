// Settings → Backups: this server's apps and settings, encrypted, copied to a NAS on a schedule.
import {useEffect, useMemo, useState, type CSSProperties, type FormEvent} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from './api'
import {Icon} from './icons'
import {Group, Row, Segmented, Sheet, SheetHeader, Switch, haptic, useConfirm, useToast} from './ui'

type Nas = {host: string; port?: number; share: string; folder: string; username: string; domain?: string; hasPassword?: boolean}
type Schedule = {frequency: 'off' | 'daily' | 'weekly'; hour: number; weekday: number}
type Keep = {daily: number; weekly: number; monthly: number}
type Include = {apps: boolean; settings: boolean; machineBackups: boolean}
type RunItem = {kind: string; id?: string; name: string; ok: boolean; error?: string; added?: number}
type Run = {id: string; reason: string; startedAt: number; endedAt: number | null; ok: boolean; error: string | null; items: RunItem[]; added: number; nas: {ok: boolean; error?: string; uploaded?: number; uploadedBytes?: number} | null}
export type BackupStatus = {
	configured: boolean
	nas: Nas | null
	repo: string
	include: Include
	pauseApps: boolean
	schedule: Schedule
	keep: Keep
	keySaved: boolean
	running: {step: string; progress: number; startedAt: number} | null
	nextRunAt: number | null
	history: Run[]
}
type Snapshot = {id: string; shortId: string; time: number; tags: string[]; paths: string[]; size: number | null}
type Found = {host: string; name: string; address?: string}
type Share = {name: string; comment: string}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})
const bytes = (n: number) => {
	if (n < 1024) return `${n} B`
	const u = ['KB', 'MB', 'GB', 'TB']
	let i = -1
	do {
		n /= 1024
		i++
	} while (n >= 1024 && i < u.length - 1)
	return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`
}
const ago = (t: number) => {
	const s = Math.max(0, (Date.now() - t) / 1000)
	if (s < 90) return 'just now'
	if (s < 3600) return `${Math.round(s / 60)} min ago`
	if (s < 86400) return `${Math.round(s / 3600)} h ago`
	return `${Math.round(s / 86400)} days ago`
}
const when = (t: number) => {
	const d = new Date(t)
	const today = new Date()
	const tomorrow = new Date(Date.now() + 86400_000)
	const time = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})
	if (d.toDateString() === today.toDateString()) return `today at ${time}`
	if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
	return `${d.toLocaleDateString([], {weekday: 'long'})} at ${time}`
}
const stamp = (t: number) => new Date(t).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})

function useStatus() {
	const q = useQuery({queryKey: ['backups.status'], queryFn: () => query<BackupStatus>('backups.status'), retry: false, refetchInterval: (s) => (s.state.data?.running ? 1500 : 20_000)})
	return q
}

function useSave() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: (a: {path: string; input?: unknown; done?: string}) => mutate(a.path, a.input),
		onSuccess: (_, a) => a.done && toast(a.done),
		onError: (e: Error) => toast(e.message, true),
		onSettled: () => {
			qc.invalidateQueries({queryKey: ['backups.status']})
			qc.invalidateQueries({queryKey: ['backups.snapshots']})
		},
	})
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

export function BackupsPage({onBack}: {onBack: () => void}) {
	const status = useStatus()
	const save = useSave()
	const confirm = useConfirm()
	const toast = useToast()
	const [setup, setSetup] = useState<'new' | 'nas' | null>(null)
	const [connect, setConnect] = useState(false)
	const [key, setKey] = useState<string | null>(null)
	const [restore, setRestore] = useState<string | null>(null)
	const s = status.data
	const snaps = useQuery({queryKey: ['backups.snapshots'], queryFn: () => query<Snapshot[]>('backups.snapshots'), enabled: !!s?.configured, retry: false, staleTime: 30_000})
	// Refresh the list of backups when a run finishes.
	const running = !!s?.running
	const qc = useQueryClient()
	useEffect(() => {
		if (!running) qc.invalidateQueries({queryKey: ['backups.snapshots']})
	}, [running, qc])

	const showKey = async () => {
		try {
			const r = await mutate<{recoveryKey: string}>('backups.recoveryKey')
			setKey(r.recoveryKey)
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const set = (input: Record<string, unknown>, done?: string) => save.mutate({path: 'backups.configure', input, done})

	const appsBacked = useMemo(() => {
		const byApp = new Map<string, Snapshot[]>()
		for (const sn of snaps.data ?? []) for (const t of sn.tags) if (t.startsWith('app:')) byApp.set(t.slice(4), [...(byApp.get(t.slice(4)) ?? []), sn])
		return byApp
	}, [snaps.data])
	const names = useMemo(() => {
		const m = new Map<string, string>()
		for (const r of s?.history ?? []) for (const i of r.items) if (i.kind === 'app' && i.id) m.set(i.id, i.name)
		return m
	}, [s?.history])

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title" style={{flex: 1}}>
					Backups
				</h1>
			</div>

			{status.isLoading && (
				<div className="glass group">
					<div className="row static">
						<span className="spinner" />
					</div>
				</div>
			)}
			{status.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(status.error as Error).message}
				</div>
			)}

			{s && !s.configured && (
				<div className="glass empty bk-hero">
					<span className="big">
						<Icon name="history" size={30} />
					</span>
					<b>Back up this server to your NAS</b>
					<p className="muted" style={{margin: '0 0 6px', fontSize: 14.5, lineHeight: 1.45}}>
						Your apps and settings, saved every night and copied to a shared folder on your NAS. Only what changed is sent, every backup is encrypted, and you can go back to any of them.
					</p>
					<button className="btn primary" onClick={() => (haptic(6), setSetup('new'))}>
						Set up backups
					</button>
					<button className="btn ghost small" onClick={() => setConnect(true)}>
						Restore from an existing backup
					</button>
				</div>
			)}

			{s?.configured && (
				<>
					<StatusCard s={s} busy={save.isPending} onRun={() => save.mutate({path: 'backups.runNow', done: 'Backup started'})} />

					{!s.keySaved && (
						<button className="glass bk-key-warn" onClick={showKey}>
							<Icon name="key" size={20} />
							<span>
								<b>Save your recovery key</b>
								<span>Without it, the backups on your NAS can’t be opened if this server is lost.</span>
							</span>
							<Icon name="chevron" size={18} className="chev" />
						</button>
					)}

					<Group title="NAS">
						<Row icon="server" color="var(--teal)" label={s.nas?.host ?? ''} sub={`${s.nas?.share} › ${s.nas?.folder}`} onClick={() => setSetup('nas')} />
					</Group>

					<Group title="What’s backed up" footer={s.include.apps && s.pauseApps ? 'Each app pauses for a moment while its files are saved, so databases are saved in a consistent state.' : undefined}>
						<Row icon="apps" color="var(--accent)" label="Apps" sub="Every installed app’s data" trailing={<Switch label="Apps" on={s.include.apps} onChange={(v) => set({include: {...s.include, apps: v}})} />} />
						{s.include.apps && <Row icon="stop" color="#8e8e93" label="Pause apps while saving" trailing={<Switch label="Pause apps while saving" on={s.pauseApps} onChange={(v) => set({pauseApps: v})} />} />}
						<Row icon="settings" color="#8e8e93" label="Server settings" sub="Accounts, settings, certificates, VM settings" trailing={<Switch label="Server settings" on={s.include.settings} onChange={(v) => set({include: {...s.include, settings: v}})} />} />
						<Row icon="machine" color="var(--orange, #f59e0b)" label="VM backups" sub="Home › Backups › Machines" trailing={<Switch label="VM backups" on={s.include.machineBackups} onChange={(v) => set({include: {...s.include, machineBackups: v}})} />} />
					</Group>

					<ScheduleGroup s={s} onChange={set} />

					<Group title="Restore" footer="Restoring puts an app back the way it was in that backup. Its current data is replaced.">
						{snaps.isLoading && (
							<div className="row static">
								<span className="spinner" />
							</div>
						)}
						{snaps.isSuccess && appsBacked.size === 0 && (
							<div className="row static">
								<span className="main">
									<span>No app backups yet.</span>
								</span>
							</div>
						)}
						{[...appsBacked].map(([id, list]) => (
							<Row key={id} icon="restore" color="var(--accent)" label={names.get(id) ?? id} sub={`${list.length} backup${list.length === 1 ? '' : 's'} · latest ${ago(list[0].time)}`} onClick={() => setRestore(id)} />
						))}
					</Group>

					{s.history.length > 0 && (
						<Group title="History">
							{s.history.slice(0, 8).map((r) => (
								<HistoryRow key={r.id} r={r} />
							))}
						</Group>
					)}

					<Group title="Recovery">
						<Row icon="key" color="var(--yellow, #eab308)" label="Recovery key" sub="Opens these backups on a new server" onClick={showKey} />
					</Group>
				</>
			)}

			{setup && s && (
				<SetupSheet
					mode={setup}
					current={s}
					onClose={() => setSetup(null)}
					onDone={(k) => {
						setSetup(null)
						if (k) setKey(k)
					}}
				/>
			)}
			{connect && <ConnectSheet onClose={() => setConnect(false)} />}
			{key && <KeySheet recoveryKey={key} saved={!!s?.keySaved} onClose={() => setKey(null)} />}
			{restore && (
				<RestoreSheet
					appId={restore}
					name={names.get(restore) ?? restore}
					list={appsBacked.get(restore) ?? []}
					onClose={() => setRestore(null)}
					onRestore={async (sn) => {
						const ok = await confirm({
							title: `Restore ${names.get(restore) ?? restore}?`,
							body: `It goes back to how it was on ${stamp(sn.time)}. Anything it saved since then is replaced. It stops while this happens.`,
							confirm: 'Restore',
							danger: true,
							icon: 'restore',
						})
						if (!ok) return
						setRestore(null)
						save.mutate({path: 'backups.restoreApp', input: {snapshotId: sn.id, appId: restore}, done: `${names.get(restore) ?? restore} restored`})
					}}
				/>
			)}
		</div>
	)
}

function StatusCard({s, busy, onRun}: {s: BackupStatus; busy: boolean; onRun: () => void}) {
	const last = s.history.find((r) => r.endedAt)
	return (
		<div className="glass card bk-status">
			{s.running ? (
				<>
					<div className="bk-status-line">
						<span className="spinner" />
						<b>{s.running.step}…</b>
					</div>
					<div className="bk-bar" role="progressbar" aria-valuenow={Math.round(s.running.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
						<span style={{width: `${Math.max(3, Math.round(s.running.progress * 100))}%`}} />
					</div>
				</>
			) : (
				<>
					<div className="bk-status-line">
						<span className="bk-dot" style={{'--c': !last ? '#8e8e93' : last.ok ? 'var(--green)' : 'var(--red)'} as CSSProperties}>
							<Icon name={!last ? 'clock' : last.ok ? 'check' : 'alert'} size={16} />
						</span>
						<b>{!last ? 'No backups yet' : last.ok ? `Backed up ${ago(last.endedAt!)}` : `Last backup ${ago(last.endedAt!)} had a problem`}</b>
					</div>
					{last && !last.ok && last.error && <p className="bk-err">{last.error}</p>}
					<p className="muted bk-next">{s.nextRunAt ? `Next backup ${when(s.nextRunAt)}` : 'Scheduled backups are off'}</p>
				</>
			)}
			<button className="btn primary" disabled={!!s.running || busy} onClick={() => (haptic(8), onRun())}>
				<Icon name="history" size={17} /> Back up now
			</button>
		</div>
	)
}

function ScheduleGroup({s, onChange}: {s: BackupStatus; onChange: (input: Record<string, unknown>) => void}) {
	const sc = s.schedule
	const put = (patch: Partial<Schedule>) => onChange({schedule: {...sc, ...patch}})
	const keep = (patch: Partial<Keep>) => onChange({keep: {...s.keep, ...patch}})
	return (
		<Group title="Schedule" footer={`Keeps the last ${s.keep.daily} days, ${s.keep.weekly} weeks and ${s.keep.monthly} months of backups. Older ones are removed from the server and the NAS.`}>
			<div className="row static bk-sched">
				<Segmented
					label="How often"
					value={sc.frequency}
					options={[
						{id: 'off', label: 'Off'},
						{id: 'daily', label: 'Daily'},
						{id: 'weekly', label: 'Weekly'},
					]}
					onChange={(v) => put({frequency: v})}
				/>
			</div>
			{sc.frequency !== 'off' && (
				<div className="row static bk-pick">
					{sc.frequency === 'weekly' && (
						<label>
							<span>Day</span>
							<select className="field" value={sc.weekday} onChange={(e) => put({weekday: Number(e.target.value)})}>
								{DAYS.map((d, i) => (
									<option key={d} value={i}>
										{d}
									</option>
								))}
							</select>
						</label>
					)}
					<label>
						<span>Time</span>
						<select className="field" value={sc.hour} onChange={(e) => put({hour: Number(e.target.value)})}>
							{Array.from({length: 24}, (_, h) => (
								<option key={h} value={h}>
									{hourLabel(h)}
								</option>
							))}
						</select>
					</label>
				</div>
			)}
			<div className="row static bk-pick">
				{(
					[
						['daily', 'Days', [3, 7, 14, 30]],
						['weekly', 'Weeks', [0, 4, 8, 12]],
						['monthly', 'Months', [0, 3, 6, 12, 24]],
					] as const
				).map(([k, label, opts]) => (
					<label key={k}>
						<span>{label}</span>
						<select className="field" value={s.keep[k]} onChange={(e) => keep({[k]: Number(e.target.value)})}>
							{[...new Set([...opts, s.keep[k]])]
								.sort((a, b) => a - b)
								.map((n) => (
									<option key={n} value={n}>
										{n}
									</option>
								))}
						</select>
					</label>
				))}
			</div>
		</Group>
	)
}

function HistoryRow({r}: {r: Run}) {
	const [open, setOpen] = useState(false)
	const running = !r.endedAt
	const sub = running
		? 'Running'
		: r.ok
			? `${bytes(r.added)} new${r.nas?.uploaded ? ` · ${r.nas.uploaded} file${r.nas.uploaded === 1 ? '' : 's'} to the NAS` : ''}`
			: (r.error ?? 'Failed')
	return (
		<>
			<Row
				icon={running ? 'clock' : r.ok ? 'check' : 'alert'}
				color={running ? '#8e8e93' : r.ok ? 'var(--green)' : 'var(--red)'}
				label={`${stamp(r.startedAt)}${r.reason === 'scheduled' ? '' : ' · by hand'}`}
				sub={sub}
				onClick={r.items.length ? () => setOpen(!open) : undefined}
			/>
			{open &&
				r.items.map((i, n) => (
					<div className="row static bk-item" key={n}>
						<Icon name={i.ok ? 'check' : 'alert'} size={15} />
						<span className="main">
							<span>
								{i.name}
								{i.ok ? ` · ${bytes(i.added ?? 0)} new` : ` · ${i.error}`}
							</span>
						</span>
					</div>
				))}
		</>
	)
}

// Connect (or change) the NAS. A new setup ends by showing the recovery key.
function SetupSheet({mode, current, onClose, onDone}: {mode: 'new' | 'nas'; current: BackupStatus; onClose: () => void; onDone: (key?: string) => void}) {
	const toast = useToast()
	const qc = useQueryClient()
	const found = useQuery({queryKey: ['backups.discover'], queryFn: () => query<Found[]>('backups.discover'), retry: false, staleTime: 60_000})
	const [host, setHost] = useState(current.nas ? `${current.nas.host}${current.nas.port ? `:${current.nas.port}` : ''}` : '')
	const [username, setUsername] = useState(current.nas?.username ?? '')
	const [password, setPassword] = useState('')
	const [shares, setShares] = useState<Share[] | null>(null)
	const [share, setShare] = useState(current.nas?.share ?? '')
	const [folder, setFolder] = useState(current.nas?.folder ?? 'Omarchy Server')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const reuse = !!current.nas?.hasPassword && current.nas.host === host.split(':')[0] && current.nas.username === username

	const findShares = async (e?: FormEvent) => {
		e?.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const list = await mutate<Share[]>('backups.shares', {host, username, ...(password ? {password} : {})})
			setShares(list)
			if (!list.some((x) => x.name === share)) setShare(list[0]?.name ?? '')
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	const finish = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const r = await mutate<BackupStatus & {recoveryKey?: string}>('backups.configure', {nas: {host, username, share, folder, ...(password ? {password} : {})}})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast(mode === 'new' ? 'Backups are on' : 'NAS updated')
			onDone(r.recoveryKey)
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Connect your NAS" tall>
			<SheetHeader title={mode === 'new' ? 'Connect your NAS' : 'NAS'} subtitle="Any NAS or computer that shares folders over SMB (Windows file sharing): Synology, QNAP, TrueNAS, Unraid, a Windows PC." onClose={onClose} />
			{!shares ? (
				<form onSubmit={findShares}>
					{(found.data?.length ?? 0) > 0 && (
						<div className="bk-found">
							<span className="muted">Found on your network</span>
							<div>
								{found.data!.map((f) => (
									<button type="button" key={f.host} className={`chip${host === f.host ? ' on' : ''}`} onClick={() => (haptic(5), setHost(f.host))}>
										<Icon name="server" size={14} /> {f.name}
									</button>
								))}
							</div>
						</div>
					)}
					<Field id="bk-host" label="NAS name or address" placeholder="nas.local or 192.168.1.20" value={host} onChange={(e) => setHost(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
					<Field id="bk-user" label="Username" hint="An account on the NAS that can write to the share. A separate account just for backups is safest." value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" autoComplete="off" required />
					<Field id="bk-pass" label="Password" type="password" placeholder={reuse ? 'Saved (leave empty to keep it)' : ''} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required={!reuse} />
					{error && (
						<div className="error">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy || !host || !username || (!password && !reuse)} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						Connect
					</button>
				</form>
			) : (
				<form onSubmit={finish}>
					<div className="section-head">
						<h2>Share</h2>
					</div>
					{shares.length === 0 ? (
						<p className="muted">This account can’t see any shared folders on {host}. Create one on the NAS, then try again.</p>
					) : (
						<div className="glass group" style={{marginBottom: 14}}>
							{shares.map((x) => (
								<button type="button" key={x.name} className="row" onClick={() => (haptic(5), setShare(x.name))} style={{minHeight: 52}}>
									<span className="row-ico" style={{'--c': 'var(--teal)'} as CSSProperties}>
										<Icon name="folder" size={18} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>{x.name}</b>
										{x.comment && <span>{x.comment}</span>}
									</span>
									{share === x.name && <Icon name="check" size={18} />}
								</button>
							))}
						</div>
					)}
					<Field id="bk-folder" label="Folder on the share" hint="Created if it isn’t there. Use a folder only these backups go in." value={folder} onChange={(e) => setFolder(e.target.value)} required />
					{error && (
						<div className="error">
							<Icon name="alert" size={18} />
							{error}
						</div>
					)}
					<button className="btn block primary" disabled={busy || !share || !folder.trim()} style={{marginTop: 6}}>
						{busy && <span className="spinner" />}
						{mode === 'new' ? 'Turn on backups' : 'Save'}
					</button>
					<button type="button" className="btn block ghost" onClick={() => setShares(null)} style={{marginTop: 8}}>
						Back
					</button>
					{mode === 'new' && <p className="muted" style={{fontSize: 13, marginTop: 10}}>Backs up apps and server settings every night at {hourLabel(current.schedule.hour)}. You can change this next.</p>}
				</form>
			)}
		</Sheet>
	)
}

function KeySheet({recoveryKey, saved, onClose}: {recoveryKey: string; saved: boolean; onClose: () => void}) {
	const toast = useToast()
	const qc = useQueryClient()
	const [ok, setOk] = useState(saved)
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(recoveryKey)
			toast('Recovery key copied')
		} catch {
			toast('Couldn’t copy. Select the key and copy it.', true)
		}
	}
	const download = () => {
		const text = `Omarchy Server backup recovery key\n\n${recoveryKey}\n\nYou need this key to open your backups on a new server (Settings › Backups › Restore from an existing backup).\nKeep it somewhere safe, away from the server: a password manager, or printed.\n`
		const url = URL.createObjectURL(new Blob([text], {type: 'text/plain'}))
		const a = Object.assign(document.createElement('a'), {href: url, download: 'omarchy-server-recovery-key.txt'})
		a.click()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
	}
	const done = async () => {
		if (ok && !saved) {
			await mutate('backups.keySaved').catch(() => {})
			qc.invalidateQueries({queryKey: ['backups.status']})
		}
		onClose()
	}
	return (
		<Sheet open onClose={done} label="Recovery key">
			<SheetHeader title="Your recovery key" subtitle="Your backups are encrypted with this key. If this server is ever lost, you need it to get them back. Nobody else has a copy." onClose={done} />
			<div className="glass bk-keybox" aria-label={`Recovery key: ${recoveryKey}`}>
				{recoveryKey.split('-').map((g, i) => (
					<span key={i}>{g}</span>
				))}
			</div>
			<div style={{display: 'flex', gap: 8, margin: '12px 0'}}>
				<button className="btn" style={{flex: 1}} onClick={copy}>
					<Icon name="copy" size={16} /> Copy
				</button>
				<button className="btn" style={{flex: 1}} onClick={download}>
					<Icon name="download" size={16} /> Save as file
				</button>
			</div>
			{!saved && (
				<label className="bk-check">
					<input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
					<span>I’ve saved it somewhere safe, away from this server (a password manager, or printed).</span>
				</label>
			)}
			<button className="btn block primary" disabled={!ok} onClick={done} style={{marginTop: 8}}>
				Done
			</button>
		</Sheet>
	)
}

function RestoreSheet({name, list, onClose, onRestore}: {appId: string; name: string; list: Snapshot[]; onClose: () => void; onRestore: (s: Snapshot) => void}) {
	return (
		<Sheet open onClose={onClose} label={`Restore ${name}`}>
			<SheetHeader title={`Restore ${name}`} subtitle="Choose the backup to go back to." onClose={onClose} />
			<div className="glass group">
				{list.map((sn, i) => (
					<div className="row static" key={sn.id} style={{minHeight: 56}}>
						<span className="main">
							<b style={{fontWeight: 550}}>{stamp(sn.time)}</b>
							<span>
								{i === 0 ? 'Latest · ' : ''}
								{ago(sn.time)}
								{sn.size ? ` · ${bytes(sn.size)}` : ''}
							</span>
						</span>
						<button className="btn small" onClick={() => onRestore(sn)}>
							Restore
						</button>
					</div>
				))}
			</div>
		</Sheet>
	)
}

// A new or rebuilt server: open the backups already on the NAS with the recovery key.
function ConnectSheet({onClose}: {onClose: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const [f, setF] = useState({host: '', username: '', password: '', share: '', folder: 'Omarchy Server', recoveryKey: ''})
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const put = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({...f, [k]: e.target.value})
	const go = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const {recoveryKey, ...nas} = f
			await mutate('backups.connectExisting', {nas, recoveryKey})
			qc.invalidateQueries({queryKey: ['backups.status']})
			toast('Backups connected')
			onClose()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Sheet open onClose={onClose} label="Restore from an existing backup" tall>
			<SheetHeader title="Use an existing backup" subtitle="Copies the backups from your NAS to this server, so you can restore apps from them. Backups then continue from where they left off." onClose={onClose} />
			<form onSubmit={go}>
				<Field id="bkc-host" label="NAS name or address" value={f.host} onChange={put('host')} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
				<Field id="bkc-user" label="Username" value={f.username} onChange={put('username')} autoCapitalize="off" autoComplete="off" required />
				<Field id="bkc-pass" label="Password" type="password" value={f.password} onChange={put('password')} autoComplete="new-password" required />
				<Field id="bkc-share" label="Share" value={f.share} onChange={put('share')} autoCapitalize="off" required />
				<Field id="bkc-folder" label="Folder on the share" value={f.folder} onChange={put('folder')} required />
				<Field id="bkc-key" label="Recovery key" placeholder="abcd-efgh-…" value={f.recoveryKey} onChange={put('recoveryKey')} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
				{error && (
					<div className="error">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				<button className="btn block primary" disabled={busy} style={{marginTop: 6}}>
					{busy && <span className="spinner" />}
					Connect
				</button>
			</form>
		</Sheet>
	)
}
