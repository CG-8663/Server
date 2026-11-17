import {useState} from 'react'

import {useToast} from '../../ui'
import {SNIPPET} from './grab'

export function Onboarding({onDismiss}: {onDismiss: () => void}) {
	const toast = useToast()
	const [flash, setFlash] = useState(false)
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(SNIPPET)
			toast('Copied. Paste into ~/.config/hypr/bindings.lua, then Super+K or hyprctl reload.')
		} catch {
			toast('Select the snippet and copy it')
		}
	}
	return (
		<div className="hypr-onboard">
			<h2>Hyprland keys</h2>
			<p>On an Omarchy computer, Super is taken by the desktop. Paste this into <code>~/.config/hypr/bindings.lua</code>, reload Hyprland, then press Scroll Lock (or Super+F12) so Super stays in this browser.</p>
			<pre className={flash ? 'flash' : ''} tabIndex={0}>
				{SNIPPET}
			</pre>
			<p>On https:// in Chrome, Edge or Brave, the lock chip on the bar can take Super without that snippet (full screen).</p>
			<div className="hypr-onboard-actions">
				<button className="btn" onClick={copy}>
					Copy snippet
				</button>
				<button
					className="btn"
					onClick={() => {
						const on = (e: KeyboardEvent) => {
							if (e.code !== 'ScrollLock') return
							setFlash(true)
							window.setTimeout(() => setFlash(false), 600)
						}
						window.addEventListener('keydown', on)
						window.setTimeout(() => window.removeEventListener('keydown', on), 8000)
						toast('Press Scroll Lock')
					}}
				>
					Test Scroll Lock
				</button>
				<button className="btn primary" onClick={onDismiss}>
					Got it
				</button>
			</div>
		</div>
	)
}
