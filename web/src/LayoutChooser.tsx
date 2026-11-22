// Asked once per device, at its first sign-in: Desktop or Phone & tablet. The one that suits this
// screen is marked; Automatic is there too. Changeable any time in Settings → Layout.
import {createPortal} from 'react-dom'
import {useState} from 'react'

import {Icon} from './icons'
import {detectDesktop, haptic, setLayoutPref, type LayoutPref} from './ui'

export function LayoutChooser({onDone}: {onDone: () => void}) {
	const [suits] = useState(() => (detectDesktop() ? 'desktop' : 'phone'))
	const pick = (p: LayoutPref) => {
		haptic(8)
		setLayoutPref(p)
		onDone()
	}
	const Option = ({id, icon, title, body}: {id: 'desktop' | 'phone'; icon: 'window' | 'phone'; title: string; body: string}) => (
		<button type="button" className={`layout-option${suits === id ? ' suits' : ''}`} onClick={() => pick(id)}>
			{suits === id && <span className="layout-badge">Recommended for this screen</span>}
			<span className="layout-art" aria-hidden="true">
				<Icon name={icon} size={40} stroke={1.6} />
			</span>
			<b>{title}</b>
			<span>{body}</span>
		</button>
	)
	return createPortal(
		<div className="layout-chooser" role="dialog" aria-modal="true" aria-labelledby="layout-title">
			<div className="layout-card glass">
				<h2 id="layout-title">How do you want to use My Own Data Center on this device?</h2>
				<p>You can change this any time in Settings → Layout. It’s saved on this device only.</p>
				<div className="layout-options">
					<Option id="desktop" icon="window" title="Desktop" body="Windows, a dock and Activities, like a computer. Best with a mouse or trackpad." />
					<Option id="phone" icon="phone" title="Phone & tablet" body="Big touch targets and a bar along the bottom. Best for touch." />
				</div>
				<button type="button" className="layout-auto" onClick={() => pick('auto')}>
					Decide automatically
				</button>
			</div>
		</div>,
		document.body,
	)
}
