// The assistant's character: a body from the registry, a face that shows what the assistant is doing,
// and small overlays (thinking dots, a working spinner, a check after a confirmed success, an alert
// on an error, z's while sleeping). SVG + CSS only; still for reduced motion or when turned off.
import {createContext, useContext, type CSSProperties} from 'react'

import {useAssistantAnimationState, type CharacterState} from '../assistantActivity'
import {characterById, CHARACTERS, DEFAULT_CHARACTER} from './registry'

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

// ---- the face ---------------------------------------------------------------------------------
function Face({state}: {state: CharacterState}) {
	const eyes = (() => {
		switch (state) {
			case 'sleeping':
				return (
					<g className="s-1" strokeWidth={3} strokeLinecap="round" fill="none">
						<path d="M-13 1 q4.5 3 9 0" />
						<path d="M4 1 q4.5 3 9 0" />
					</g>
				)
			case 'listening':
			case 'thinking':
				return (
					<g className={`f-1 ac-eyes${state === 'thinking' ? ' ac-look' : ''}`}>
						<ellipse cx={-8.5} cy={-1} rx={3.4} ry={4.6} />
						<ellipse cx={8.5} cy={-1} rx={3.4} ry={4.6} />
					</g>
				)
			case 'working':
				return (
					<g className="f-1 ac-eyes">
						<rect x={-13} y={-2.4} width={9} height={4} rx={2} />
						<rect x={4} y={-2.4} width={9} height={4} rx={2} />
					</g>
				)
			case 'error':
				return (
					<g>
						<g className="f-1">
							<ellipse cx={-8.5} cy={0} rx={3} ry={3.8} />
							<ellipse cx={8.5} cy={0} rx={3} ry={3.8} />
						</g>
						<g className="s-1" strokeWidth={2.2} strokeLinecap="round" fill="none">
							<path d="M-13 -8 l8 3" />
							<path d="M13 -8 l-8 3" />
						</g>
					</g>
				)
			default:
				// happy arcs, like the Omarchy logo's friendly face
				return (
					<g className="s-1 ac-eyes" strokeWidth={3.4} strokeLinecap="round" fill="none">
						<path d="M-13 2 q4.5 -8.5 9 0" />
						<path d="M4 2 q4.5 -8.5 9 0" />
					</g>
				)
		}
	})()
	const mouth = (() => {
		switch (state) {
			case 'hover':
			case 'success':
				return <path className="f-1" d="M-7 7 q7 10 14 0 z" />
			case 'responding':
				return <ellipse className="f-1 ac-talk" cx={0} cy={10} rx={4.4} ry={3} />
			case 'thinking':
				return <circle className="f-1" cx={2} cy={10} r={2.3} />
			case 'working':
			case 'sleeping':
				return <path className="s-1" d="M-4 10 h8" strokeWidth={2.6} strokeLinecap="round" fill="none" />
			case 'error':
				return <path className="s-1" d="M-6 12 q6 -5 12 0" strokeWidth={2.6} strokeLinecap="round" fill="none" />
			default:
				return <path className="s-1" d="M-6 8 q6 6 12 0" strokeWidth={2.6} strokeLinecap="round" fill="none" />
		}
	})()
	return (
		<>
			{eyes}
			{mouth}
		</>
	)
}

// Small signs around the character for some states.
function Overlay({state}: {state: CharacterState}) {
	switch (state) {
		case 'thinking':
			return (
				<g className="ac-dots f-1">
					<circle cx={84} cy={12} r={3} />
					<circle cx={92} cy={22} r={2.3} />
					<circle cx={76} cy={6} r={1.8} />
				</g>
			)
		case 'working':
			return (
				<g transform="translate(86 14)">
					<circle r={9} className="f-badge" />
					<circle r={5.2} className="s-1 ac-spin" fill="none" strokeWidth={2.4} strokeDasharray="18 40" strokeLinecap="round" />
				</g>
			)
		case 'success':
			return (
				<g transform="translate(86 14)">
					<g className="ac-pop">
						<circle r={9} className="f-1" />
						<path d="M-4 0 l3 3 l5.5 -6" className="s-badge" fill="none" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
					</g>
					<path className="f-1 ac-spark" d="M-20 -6 l1.4 3.2 l3.2 1.4 l-3.2 1.4 l-1.4 3.2 l-1.4 -3.2 l-3.2 -1.4 l3.2 -1.4 z" />
				</g>
			)
		case 'error':
			return (
				<g transform="translate(86 14)">
					<circle r={9} className="f-warn" />
					<path d="M0 -4.5 v5" className="s-badge" strokeWidth={2.6} strokeLinecap="round" />
					<circle cy={4.6} r={1.5} className="f-badge-ink" />
				</g>
			)
		case 'sleeping':
			return (
				<g className="ac-zz f-1" fontFamily="inherit" fontWeight={700}>
					<text x={78} y={18} fontSize={12}>
						z
					</text>
					<text x={88} y={9} fontSize={9}>
						z
					</text>
				</g>
			)
		default:
			return null
	}
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
	const vars = {'--ac-1': c.colors.primary, '--ac-2': c.colors.secondary, '--ac-body': c.colors.body, width: size, height: size, ...style} as CSSProperties
	return (
		<svg
			viewBox="0 0 100 100"
			className={`ac ac--${c.id} is-${state} ac-${intensity}${animate ? '' : ' still'} ${className}`}
			style={vars}
			role={label ? 'img' : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			focusable="false"
		>
			{state === 'listening' && <circle className="ac-glow" cx={50} cy={52} r={44} />}
			<g className="ac-float">
				<g className="ac-bounce">
					{c.back()}
					<g transform={`translate(${c.face.x} ${c.face.y}) scale(${c.face.scale})`}>
						<g className="ac-face">
							<Face state={state} />
						</g>
					</g>
					{c.front?.()}
				</g>
			</g>
			<Overlay state={state} />
		</svg>
	)
}

// The character where an icon was (Home tile, desktop icon), reacting like the floating one.
export function AssistantAvatar({size = 56, live = true}: {size?: number; live?: boolean}) {
	const {look} = useAssistantLook()
	const state = useAssistantAnimationState({reactions: look.reactions && live})
	return <AssistantCharacter id={look.character} state={live ? state : 'idle'} size={size} animate={look.animate && live} intensity={look.intensity} />
}
