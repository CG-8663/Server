// The sun, moon, and off control sits in both top bars, and the three picture cards share one size.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the phone top bar and the desktop top bar offer Sun, Moon, and Off', () => {
	const app = read('web/src/App.tsx')
	const header = app.slice(app.indexOf('<header className="topbar">'), app.indexOf('</header>', app.indexOf('<header className="topbar">')))
	assert.match(header, /<ThemeModeSwitch prefs=\{prefs\} setPrefs=\{setPrefs\} \/>/)
	const desk = read('web/src/desktop/Desktop.tsx')
	const bar = desk.slice(desk.indexOf('<div className="top-right">'), desk.indexOf('{p.lockChip}'))
	assert.match(bar, /<ThemeModeSwitch prefs=\{p\.prefs\} setPrefs=\{p\.setPrefs\} onTheme=\{p\.onTheme\} \/>/)
	const control = read('web/src/ThemeModeSwitch.tsx')
	assert.match(control, /label: 'Sun'/)
	assert.match(control, /label: 'Moon'/)
	assert.match(control, /label: 'Off'/)
	assert.match(control, /withThemeMode\(/)
})

test('Horizon, Your photo, and Omarchy use one card height', () => {
	const chooser = read('web/src/ThemeChooser.tsx')
	assert.doesNotMatch(chooser, /minHeight/)
	const css = read('web/src/styles.css')
	const picture = css.slice(css.indexOf('.theme-picture {'), css.indexOf('.theme-rule {'))
	assert.match(picture, /\.theme-picture \.theme-card \{[^}]*min-height: 104px/s)
})
