import {useRef, useState, type CSSProperties} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, mutate, query, type Wallpaper} from '../api'
import {resetAssistantTurn} from '../assistantTurn'
import {resetDeskConfig} from '../desktop/config'
import {queryClearsOnSignOut} from '../signOutQueries'
import {useBootstrap, useUser} from '../data'
import {Icon} from '../icons'
import {applyPrefsUpdate, prefsAfterPhotoUpload, prefsChoosingYourPhoto} from '../photoPrefs'
import {ACCENTS, Card, KV, Row, THEMES, VersionTag, customBackgroundUrl, haptic, omarchyBackgroundUrl, preparePhoto, useConfirm, useOmarchyThemes, useToast, type Prefs, type ThemeId} from '../ui'
import {FactoryReset} from './machineHost'

export function Appearance({prefs, setPrefs, wallpaper, onTheme}: {prefs: Prefs; setPrefs: (p: Prefs) => void; wallpaper?: Wallpaper | null; onTheme?: (id: ThemeId) => void}) {
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const desktopBg = useOmarchyThemes().data?.current
	const wp = omarchyBackgroundUrl(prefs.omarchyBackground, desktopBg)
	const photo = customBackgroundUrl(prefs.backgroundVersion)
	const brand = wallpaper?.brandColorHsl ? `hsl(${wallpaper.brandColorHsl})` : 'hsl(24 90% 50%)'
	const photoBrand = prefs.customBrandHsl ? `hsl(${prefs.customBrandHsl})` : brand
	const accentPreview = prefs.theme === 'custom' ? photoBrand : brand

	const upload = async (file?: File | null) => {
		if (!file) return
		setUploading(true)
		try {
			const {blob, hsl} = await preparePhoto(file)
			const res = await fetch('/api/background', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1'}, body: blob})
			const body = await res.json().catch(() => null)
			if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
			applyPrefsUpdate(setPrefs, (latest) => prefsAfterPhotoUpload(latest, {hsl, backgroundVersion: body.prefs.backgroundVersion ?? null}, {setThemeCustom: true}))
			onTheme?.('custom')
			toast('Background saved')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
			if (fileRef.current) fileRef.current.value = ''
		}
	}
	return (
		<Card>
			<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
			<div className="themes" role="radiogroup" aria-label="Theme">
				{THEMES.filter((t) => t.id !== 'omarchy').map((t) => {
					const on = prefs.theme === t.id
					const isWall = t.id === 'horizon'
					const isPhoto = t.id === 'custom'
					const bg = isWall && wp ? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${wp}) center/cover` : isPhoto && photo ? `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${photo}) center/cover` : isPhoto ? 'linear-gradient(140deg, #2a2a33, #15151a)' : t.bg
					return (
						<button
							key={t.id}
							role="radio"
							aria-checked={on}
							className={`theme-card${on ? ' on' : ''}`}
							style={{background: bg, color: t.fg, minHeight: isWall || isPhoto ? 104 : undefined}}
							onClick={() => {
								haptic(6)
								if (isPhoto && !photo) return fileRef.current?.click()
								if (isPhoto) {
									applyPrefsUpdate(setPrefs, (latest) => prefsChoosingYourPhoto(latest))
									onTheme?.('custom')
									return
								}
								setPrefs({...prefs, theme: t.id})
								onTheme?.(t.id)
							}}
						>
							<span className="label">{t.name}</span>
							<span className="dots">
								{isWall ? (
									[brand, '#ffffff'].map((d) => <i key={d} style={{background: d}} />)
								) : isPhoto ? (
									photo ? (
										[photoBrand, '#ffffff'].map((d) => <i key={d} style={{background: d}} />)
									) : (
										<span style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, opacity: 0.85}}>
											{uploading ? <span className="spinner" style={{width: 14, height: 14}} /> : <Icon name="photo-up" size={16} />}
											{uploading ? 'Uploading…' : 'Upload'}
										</span>
									)
								) : (
									t.dots.map((d) => <i key={d} style={{background: d}} />)
								)}
							</span>
							{on && (
								<span className="tick">
									<Icon name="check" size={14} stroke={3} />
								</span>
							)}
						</button>
					)
				})}
			</div>
			<div className="section-head" style={{margin: '18px 0 6px'}}>
				<h2>Accent</h2>
			</div>
			<div className="accents" role="radiogroup" aria-label="Accent color">
				{ACCENTS.map((a) => (
					<button
						key={a}
						role="radio"
						aria-checked={prefs.accent === a}
						aria-label={a === 'wallpaper' ? 'Match background' : a}
						className={`accent-btn${prefs.accent === a ? ' on' : ''}`}
						style={{background: a === 'wallpaper' ? accentPreview : `var(--${a})`}}
						onClick={() => {
							haptic(6)
							setPrefs({...prefs, accent: a})
						}}
					>
						{a === 'wallpaper' && <Icon name="wallpaper" size={18} />}
					</button>
				))}
			</div>
		</Card>
	)
}

export function More({prefs, setPrefs, onSignedOut, onSettings, onClips}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; onSettings: () => void; onClips?: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const owner = user.data?.role !== 'member'
	const update = useQuery({
		queryKey: ['system.checkUpdate'],
		queryFn: () => query<{available: boolean; name: string; version: string}>('system.checkUpdate'),
		staleTime: 30 * 60_000,
		retry: false,
	})

	const power = async (kind: 'restart' | 'shutdown') => {
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your server?' : 'Shut down your server?',
			body:
				kind === 'restart'
					? 'All apps and machines stop, then come back once this server has restarted. This takes a few minutes.'
					: 'All apps and machines stop. You’ll need to turn the server back on yourself (for a VM, from its host).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (!ok) return
		try {
			await mutate(`system.${kind}`)
			toast(kind === 'restart' ? 'Your server is restarting' : 'Your server is shutting down')
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const finishSignOut = async () => {
		try {
			await logout()
		} catch (e) {
			toast((e as Error).message, true)
			return
		}
		qc.removeQueries({predicate: (q) => queryClearsOnSignOut(q.queryKey)})
		resetDeskConfig()
		resetAssistantTurn()
		onSignedOut()
	}
	const signOut = async () => {
		const ok = await confirm({title: 'Sign out?', body: 'This device is signed out and removed from your server’s devices.', confirm: 'Sign out', icon: 'signout'})
		if (!ok) return
		await finishSignOut()
	}

	return (
		<div className="stagger">
			<div>
				<h1 className="title">System</h1>
				<p className="subtitle">
					{boot.server?.device ?? 'server'} · <VersionTag version={boot.server?.name ?? boot.server?.version} info={boot.server} />
				</p>
			</div>
			<section>
				<div className="section-head">
					<h2>Your server</h2>
				</div>
				<KV
					rows={[
						['Device', boot.server?.device ?? '–'],
						['Address', boot.server?.host ?? '–'],
						['MODC', <VersionTag version={boot.server?.version} info={boot.server} />],
						['Software update', update.data ? (update.data.available ? `${update.data.name} available` : 'Up to date') : '–'],
						['Signed in as', `${user.data?.name ?? '–'}${user.data?.role ? ` (${user.data.role})` : ''}`],
					]}
				/>
				<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
					{onClips && <Row icon="clipboard" color="var(--teal)" label="Clip book" onClick={onClips} />}
					<Row icon="settings" color="#8e8e93" label="Settings" onClick={onSettings} />
					<Row icon="open" color="var(--blue)" label="Open this server" href={boot.server?.url} />
					<Row icon="restart" color="var(--peach)" label="Restart server" onClick={() => power('restart')} />
					<Row icon="power" color="var(--red)" label="Shut down server" onClick={() => power('shutdown')} />
					{owner && (
						<FactoryReset
							onDone={async () => {
								// The reset already ended the session. Logout may answer 401; still leave the signed-in page.
								await logout().catch(() => {})
								qc.removeQueries({predicate: (q) => queryClearsOnSignOut(q.queryKey)})
								resetDeskConfig()
								resetAssistantTurn()
								onSignedOut()
							}}
						/>
					)}
					<Row icon="signout" color="#8e8e93" label="Sign out of this device" onClick={signOut} />
				</div>
			</section>
			<p className="footer-note">
				<VersionTag prefix="MODC " version={boot.touch.version} info={boot.server} />
			</p>
		</div>
	)
}
