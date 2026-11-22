// Appearance for the app and for this device's desktop: one page, so phone-or-desktop and
// Ubuntu-or-Hyprland sit together, and the dock is not a second theme picker.
import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react'

import {useUser} from '../data'
import {Icon} from '../icons'
import {OmarchyBackgrounds} from '../OmarchyBackgrounds'
import {applyPrefsUpdate, prefsAfterPhotoUpload} from '../photoPrefs'
import {Appearance} from '../screens/More'
import {Row, Segmented, SolidColors, Switch, customBackgroundUrl, haptic, preparePhoto, setLayoutPref, useLayout, useOmarchyThemes, useToast, wallpaperUrl, type LayoutPref, type Prefs} from '../ui'
import {takeAppearanceFocus} from './settingsPage'
import {STYLES, solidOf, SYSTEM_DOCK, WALLPAPERS, useDeskConfig, wallpaperSrc, type DeskAccent, type DeskConfig, type DeskShell, type DockHover, type DockPos, DOCK_ICON_MAX, DOCK_ICON_MIN} from './config'
import {CAPTURE_KEY, canUseKeyboardLock, coerceMode, keyboardLockApi, type CaptureMode} from './hyprland/grab'
import {SnippetBlock} from './hyprland/Snippet'
import {DESKTOP_KEY, useDesktop, useItems, type ItemInfo} from './Desktop'

const FOCUS: Record<string, string> = {layout: 'appearance-layout', dock: 'appearance-dock', desktop: 'appearance-desktop', themes: 'appearance-themes', background: 'appearance-background'}
const PANEL_ACCENTS: {id: DeskAccent; label: string; swatch: string}[] = [
	{id: 'app', label: 'App theme', swatch: 'var(--accent)'},
	{id: 'wallpaper', label: 'From wallpaper', swatch: 'conic-gradient(#f97316,#eab308,#22c55e,#06b6d4,#8b5cf6,#ec4899,#f97316)'},
	{id: 'blue', label: 'Blue', swatch: 'var(--blue)'},
	{id: 'mauve', label: 'Mauve', swatch: 'var(--mauve)'},
	{id: 'teal', label: 'Teal', swatch: 'var(--teal)'},
	{id: 'green', label: 'Green', swatch: 'var(--green)'},
	{id: 'peach', label: 'Peach', swatch: 'var(--peach)'},
	{id: 'pink', label: 'Pink', swatch: 'var(--pink)'},
]

export function Personalize({tab: initial, prefs, setPrefs, embedded, onOpenThemes}: {tab?: string; prefs: Prefs; setPrefs: (p: Prefs) => void; embedded?: boolean; onOpenThemes?: () => void}) {
	const user = useUser()
	const root = useRef<HTMLDivElement>(null)
	const omarchyTheme = useOmarchyThemes(!!onOpenThemes)
	const [cfg, setCfg] = useDeskConfig()
	useEffect(() => {
		let focus = initial ?? ''
		try {
			const saved = takeAppearanceFocus(sessionStorage)
			if (saved) focus = saved
		} catch {
			/* private */
		}
		const id = FOCUS[focus]
		if (!id) return
		root.current?.querySelector(`#${id}`)?.scrollIntoView({block: 'start'})
	}, [initial])
	return (
		<div className="personalize" ref={root}>
			{!embedded && (
				<h1 className="title" style={{margin: '4px 0 14px'}}>
					Appearance
				</h1>
			)}
			<Appearance prefs={prefs} setPrefs={setPrefs} wallpaper={user.data?.wallpaper} />
			{onOpenThemes && (
				<section>
					<div className="section-head">
						<h2>Omarchy</h2>
					</div>
					<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
						<Row icon="palette" color="var(--blue)" label="Themes" value={omarchyTheme.data?.label ?? undefined} onClick={onOpenThemes} />
					</div>
					<p className="footer-note" style={{textAlign: 'left', margin: '10px 6px 0'}}>
						Your Omarchy desktop’s themes. Switch the whole desktop, or get more from the Omarchy manual.
					</p>
				</section>
			)}
			<div id="appearance-layout">
				<LayoutSettings cfg={cfg} setCfg={setCfg} />
			</div>
			<div id="appearance-dock">
				<DockSettings cfg={cfg} setCfg={setCfg} />
			</div>
			<div id="appearance-desktop">
				<DesktopSettings cfg={cfg} setCfg={setCfg} />
			</div>
			<div id="appearance-themes">
				<Themes cfg={cfg} setCfg={setCfg} />
			</div>
			<div id="appearance-background">
				<Background desktopPictures cfg={cfg} setCfg={setCfg} prefs={prefs} setPrefs={setPrefs} />
			</div>
		</div>
	)
}

type P = {cfg: DeskConfig; setCfg: (fn: (c: DeskConfig) => DeskConfig) => void}

function Section({title, note, children}: {title: string; note?: ReactNode; children: ReactNode}) {
	return (
		<section className="pz-section">
			<div className="section-head">
				<h2>{title}</h2>
			</div>
			{children}
			{note && <p className="footer-note pz-note">{note}</p>}
		</section>
	)
}

function LayoutSettings({cfg, setCfg}: P) {
	const toast = useToast()
	const layout = useLayout()
	const secure = typeof window !== 'undefined' && window.isSecureContext
	const hasLock = typeof navigator !== 'undefined' && !!keyboardLockApi()
	const [mode, setMode] = useState<CaptureMode>(() => {
		try {
			const v = localStorage.getItem(CAPTURE_KEY)
			if (v === 'host' || v === 'keyboard-lock') return coerceMode(v, secure)
		} catch {
			/* private */
		}
		return secure && hasLock ? 'keyboard-lock' : 'host'
	})
	const setCapture = (next: CaptureMode) => {
		const v = coerceMode(next, secure)
		setMode(v)
		try {
			localStorage.setItem(CAPTURE_KEY, v)
		} catch {
			/* private */
		}
		window.dispatchEvent(new CustomEvent('omarchy:key-capture', {detail: v}))
	}
	return (
		<>
			<Section title="Layout" note="Phone or desktop is this screen. Automatic uses the desktop on a big screen with a pointer. Ubuntu floats windows over a dock. Hyprland tiles them, with workspaces 1–9 and Omarchy Super shortcuts.">
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Phone or desktop</b>
						</span>
						<Segmented<LayoutPref>
							label="Phone or desktop"
							value={layout.pref}
							options={[
								{id: 'auto', label: 'Automatic'},
								{id: 'desktop', label: 'Desktop'},
								{id: 'phone', label: 'Phone'},
							]}
							onChange={(v) => {
								haptic(6)
								setLayoutPref(v)
							}}
						/>
					</div>
					<div className="row static">
						<span className="main">
							<b>Ubuntu or Hyprland</b>
						</span>
						<Segmented<DeskShell>
							label="Ubuntu or Hyprland"
							value={cfg.shell ?? 'gnome'}
							options={[
								{id: 'gnome', label: 'Ubuntu'},
								{id: 'hyprland', label: 'Hyprland'},
							]}
							onChange={(v) => setCfg((c) => ({...c, shell: v}))}
						/>
					</div>
				</div>
			</Section>
			{/* Key capture and the snippet only matter in the Hyprland layout (Ubuntu keeps Super for Activities). */}
			{cfg.shell === 'hyprland' && (
			<>
			<Section title="Key capture" note="On an Omarchy computer, Super is taken by the desktop until you pass it through. HTTP can use host passthrough. Fullscreen system keys need https:// in Chrome, Edge or Brave.">
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Capture Super</b>
						</span>
						<Segmented<CaptureMode>
							label="Capture Super"
							value={mode}
							options={[
								{id: 'host', label: 'Host passthrough'},
								{id: 'keyboard-lock', label: 'Fullscreen'},
							]}
							onChange={(v) => {
								if (v === 'keyboard-lock' && !canUseKeyboardLock(secure, hasLock)) {
									toast('Open https:// in Chrome, Edge or Brave for fullscreen Super, or stay on host passthrough.')
									return
								}
								setCapture(v)
							}}
						/>
					</div>
				</div>
				{!secure && (
					<p className="footer-note pz-note">
						<button className="btn" onClick={() => (location.href = `https://${location.host}${location.pathname}${location.search}`)}>
							Open HTTPS
						</button>
					</p>
				)}
			</Section>
			<Section title="Omarchy snippet" note="Paste it at the end of your Hyprland key config on the Omarchy computer you browse from, run hyprctl reload, then press Scroll Lock (or Super+F12) to keep Super in this browser. Press it again to give Super back.">
				<SnippetBlock />
			</Section>
			</>
			)}
		</>
	)
}

function Themes({cfg, setCfg}: P) {
	return (
		<>
			<Section title="Panels" note="The top bar and the dock on this device. App theme uses the accent in the theme above.">
				<div className="pz-grid styles">
					{STYLES.map((s) => (
						<button key={s.id} className={`pz-card style-card${cfg.style === s.id ? ' on' : ''}`} onClick={() => setCfg((c) => ({...c, preset: null, style: s.id}))}>
							<span className={`pz-thumb style-swatch style-${s.id}`} style={{backgroundImage: `url(${wallpaperSrc(WALLPAPERS.find((w) => w.id === cfg.wallpaper)?.id ?? 'valley', true)})`}}>
								<i className="tt-bar" />
								<i className="tt-dock" />
								{cfg.style === s.id && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>{s.name}</b>
							<small>{s.note}</small>
						</button>
					))}
				</div>
			</Section>
			<Section title="Panel accent">
				<div className="pz-accents">
					{PANEL_ACCENTS.map((a) => (
						<button key={a.id} className={`pz-accent${cfg.accent === a.id ? ' on' : ''}`} onClick={() => setCfg((c) => ({...c, preset: null, accent: a.id}))} aria-pressed={cfg.accent === a.id}>
							<i style={{background: a.swatch}} />
							{a.label}
						</button>
					))}
				</div>
			</Section>
		</>
	)
}

function Background({cfg, setCfg, prefs, setPrefs, desktopPictures = false}: P & {prefs: Prefs; setPrefs: (p: Prefs) => void; desktopPictures?: boolean}) {
	const user = useUser()
	const toast = useToast()
	const fileRef = useRef<HTMLInputElement>(null)
	const [uploading, setUploading] = useState(false)
	const photo = customBackgroundUrl(prefs.backgroundVersion)
	const serverWall = wallpaperUrl(user.data?.wallpaper)
	const pick = (id: DeskConfig['wallpaper']) => {
		haptic(6)
		setCfg((c) => ({...c, preset: null, wallpaper: id}))
	}
	const upload = async (file?: File | null) => {
		if (!file) return
		setUploading(true)
		try {
			const {blob, hsl} = await preparePhoto(file)
			const res = await fetch('/api/background', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'image/jpeg', 'x-omarchy-server': '1'}, body: blob})
			const body = await res.json().catch(() => null)
			if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed')
			// Only the photo is stored; the phone keeps its own theme unless you choose "Your photo" there.
			applyPrefsUpdate(setPrefs, (latest) => prefsAfterPhotoUpload(latest, {hsl, backgroundVersion: body.prefs.backgroundVersion ?? null}, {setThemeCustom: false}))
			setCfg((c) => ({...c, preset: null, wallpaper: 'photo'}))
			toast('Background set')
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setUploading(false)
			if (fileRef.current) fileRef.current.value = ''
		}
	}
	return (
		<>
			{!desktopPictures && (
				<Section title="Omarchy" note="Backgrounds from your Omarchy desktop’s themes. “Same as desktop” follows whatever the desktop shows.">
					<OmarchyBackgrounds
						selected={cfg.wallpaper === 'omarchy' ? (prefs.omarchyBackground ?? null) : undefined}
						onChoose={(id) => {
							setPrefs({...prefs, omarchyBackground: id})
							setCfg((c) => ({...c, preset: null, wallpaper: 'omarchy'}))
						}}
					/>
				</Section>
			)}
						<Section title={desktopPictures ? 'Desktop pictures' : 'Wallpapers'} note={desktopPictures ? 'Pictures behind the windows on this device. The theme above is the app.' : 'High-resolution photos from the elementary OS collection (CC0, Unsplash and Pexels licences; credits in wallpapers/CREDITS.md).'}>
				<div className="pz-grid walls">
					{WALLPAPERS.map((w) => (
						<button key={w.id} className={`pz-card wall-card${cfg.wallpaper === w.id ? ' on' : ''}`} onClick={() => pick(w.id)} title={`${w.name} · ${w.by}`}>
							<span className="pz-thumb" style={{backgroundImage: `url(${wallpaperSrc(w.id, true)})`}}>
								{cfg.wallpaper === w.id && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>{w.name}</b>
						</button>
					))}
				</div>
			</Section>
			{!desktopPictures && (
				<Section title="Solid colour" note="A plain colour instead of a picture.">
					<SolidColors value={solidOf(cfg.wallpaper)} onChange={(c) => (haptic(6), setCfg((x) => ({...x, preset: null, wallpaper: (c ? `color:${c}` : 'omarchy') as DeskConfig['wallpaper']})))} />
				</Section>
			)}
			<Section title="Your own">
				<div className="pz-grid walls">
					<button className={`pz-card wall-card${cfg.wallpaper === 'server' ? ' on' : ''}`} onClick={() => pick('server')}>
						<span className="pz-thumb" style={{backgroundImage: serverWall ? `url(${serverWall})` : undefined}}>
							{cfg.wallpaper === 'server' && <Icon name="check" size={16} stroke={3} className="pz-check" />}
						</span>
						<b>Server wallpaper</b>
					</button>
					{photo && (
						<button className={`pz-card wall-card${cfg.wallpaper === 'photo' ? ' on' : ''}`} onClick={() => pick('photo')}>
							<span className="pz-thumb" style={{backgroundImage: `url(${photo})`}}>
								{cfg.wallpaper === 'photo' && <Icon name="check" size={16} stroke={3} className="pz-check" />}
							</span>
							<b>Your photo</b>
						</button>
					)}
					<button className="pz-card wall-card add" onClick={() => fileRef.current?.click()} disabled={uploading}>
						<span className="pz-thumb add-thumb">{uploading ? <span className="spinner" /> : <Icon name="upload" size={26} />}</span>
						<b>{photo ? 'Replace photo…' : 'Upload a photo…'}</b>
					</button>
					<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
				</div>
			</Section>
		</>
	)
}

function DockSettings({cfg, setCfg}: P) {
	const {info, appList, machineList, owner} = useItems()
	const d = cfg.dock
	const set = (patch: Partial<DeskConfig['dock']>) => setCfg((c) => ({...c, dock: {...c.dock, ...patch}}))
	const hyprNote = cfg.shell === 'hyprland' ? 'The dock is hidden in the Hyprland layout. These settings apply when you switch back to Ubuntu.' : undefined
	const move = (k: string, dir: -1 | 1) => {
		const items = [...d.items]
		const i = items.indexOf(k)
		const j = i + dir
		if (j < 0 || j >= items.length) return
		;[items[i], items[j]] = [items[j], items[i]]
		set({items})
	}
	const candidates = allKeys(appList, machineList, owner).filter((k) => !d.items.includes(k))
	return (
		<>
			<Section title="Position" note={hyprNote}>
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Position</b>
						</span>
						<Segmented<DockPos>
							label="Dock position"
							value={d.position}
							options={[
								{id: 'left', label: 'Left'},
								{id: 'bottom', label: 'Bottom'},
								{id: 'right', label: 'Right'},
								{id: 'top', label: 'Top'},
							]}
							onChange={(v) => set({position: v})}
						/>
					</div>
					<div className="row static pz-slider">
						<span className="main">
							<b>Icon size</b>
							<span>{d.iconSize} px</span>
						</span>
						<input
							type="range"
							min={DOCK_ICON_MIN}
							max={DOCK_ICON_MAX}
							step={2}
							value={d.iconSize}
							aria-label="Icon size"
							onChange={(e) => set({iconSize: Number(e.target.value)})}
						/>
					</div>
				</div>
			</Section>
			<Section title="Animations" note="Turned down automatically when your computer asks for reduced motion.">
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>When the pointer is over an icon</b>
						</span>
						<Segmented<DockHover>
							label="Hover effect"
							value={d.hover}
							options={[
								{id: 'none', label: 'Nothing'},
								{id: 'lift', label: 'Lift'},
								{id: 'magnify', label: 'Magnify'},
							]}
							onChange={(v) => set({hover: v})}
						/>
					</div>
					{d.hover === 'magnify' && (
						<div className="row static pz-slider">
							<span className="main">
								<b>Magnification</b>
								<span>{Math.round(d.magnify * 100)}%</span>
							</span>
							<input type="range" min={1.2} max={2.2} step={0.1} value={d.magnify} aria-label="Magnification" onChange={(e) => set({magnify: Number(e.target.value)})} />
						</div>
					)}
					<ToggleRow label="Bounce when opening" note="An app that isn’t open yet bounces in the dock while it opens" on={d.bounce} onChange={(v) => set({bounce: v})} />
				</div>
			</Section>
			<Section title="Behaviour">
				<div className="glass group pz-rows">
					<ToggleRow label="Floating" note="A rounded dock with space around it, instead of a full-height panel" on={d.floating} onChange={(v) => set({floating: v})} />
					<ToggleRow label="Auto-hide" note="Slides away; move the pointer to the screen edge to bring it back" on={d.autohide} onChange={(v) => set({autohide: v})} />
					<ToggleRow label="Show open apps" note="Apps and machines that are open but not pinned appear after a divider" on={d.showRunning} onChange={(v) => set({showRunning: v})} />
				</div>
			</Section>
			<Section title="In the dock" note="Tip: you can also drag icons in the dock to reorder them, drag one onto the desktop to add an icon there, and right-click any app to pin it.">
				<div className="glass group pz-rows" style={{'--inset': '66px'} as CSSProperties}>
					{d.items.map((k, i) => {
						const it = info(k)
						return (
							<div key={k} className="row static pz-item">
								<span className="pz-ico">{it.icon(36)}</span>
								<span className="main">
									<b>{it.label}</b>
									{it.missing && <span>Not available</span>}
								</span>
								<button className="icon-btn" aria-label={`Move ${it.label} up`} disabled={i === 0} onClick={() => move(k, -1)}>
									<Icon name="chevron-down" size={16} style={{transform: 'rotate(180deg)'}} />
								</button>
								<button className="icon-btn" aria-label={`Move ${it.label} down`} disabled={i === d.items.length - 1} onClick={() => move(k, 1)}>
									<Icon name="chevron-down" size={16} />
								</button>
								<button className="icon-btn danger-x" aria-label={`Remove ${it.label} from the dock`} onClick={() => set({items: d.items.filter((x) => x !== k)})}>
									<Icon name="close" size={15} stroke={2.4} />
								</button>
							</div>
						)
					})}
					{d.items.length === 0 && <div className="row static muted">The dock is empty. Add something below.</div>}
				</div>
				<div className="pz-actions">
					<button className="btn" onClick={() => set({items: [...SYSTEM_DOCK]})}>
						<Icon name="restart" size={16} />
						Reset to default
					</button>
				</div>
			</Section>
			<Section title="Add to the dock">
				<ItemPicker keys={candidates} info={info} onPick={(k) => set({items: [...d.items, k]})} actionLabel="Add" />
			</Section>
		</>
	)
}

function DesktopSettings({cfg, setCfg}: P) {
	const desk = useDesktop()
	const {info, appList, machineList, owner} = useItems()
	const onDesk = new Set(cfg.icons.map((i) => i.key))
	const running = [
		...appList.filter((a) => a.state === 'ready' || a.state === 'running').map((a) => `app:${a.id}`),
		...(owner ? [DESKTOP_KEY] : []),
		...machineList.filter((m) => m.state === 'running').map((m) => `machine:${m.id}`),
	].filter((k) => !onDesk.has(k))
	const hyprNote = cfg.shell === 'hyprland' ? 'Desktop icons are hidden in the Hyprland layout. These settings apply when you switch back to Ubuntu.' : undefined
	return (
		<>
			<Section
				title="Opening apps"
				note="Some apps (Forgejo, Nextcloud, Home Assistant and others) don’t allow being shown inside another page. Those always open in their own browser tab."
			>
				<div className="glass group pz-rows">
					<div className="row static">
						<span className="main">
							<b>Open apps in</b>
						</span>
						<Segmented<'auto' | 'tab'>
							label="Open apps in"
							value={cfg.appsOpenIn}
							options={[
								{id: 'auto', label: 'Windows'},
								{id: 'tab', label: 'Browser tabs'},
							]}
							onChange={(v) => setCfg((c) => ({...c, appsOpenIn: v}))}
						/>
					</div>
				</div>
			</Section>
			<Section title="Desktop" note={hyprNote}>
				<div className="glass group pz-rows">
					<ToggleRow label="Show icons on the desktop" on={cfg.showIcons} onChange={(v) => setCfg((c) => ({...c, showIcons: v}))} />
				</div>
				<div className="pz-actions">
					<button className="btn primary" disabled={!running.length} onClick={() => running.forEach((k) => desk?.addIcon(k))}>
						<Icon name="plus" size={16} />
						Add all running apps and machines{running.length ? ` (${running.length})` : ''}
					</button>
				</div>
			</Section>
			<Section title="Choose icons" note="Double-click an icon to open it. Drag icons to arrange them, drag across the desktop to select several, and press Delete to remove the selected icons (only the shortcut is removed). A stopped machine starts when you open it.">
				<ItemPicker
					keys={allKeys(appList, machineList, owner, true)}
					info={info}
					selected={onDesk}
					onPick={(k) => (onDesk.has(k) ? desk?.removeIcon(k) : desk?.addIcon(k))}
				/>
			</Section>
		</>
	)
}

function allKeys(appList: {id: string; name?: string}[], machineList: {id: string}[], owner: boolean, folders = false) {
	return [
		...(folders ? ['folder:/Home', 'folder:/Trash'] : []),
		...SYSTEM_DOCK.filter((k) => k !== 'terminal' || owner),
		'assistant',
		'personalize',
		...[...appList].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((a) => `app:${a.id}`),
		...(owner ? [DESKTOP_KEY] : []),
		...machineList.map((m) => `machine:${m.id}`),
	]
}

function ItemPicker({keys, info, selected, onPick, actionLabel}: {keys: string[]; info: (k: string) => ItemInfo; selected?: Set<string>; onPick: (k: string) => void; actionLabel?: string}) {
	const groups: [string, (k: string) => boolean][] = [
		['Folders', (k) => k.startsWith('folder:')],
		['System', (k) => !k.includes(':')],
		['Apps', (k) => k.startsWith('app:')],
		['Machines', (k) => k.startsWith('machine:')],
	]
	return (
		<>
			{groups.map(([title, test]) => {
				const list = keys.filter(test).map(info)
				if (!list.length) return null
				return (
					<div key={title} className="pz-pick-group">
						<h3>{title}</h3>
						<div className="pz-pick">
							{list.map((it) => {
								const on = selected?.has(it.key)
								return (
									<button key={it.key} className={`pz-pick-item${on ? ' on' : ''}`} onClick={() => (haptic(5), onPick(it.key))} aria-pressed={selected ? on : undefined}>
										<span className="desk-icon-art">
											{it.icon(48)}
											{it.status && it.status !== 'stopped' && (it.key.startsWith('app:') || it.key.startsWith('machine:')) && <span className={`state-dot ${it.status}`} />}
											{selected && <span className={`pick-check${on ? ' on' : ''}`}>{on && <Icon name="check" size={13} stroke={3} />}</span>}
										</span>
										<span className="pz-pick-label">{it.label}</span>
										{actionLabel && <span className="pz-pick-action">{actionLabel}</span>}
									</button>
								)
							})}
						</div>
					</div>
				)
			})}
		</>
	)
}

function ToggleRow({label, note, on, onChange}: {label: string; note?: string; on: boolean; onChange: (v: boolean) => void}) {
	return (
		<div className="row static">
			<span className="main">
				<b>{label}</b>
				{note && <span>{note}</span>}
			</span>
			<Switch on={on} onChange={onChange} label={label} />
		</div>
	)
}
