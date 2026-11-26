import {Icon} from './icons'
import {applyPrefsUpdate} from './photoPrefs'
import {RADIO_SELECTOR, rovingKeyDown, rovingTabIndex} from './roving'
import {themeModeOf, withThemeMode, type ThemeMode} from './theme/themeMode'
import {haptic, type Prefs, type ThemeId} from './ui'

const MODES: {id: ThemeMode; label: string; icon: 'sun' | 'moon' | 'theme-off'}[] = [
	{id: 'sun', label: 'Sun', icon: 'sun'},
	{id: 'moon', label: 'Moon', icon: 'moon'},
	{id: 'off', label: 'Off', icon: 'theme-off'},
]

/** Sun, Moon, and Off in the top bar. Sun and Moon use the palettes marked in Appearance. Off uses the last of Horizon, Your photo, and Omarchy. */
export function ThemeModeSwitch({prefs, setPrefs, onTheme}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onTheme?: (id: ThemeId) => void}) {
	const mode = themeModeOf(prefs.theme)
	const choose = (next: ThemeMode) => {
		haptic(6)
		const theme = next === 'sun' ? prefs.lightTheme : next === 'moon' ? prefs.darkTheme : prefs.pictureTheme
		applyPrefsUpdate(setPrefs, (latest) => withThemeMode(latest, next))
		onTheme?.(theme)
	}
	return (
		<div className="theme-mode" role="radiogroup" aria-label="Light, dark, or off" onKeyDown={(e) => rovingKeyDown(e, RADIO_SELECTOR)}>
			{MODES.map((item, i) => (
				<button
					key={item.id}
					type="button"
					className="theme-mode-btn"
					role="radio"
					aria-checked={mode === item.id}
					aria-label={item.label}
					title={item.label}
					tabIndex={rovingTabIndex(mode === item.id, i, true)}
					onClick={() => choose(item.id)}
				>
					<Icon name={item.icon} size={16} />
				</button>
			))}
		</div>
	)
}
