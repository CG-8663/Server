// Theme contrast and light-theme leak regressions (Latte & light Omarchy palettes).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')

test('Omarchy theme does not force a dark window background and keeps its title bar opaque', () => {
	assert.doesNotMatch(CSS, /\[data-theme='omarchy'\] \.win \{ background: #1a1b26/)
	assert.match(CSS, /\[data-theme='omarchy'\] \.win-bar \{ background: color-mix\(in srgb, var\(--bg-solid\) 96%, var\(--fg\) 4%\); \}/)
})

test('File viewer .fv pins dark surface tokens so Latte text stays readable', () => {
	const fv = CSS.match(/\n\.fv \{[^}]*\}/)?.[0]
	assert.ok(fv, '.fv rule not found')
	assert.match(fv, /--fg:\s*#fff;/)
	assert.match(fv, /color-scheme:\s*dark;/)
})

test('Dark-chrome overlays (.console-bar, .term-paste, .desk-hint-close) pin light ink', () => {
	const cb = CSS.match(/\n\.console-bar \{[^}]*\}/)?.[0]
	assert.ok(cb && /color:\s*#fff;/.test(cb), '.console-bar must set color: #fff')
	assert.match(CSS, /\.term-paste-actions \.btn:not\(\.primary\) \{[^}]*color:\s*#fff;/)
	const dhc = CSS.match(/\n\.desk-hint-close \{[^}]*\}/)?.[0]
	assert.ok(dhc && /color:\s*#fff;/.test(dhc), '.desk-hint-close must set color: #fff')
})

test('accent fills use --on-accent instead of hard-coded #fff', () => {
	const today = CSS.match(/\n\.cal-day\.today \{[^}]*\}/)?.[0]
	assert.ok(today && /color:\s*var\(--on-accent/.test(today))
	const chip = CSS.match(/\n\.swarm-steps \.chip\.on \{[^}]*\}/)?.[0]
	assert.ok(chip && /color:\s*var\(--on-accent/.test(chip))
})
