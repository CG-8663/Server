// The assistant's characters. Purely how the assistant looks: none of this reaches the assistant's
// prompts, tools or permissions. To add a character, add one entry to CHARACTERS: a body drawn in a
// 100×100 box, where its face goes, and its colours (theme tokens, so it follows the Omarchy theme).
import type {ReactNode} from 'react'

import type {CharacterState} from '../assistantActivity'

export type CharacterDef = {
	id: string
	name: string
	/** One line under the name in the picker. */
	tagline: string
	description: string
	/** CSS colours; theme tokens so the character follows the current theme. */
	colors: {primary: string; secondary: string; body: string}
	/** 'theme': uses the theme's own tokens. 'fixed': keeps its colours on every theme. */
	theme: 'theme' | 'fixed'
	/** Where the shared face sits on the body, and how big it is. */
	face: {x: number; y: number; scale: number}
	/** States this character draws (every character shares the face; listed for contributors). */
	states: CharacterState[]
	/** The body, behind the face (`back`) and in front of it (`front`), in a 100×100 box. */
	back: () => ReactNode
	front?: () => ReactNode
}

const ALL: CharacterState[] = ['idle', 'hover', 'listening', 'thinking', 'responding', 'working', 'success', 'error', 'sleeping']

// The Omarchy mark: a square ring open at the top right, with its corner piece set apart.
export const OmarchyMark = ({x, y, size, stroke = 7}: {x: number; y: number; size: number; stroke?: number}) => {
	const s = size
	const r = s * 0.14
	const gap = s * 0.3
	return (
		<g className="s-1 ac-mark" fill="none" strokeWidth={stroke} strokeLinecap="square" strokeLinejoin="round" transform={`translate(${x} ${y})`}>
			<path d={`M${s - gap} 0 H${r} a${r} ${r} 0 0 0 -${r} ${r} V${s - r} a${r} ${r} 0 0 0 ${r} ${r} H${s - r} a${r} ${r} 0 0 0 ${r} -${r} V${gap + stroke * 0.4}`} />
			<path d={`M${s - gap + stroke * 1.15} 0 H${s} V${gap - stroke * 0.75}`} />
		</g>
	)
}

// A soft, slightly fuzzy body: a rounded square with a bumpy edge.
const Fuzzy = ({x, y, w, h, r, className}: {x: number; y: number; w: number; h: number; r: number; className: string}) => (
	<g className={className}>
		<rect x={x} y={y} width={w} height={h} rx={r} />
		<rect x={x} y={y} width={w} height={h} rx={r} fill="none" strokeWidth={4} strokeLinecap="round" strokeDasharray="0.1 3.4" className="ac-fur" />
	</g>
)

const Feet = ({y = 90, className = 'f-body'}: {y?: number; className?: string}) => (
	<g className={className}>
		<ellipse cx={38} cy={y} rx={7.5} ry={4.2} />
		<ellipse cx={62} cy={y} rx={7.5} ry={4.2} />
	</g>
)

// A small arm on each side; the right one waves (hover, success).
const Arms = ({className = 'f-body', y = 62, left = 15, right = 86}: {className?: string; y?: number; left?: number; right?: number}) => (
	<g className={className}>
		<ellipse cx={left} cy={y + 2} rx={5} ry={8} transform={`rotate(20 ${left} ${y + 2})`} />
		<g className="ac-wave">
			<ellipse cx={right} cy={y - 6} rx={5} ry={8.5} transform={`rotate(-28 ${right} ${y - 6})`} />
		</g>
	</g>
)

const FaceScreen = ({x = 33, y = 36, w = 34, h = 35, r = 5}: {x?: number; y?: number; w?: number; h?: number; r?: number}) => <rect className="f-screen" x={x} y={y} width={w} height={h} rx={r} />

export const CHARACTERS: CharacterDef[] = [
	{
		id: 'oma',
		name: 'Oma',
		tagline: 'The friendly ops assistant',
		description: 'A friendly, always-on assistant for your Omarchy Server. Helps with systems, apps, storage and more.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--green, #9ece6a)', body: '#141418'},
		theme: 'theme',
		face: {x: 50, y: 55, scale: 0.86},
		states: ALL,
		back: () => (
			<>
				<Feet />
				<Arms />
				{/* antennae */}
				<g className="s-1 ac-antennae" fill="none" strokeWidth={2.4} strokeLinecap="round">
					<path d="M38 18 q-2 -7 -6 -10" />
					<path d="M62 18 q2 -7 6 -10" />
				</g>
				<circle className="f-1" cx={31.5} cy={7.5} r={2.6} />
				<circle className="f-1" cx={68.5} cy={7.5} r={2.6} />
				<Fuzzy className="f-body s-body" x={20} y={17} w={60} h={72} r={17} />
				{/* headphones */}
				<path className="s-band" d="M19 46 Q19 10 50 10 Q81 10 81 46" fill="none" strokeWidth={6} strokeLinecap="round" />
				<FaceScreen />
				<OmarchyMark x={28} y={31} size={44} />
			</>
		),
		front: () => (
			<g className="ac-phones">
				<rect className="f-dark" x={10} y={39} width={13} height={20} rx={6} />
				<rect className="f-dark" x={77} y={39} width={13} height={20} rx={6} />
				<rect className="s-1" x={13} y={43} width={7} height={12} rx={3.5} fill="none" strokeWidth={2.2} />
				<rect className="s-1" x={80} y={43} width={7} height={12} rx={3.5} fill="none" strokeWidth={2.2} />
			</g>
		),
	},
	{
		id: 'patch',
		name: 'Patch',
		tagline: 'Your systems sidekick',
		description: 'A hands-on technician in an Omarchy cap, wrench at the ready for apps, updates and repairs.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--fg, #c0caf5)', body: '#d3d6df'},
		theme: 'theme',
		face: {x: 50, y: 57, scale: 0.84},
		states: ALL,
		back: () => (
			<>
				<Feet className="f-body" />
				<Arms className="f-body" />
				<Fuzzy className="f-body s-body" x={20} y={21} w={60} h={68} r={17} />
				<FaceScreen y={39} h={34} />
				<OmarchyMark x={28} y={34} size={44} />
				{/* cap */}
				<path className="f-dark" d="M21 34 Q21 9 50 9 Q79 9 79 34 Z" />
				<path className="f-dark" d="M60 29 h26 a4 4 0 0 1 0 8 h-26 z" />
				<OmarchyMark x={44} y={15} size={12} stroke={2.4} />
			</>
		),
		front: () => (
			// wrench in the right hand
			<g className="ac-tool">
				<path className="f-metal" d="M86 50 l3 -3 a6 6 0 1 1 6 6 l-3 3 l-11 11 a2.6 2.6 0 0 1 -3.7 -3.7 z" />
				<circle className="f-screen" cx={92.2} cy={50.6} r={2} />
			</g>
		),
	},
	{
		id: 'pixel',
		name: 'Pixel',
		tagline: 'The creative builder',
		description: 'A bright cube of translucent pixels in the shape of the Omarchy mark, always building something.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--mauve, #bb9af7)', body: 'var(--mauve, #bb9af7)'},
		theme: 'theme',
		face: {x: 50, y: 53, scale: 0.84},
		states: ALL,
		back: () => (
			<>
				<g className="ac-bits f-2">
					<rect x={8} y={20} width={6} height={6} rx={1} />
					<rect x={86} y={14} width={5} height={5} rx={1} />
					<rect x={90} y={70} width={6} height={6} rx={1} />
					<rect x={6} y={74} width={4} height={4} rx={1} />
					<rect x={80} y={4} width={4} height={4} rx={1} className="f-1" />
				</g>
				<rect className="f-body ac-glass" x={16} y={16} width={68} height={70} rx={10} />
				<g className="f-2 ac-tiles">
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<rect key={`t${i}`} x={18 + i * 11} y={18} width={9} height={9} rx={1.5} opacity={0.35 + (i % 3) * 0.2} />
					))}
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<rect key={`b${i}`} x={18 + i * 11} y={75} width={9} height={9} rx={1.5} opacity={0.3 + (i % 2) * 0.3} />
					))}
				</g>
				<FaceScreen y={34} h={36} />
				<OmarchyMark x={27} y={29} size={46} />
			</>
		),
	},
	{
		id: 'stack',
		name: 'Stack',
		tagline: 'The infrastructure pro',
		description: 'A small server stack with a big personality. Lights blink while it works.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--green, #9ece6a)', body: '#2a2b33'},
		theme: 'theme',
		face: {x: 50, y: 33, scale: 0.7},
		states: ALL,
		back: () => (
			<>
				{[0, 1].map((i) => (
					<g key={i}>
						<rect className="f-body s-edge" x={16} y={50 + i * 20} width={68} height={17} rx={4} strokeWidth={1} />
						<rect className="f-screen" x={22} y={55 + i * 20} width={30} height={3} rx={1.5} />
						<rect className="f-screen" x={22} y={60 + i * 20} width={22} height={2.4} rx={1.2} />
						<g className="f-1 ac-led">
							<rect x={66} y={55 + i * 20} width={4} height={7} rx={1} />
							<rect x={72} y={55 + i * 20} width={4} height={7} rx={1} style={{animationDelay: `${0.35 + i * 0.2}s`}} />
						</g>
					</g>
				))}
				<rect className="f-body s-edge" x={14} y={14} width={72} height={36} rx={6} strokeWidth={1} />
				<FaceScreen x={21} y={19} w={58} h={26} r={4} />
				<path className="s-1" d="M21 25 v-6 h8 M79 25 v-6 h-8 M21 39 v6 h8 M79 39 v6 h-8" fill="none" strokeWidth={2.2} strokeLinecap="square" />
			</>
		),
	},
	{
		id: 'pulse',
		name: 'Pulse',
		tagline: 'The health & monitoring buddy',
		description: 'A soft purple cloud with a steady heartbeat, keeping an eye on how your server is doing.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--mauve, #bb9af7)', body: 'var(--mauve, #bb9af7)'},
		theme: 'theme',
		face: {x: 50, y: 50, scale: 0.8},
		states: ALL,
		back: () => (
			<>
				<ellipse className="s-2 ac-orbit" cx={50} cy={58} rx={46} ry={12} fill="none" strokeWidth={1.8} transform="rotate(-14 50 58)" opacity={0.7} />
				<g className="f-body ac-cloud">
					<circle cx={30} cy={52} r={18} />
					<circle cx={50} cy={38} r={22} />
					<circle cx={70} cy={52} r={18} />
					<rect x={18} y={48} width={64} height={30} rx={15} />
				</g>
				<FaceScreen x={34} y={34} w={32} h={30} r={8} />
			</>
		),
		front: () => <path className="s-1 ac-beat" d="M14 72 H34 l4 -8 l5 15 l5 -20 l5 18 l3 -5 H86" fill="none" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />,
	},
	{
		id: 'orbit',
		name: 'Orbit',
		tagline: 'Your exploration companion',
		description: 'A tiny astronaut in an Omarchy-style helmet, ready to explore your apps and machines.',
		colors: {primary: 'var(--green, #9ece6a)', secondary: 'var(--fg, #c0caf5)', body: '#e9ebf1'},
		theme: 'theme',
		face: {x: 50, y: 41, scale: 0.78},
		states: ALL,
		back: () => (
			<>
				<Feet y={92} className="f-body" />
				<Arms className="f-body s-edge" y={76} left={28} right={73} />
				<rect className="f-body s-edge" x={31} y={62} width={38} height={30} rx={11} strokeWidth={1} />
				<OmarchyMark x={44} y={70} size={12} stroke={2.4} />
				{/* antenna */}
				<path className="s-edge" d="M30 22 L20 8" strokeWidth={2.4} strokeLinecap="round" fill="none" />
				<circle className="f-1 ac-beacon" cx={19} cy={7} r={3.2} />
				<circle className="f-body s-edge" cx={50} cy={40} r={28} strokeWidth={1} />
				<rect className="f-body s-edge" x={17} y={34} width={7} height={13} rx={3.5} strokeWidth={1} />
				<rect className="f-body s-edge" x={76} y={34} width={7} height={13} rx={3.5} strokeWidth={1} />
				<rect className="f-screen" x={30} y={24} width={40} height={33} rx={13} />
				<rect className="s-1" x={30} y={24} width={40} height={33} rx={13} fill="none" strokeWidth={2} opacity={0.6} />
			</>
		),
	},
]

export const DEFAULT_CHARACTER = 'oma'
export const characterById = (id: string | null | undefined) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]
