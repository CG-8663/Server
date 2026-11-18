// The character in the app: the floating launcher, the picker and live preview in Settings, and the
// small icon used where the assistant appears (Home, the desktop). Opening the assistant is the only
// thing any of them do.
import {useEffect, useState, type CSSProperties} from 'react'

import {useAssistantActivity, useAssistantAnimationState, type CharacterState} from '../assistantActivity'
import {Icon} from '../icons'
import {Row, Segmented, Switch, haptic} from '../ui'
import {AssistantCharacter, DEFAULT_LOOK, lookName, NAME_MAX, useAssistantLook, type AssistantLook} from './AssistantCharacter'
import {CHARACTERS, characterById} from './registry'

export const SIZES: Record<AssistantLook['size'], number> = {small: 48, medium: 62, large: 78}

// Background tab: hold every character still (no work for an unseen page).
export function usePauseWhenHidden() {
	useEffect(() => {
		const apply = () => document.documentElement.classList.toggle('ac-paused', document.visibilityState === 'hidden')
		apply()
		document.addEventListener('visibilitychange', apply)
		return () => {
			document.removeEventListener('visibilitychange', apply)
			document.documentElement.classList.remove('ac-paused')
		}
	}, [])
}

// The floating character. Hidden: nothing here (the assistant still opens from Home or the desktop).
export function AssistantCharacterWidget({onOpen}: {onOpen: () => void}) {
	const {look} = useAssistantLook()
	const activity = useAssistantActivity()
	const [hover, setHover] = useState(false)
	const state = useAssistantAnimationState({hover, reactions: look.reactions})
	usePauseWhenHidden()
	if (!look.floating) return null
	const name = lookName(look)
	const waiting = activity.pending
	const label = `Open ${name}${waiting ? `, ${waiting} step${waiting === 1 ? '' : 's'} waiting for you` : activity.phase === 'error' ? ', something went wrong' : ''}`
	return (
		<button
			type="button"
			className="ac-widget"
			aria-label={label}
			title={name}
			style={{width: SIZES[look.size], height: SIZES[look.size]} as CSSProperties}
			onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
			onPointerLeave={() => setHover(false)}
			onFocus={() => setHover(true)}
			onBlur={() => setHover(false)}
			onClick={() => {
				haptic(8)
				onOpen()
			}}
		>
			<AssistantCharacter id={look.character} state={state} size={SIZES[look.size]} animate={look.animate} intensity={look.intensity} />
			{waiting > 0 ? (
				<span className="ac-dot" aria-hidden="true">
					{waiting}
				</span>
			) : activity.phase === 'error' ? (
				<span className="ac-dot warn" aria-hidden="true">
					!
				</span>
			) : null}
		</button>
	)
}

// Pick a character: a grid of them (hover says hello). `value` is the one in use (checked); `focus`
// is the one shown in the panel beside the grid.
export function AssistantCharacterPicker({value, focus, onFocus, animate, intensity}: {value: string; focus: string; onFocus: (id: string) => void; animate: boolean; intensity: AssistantLook['intensity']}) {
	const [hover, setHover] = useState<string | null>(null)
	return (
		<div className="ac-picker" role="radiogroup" aria-label="Characters">
			{CHARACTERS.map((c) => (
				<button
					key={c.id}
					type="button"
					role="radio"
					aria-checked={c.id === focus}
					className={`ac-pick${c.id === value ? ' in-use' : ''}`}
					style={{'--ac-1': c.accent} as CSSProperties}
					onPointerEnter={() => setHover(c.id)}
					onPointerLeave={() => setHover(null)}
					onClick={() => {
						haptic(6)
						onFocus(c.id)
					}}
				>
					{c.id === value && (
						<span className="ac-check" aria-label="Selected">
							<Icon name="check" size={14} stroke={3} />
						</span>
					)}
					<AssistantCharacter id={c.id} state={hover === c.id ? 'hover' : 'idle'} size={88} animate={animate} intensity={intensity} />
					<b>{c.name}</b>
					<span>{c.tagline}</span>
				</button>
			))}
		</div>
	)
}

const PREVIEW_STATES: {id: CharacterState; label: string}[] = [
	{id: 'idle', label: 'Idle'},
	{id: 'hover', label: 'Hover'},
	{id: 'listening', label: 'Listening'},
	{id: 'thinking', label: 'Thinking'},
	{id: 'responding', label: 'Responding'},
	{id: 'working', label: 'Working'},
	{id: 'success', label: 'Success'},
	{id: 'error', label: 'Error'},
	{id: 'sleeping', label: 'Sleeping'},
]

// The panel beside the grid: the character, large, and how to use it.
export function AssistantCharacterPreview({id, look, inUse, onUse, onCustomize}: {id: string; look: AssistantLook; inUse: boolean; onUse: () => void; onCustomize: () => void}) {
	const [state, setState] = useState<CharacterState>('idle')
	useEffect(() => setState('idle'), [id])
	const c = characterById(id)
	const name = inUse ? lookName(look) : c.name
	return (
		<div className="glass ac-panel" style={{'--ac-1': c.accent} as CSSProperties}>
			<AssistantCharacter id={c.id} state={state} size={180} animate={look.animate} intensity={look.intensity} label={`${name}, ${state}`} />
			<div className="ac-panel-head">
				<b>{name}</b>
				{inUse && (
					<span className="ac-pill">
						<Icon name="check" size={13} stroke={3} /> Selected
					</span>
				)}
			</div>
			<p>{c.description}</p>
			<div className="ac-chips" aria-label="What it does">
				<span>
					<Icon name="terminal" size={15} /> Chat &amp; Commands
				</span>
				<span>
					<Icon name="server" size={15} /> Manage Systems
				</span>
				<span>
					<Icon name="bolt" size={15} /> Run Automations
				</span>
			</div>
			<div className="states" role="group" aria-label="Preview a state">
				{PREVIEW_STATES.map((s) => (
					<button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>
						{s.label}
					</button>
				))}
			</div>
			<div className="ac-panel-actions">
				<button type="button" className="btn primary ac-use" disabled={inUse} onClick={() => (haptic(8), onUse())}>
					<Icon name="check" size={17} stroke={2.6} /> {inUse ? `Using ${c.name}` : `Use ${c.name}`}
				</button>
				<button type="button" className="btn" onClick={() => (haptic(6), onCustomize())}>
					<Icon name="settings" size={17} /> Customize
				</button>
			</div>
		</div>
	)
}

// Settings → Assistant → Assistant Appearance ("Choose Your AI Assistant"). Saved per account.
export function AssistantAppearanceSettings() {
	const {look, setLook} = useAssistantLook()
	const [focus, setFocus] = useState(look.character)
	const [name, setName] = useState(look.name)
	const [custom, setCustom] = useState(false)
	useEffect(() => setName(look.name), [look.name])
	const set = (patch: Partial<AssistantLook>) => setLook({...look, ...patch})
	const isDefault = JSON.stringify(look) === JSON.stringify(DEFAULT_LOOK)
	const customize = () => {
		setCustom(true)
		requestAnimationFrame(() => document.getElementById('ac-customize')?.scrollIntoView({behavior: 'smooth', block: 'start'}))
	}
	return (
		<section className="ac-settings" aria-labelledby="ac-settings-title">
			<div className="section-head" style={{marginTop: 22}}>
				<h2 id="ac-settings-label">Assistant Appearance</h2>
			</div>
			<h2 className="ac-title" id="ac-settings-title">
				Choose Your <em>AI Assistant</em>
			</h2>
			<p className="ac-lead">Pick a mascot for your Omarchy Server widget. Your assistant lives in the UI, helps you manage your home lab, and keeps everything running smoothly.</p>
			<div className="ac-choose">
				<AssistantCharacterPicker value={look.character} focus={focus} onFocus={setFocus} animate={look.animate} intensity={look.intensity} />
				<AssistantCharacterPreview id={focus} look={look} inUse={focus === look.character} onUse={() => set({character: focus})} onCustomize={customize} />
			</div>
			{custom && (
				<div id="ac-customize">
					<div className="glass group" style={{marginTop: 14, padding: '12px 14px'}}>
						<div className="field">
							<label htmlFor="ac-name">Name</label>
							<input
								id="ac-name"
								value={name}
								maxLength={NAME_MAX}
								placeholder={characterById(look.character).name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => name !== look.name && set({name})}
								onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
							/>
						</div>
						<div className="field">
							<label>Size</label>
							<Segmented label="Size" value={look.size} onChange={(size) => set({size})} options={[{id: 'small', label: 'Small'}, {id: 'medium', label: 'Medium'}, {id: 'large', label: 'Large'}]} />
						</div>
						<div className="field">
							<label>Animation</label>
							<Segmented label="Animation" value={look.intensity} onChange={(intensity) => set({intensity})} options={[{id: 'minimal', label: 'Minimal'}, {id: 'normal', label: 'Normal'}, {id: 'playful', label: 'Playful'}]} />
						</div>
					</div>
					<div className="glass group" style={{marginTop: 12, '--inset': '62px'} as CSSProperties}>
						<Row icon="sparkle" color="var(--green)" label="Animate" sub="Off: the character stays still" trailing={<Switch on={look.animate} label="Animate" onChange={(animate) => set({animate})} />} />
						<Row icon="bolt" color="var(--peach)" label="Reactions" sub="Thinking, working, done and problems" trailing={<Switch on={look.reactions} label="Reactions" onChange={(reactions) => set({reactions})} />} />
						<Row icon="eye" color="var(--blue)" label="Floating character" sub="Off: open it from Home or the desktop" trailing={<Switch on={look.floating} label="Floating character" onChange={(floating) => set({floating})} />} />
					</div>
					<button type="button" className="btn block" style={{marginTop: 12}} disabled={isDefault} onClick={() => (haptic(6), setLook(DEFAULT_LOOK), setFocus(DEFAULT_LOOK.character))}>
						Restore default appearance
					</button>
				</div>
			)}
		</section>
	)
}
