// The assistant's character: the frame for what the assistant is doing (from the character sheet),
// brought to life like a flip-book (a blink now and then using the sleeping frame's closed eyes, a
// mouth that moves while it answers) plus gentle CSS motion (floating, a hop, a shake). Still for
// reduced motion, when turned off, or while the tab is in the background.
import {createContext, useContext, useEffect, useState, type CSSProperties} from 'react'

import {useAssistantAnimationState, type CharacterState} from '../assistantActivity'
import {characterById, CHARACTERS, DEFAULT_CHARACTER, STATES} from './registry'

// ---- the look (saved per account with the other preferences) ---------------------------------
export type AssistantLook = {
	character: string
	name: string
	animate: boolean
	intensity: 'minimal' | 'normal' | 'playful'
	size: 'small' | 'medium' | 'large'
	floating: boolean
	reactions: boolean
}
export const DEFAULT_LOOK: AssistantLook = {character: DEFAULT_CHARACTER, name: '', animate: true, intensity: 'normal', size: 'medium', floating: true, reactions: true}
export const NAME_MAX = 24
export const cleanName = (v: unknown) =>
	String(v ?? '')
		.replace(/[\u0000-\u001f\u007f<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, NAME_MAX)
export function cleanLook(v: unknown): AssistantLook {
	const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
	const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? (x as T) : d)
	return {
		character: CHARACTERS.some((c) => c.id === o.character) ? String(o.character) : DEFAULT_LOOK.character,
		name: cleanName(o.name),
		animate: o.animate !== false,
		intensity: pick(o.intensity, ['minimal', 'normal', 'playful'] as const, 'normal'),
		size: pick(o.size, ['small', 'medium', 'large'] as const, 'medium'),
		floating: o.floating !== false,
		reactions: o.reactions !== false,
	}
}
// The name shown for the assistant: yours, or the character's.
export const lookName = (look: AssistantLook) => look.name || characterById(look.character).name

export const AssistantLookContext = createContext<{look: AssistantLook; setLook: (next: AssistantLook) => void}>({look: DEFAULT_LOOK, setLook: () => {}})
export const useAssistantLook = () => useContext(AssistantLookContext)

// Load a character's frames once, so switching state never flickers.
const loaded = new Set<string>()
function preload(id: string) {
	if (loaded.has(id) || typeof Image === 'undefined') return
	loaded.add(id)
	const c = characterById(id)
	for (const s of STATES) new Image().src = c.frame(s)
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Which frame to show right now: the state's own, with a blink (idle) or a moving mouth (answering).
function useFrame(state: CharacterState, animate: boolean): CharacterState {
	const [alt, setAlt] = useState(false)
	useEffect(() => {
		setAlt(false)
		if (!animate || reducedMotion()) return
		const hidden = () => document.visibilityState === 'hidden'
		if (state === 'responding') {
			const t = window.setInterval(() => !hidden() && setAlt((a) => !a), 230)
			return () => window.clearInterval(t)
		}
		if (state === 'idle' || state === 'listening') {
			let t = 0
			const next = () => {
				t = window.setTimeout(() => {
					if (!hidden()) setAlt(true)
					t = window.setTimeout(() => (setAlt(false), next()), 150)
				}, 3500 + Math.random() * 4000)
			}
			next()
			return () => window.clearTimeout(t)
		}
	}, [state, animate])
	if (!alt) return state
	return state === 'responding' ? 'idle' : 'sleeping' // mouth closed / eyes closed
}

export function AssistantCharacter({
	id,
	state = 'idle',
	size = 56,
	animate = true,
	intensity = 'normal',
	label,
	className = '',
	style,
}: {
	id?: string
	state?: CharacterState
	size?: number
	animate?: boolean
	intensity?: AssistantLook['intensity']
	/** Spoken name; leave out where the character is decoration next to a visible label. */
	label?: string
	className?: string
	style?: CSSProperties
}) {
	const c = characterById(id)
	useEffect(() => preload(c.id), [c.id])
	const frame = useFrame(state, animate)
	return (
		<span
			className={`ac ac--${c.id} is-${state} ac-${intensity}${animate ? '' : ' still'} ${className}`}
			style={{'--ac-1': c.accent, width: size, height: size, ...style} as CSSProperties}
			role={label ? 'img' : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<img className="ac-img" src={c.frame(frame)} alt="" width={size} height={size} draggable={false} decoding="async" />
		</span>
	)
}

// The character where an icon was (Home tile, desktop icon), reacting like the floating one.
export function AssistantAvatar({size = 56, live = true}: {size?: number; live?: boolean}) {
	const {look} = useAssistantLook()
	const state = useAssistantAnimationState({reactions: look.reactions && live})
	return <AssistantCharacter id={look.character} state={live ? state : 'idle'} size={size} animate={look.animate && live} intensity={look.intensity} />
}
