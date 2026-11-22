// Layout choices as large cards with a small drawing of each, used in the welcome setup,
// Settings › Appearance and the desktop's Appearance window. Layouts change the whole screen,
// so they're shown bigger than themes.
import type {ReactNode} from 'react'

import type {LayoutPref} from './ui'
import {haptic} from './ui'

function ArtDesktop() {
	return (
		<span className="lp-art lp-art-desktop" aria-hidden="true">
			<i className="lp-win" />
			<i className="lp-win lp-win-2" />
			<i className="lp-dock" />
		</span>
	)
}
function ArtPhone() {
	return (
		<span className="lp-art lp-art-phone" aria-hidden="true">
			<i className="lp-phone">
				<i className="lp-tiles" />
				<i className="lp-tabbar" />
			</i>
		</span>
	)
}
function ArtAuto() {
	return (
		<span className="lp-art lp-art-auto" aria-hidden="true">
			<i className="lp-mini-desk" />
			<i className="lp-mini-phone" />
		</span>
	)
}
function ArtHyprland() {
	return (
		<span className="lp-art lp-art-tiles" aria-hidden="true">
			<i className="lp-bar" />
			<i className="lp-tile lp-tile-a" />
			<i className="lp-tile lp-tile-b" />
			<i className="lp-tile lp-tile-c" />
		</span>
	)
}

function Card({on, suits, art, title, body, onClick}: {on: boolean; suits?: boolean; art: ReactNode; title: string; body: string; onClick: () => void}) {
	return (
		<button type="button" role="radio" aria-checked={on} className={`lp-card${on ? ' on' : ''}`} onClick={onClick}>
			{art}
			<span className="lp-text">
				<b>
					{title}
					{suits && <em className="lp-badge">Suits this screen</em>}
				</b>
				<span>{body}</span>
			</span>
		</button>
	)
}

/** How this device shows Omarchy Server: Automatic, Desktop, or Phone & tablet. */
export function ScreenLayoutCards({value, detected, onPick, label = 'Screen layout'}: {value: LayoutPref | null; detected: boolean; onPick: (p: LayoutPref) => void; label?: string}) {
	const pick = (p: LayoutPref) => {
		haptic(6)
		onPick(p)
	}
	return (
		<div className="lp-cards" role="radiogroup" aria-label={label}>
			<Card on={value === 'desktop'} suits={detected} art={<ArtDesktop />} title="Desktop" body="Windows, a dock and Activities, like a computer. Best with a mouse or trackpad." onClick={() => pick('desktop')} />
			<Card on={value === 'phone'} suits={!detected} art={<ArtPhone />} title="Phone & tablet" body="Big touch targets and a bar along the bottom. Best for touch." onClick={() => pick('phone')} />
			<Card on={value === 'auto'} art={<ArtAuto />} title="Automatic" body={`Desktop on a big screen with a mouse, Phone otherwise. Here: ${detected ? 'Desktop' : 'Phone & tablet'}.`} onClick={() => pick('auto')} />
		</div>
	)
}

/** The desktop's own style: floating windows (Ubuntu) or tiles (Hyprland). */
export function DesktopStyleCards<T extends string>({value, onPick, floating, tiling}: {value: T; onPick: (v: T) => void; floating: T; tiling: T}) {
	const pick = (v: T) => {
		haptic(6)
		onPick(v)
	}
	return (
		<div className="lp-cards lp-cards-2" role="radiogroup" aria-label="Desktop style">
			<Card on={value === floating} art={<ArtDesktop />} title="Ubuntu" body="Floating windows with a dock and Activities." onClick={() => pick(floating)} />
			<Card on={value === tiling} art={<ArtHyprland />} title="Hyprland" body="Tiled windows, workspaces 1–9 and Omarchy’s Super shortcuts." onClick={() => pick(tiling)} />
		</div>
	)
}
