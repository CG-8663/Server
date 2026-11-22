import {Icon} from '../icons'
import {haptic} from '../ui'

/** Terminal and Open desktop, shared by this server, a joined computer, and a guest. */
export function MachineActions({terminal, desktop, onTerminal, onDesktop}: {terminal: boolean; desktop: boolean; onTerminal: () => void; onDesktop: () => void}) {
	return (
		<div className="primary-row">
			<button type="button" className="btn primary" disabled={!terminal} onClick={() => (haptic(8), onTerminal())}>
				<Icon name="terminal" size={20} /> Terminal
			</button>
			<button type="button" className="btn" disabled={!desktop} onClick={() => (haptic(8), onDesktop())}>
				<Icon name="devices" size={20} /> Open desktop
			</button>
		</div>
	)
}
