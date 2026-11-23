// WCAG contrast helpers for choosing a legible foreground (--on-accent) over resolved accent fills.
export type Rgb = [number, number, number]

export function parseRgbColor(css: string | null | undefined): Rgb | null {
	if (!css) return null
	const s = css.trim().toLowerCase()
	const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
	if (hex) {
		const h = hex[1]
		if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
	}
	if (s.startsWith('color(')) {
		const clean = s.replace(/color\([^)\s]+/, '')
		const m = clean.match(/[\d.]+/g)
		if (!m || m.length < 3) return null
		return [Math.round(parseFloat(m[0]) * 255), Math.round(parseFloat(m[1]) * 255), Math.round(parseFloat(m[2]) * 255)]
	}
	if (s.startsWith('rgb')) {
		const m = s.match(/[\d.]+/g)
		if (!m || m.length < 3) return null
		return [Math.round(parseFloat(m[0])), Math.round(parseFloat(m[1])), Math.round(parseFloat(m[2]))]
	}
	return null
}

function relativeLuminance([r, g, b]: Rgb): number {
	const lin = (c: number) => {
		const v = Math.max(0, Math.min(255, c)) / 255
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a)
	const lb = relativeLuminance(b)
	const hi = Math.max(la, lb)
	const lo = Math.min(la, lb)
	return (hi + 0.05) / (lo + 0.05)
}

const WHITE: Rgb = [255, 255, 255]
const DARK: Rgb = [17, 17, 17]

export function pickOnAccent(fillCss: string | null | undefined, fallback: '#fff' | '#111' = '#fff', preferred?: string | null): string {
	const fill = parseRgbColor(fillCss)
	if (!fill) return fallback
	if (preferred) {
		const pref = parseRgbColor(preferred)
		if (pref && contrastRatio(fill, pref) >= 4.5) return preferred
	}
	return contrastRatio(fill, WHITE) >= contrastRatio(fill, DARK) ? '#fff' : '#111'
}

export function resolveCssColor(root: HTMLElement, cssValue: string): string | null {
	const direct = parseRgbColor(cssValue)
	if (direct) return cssValue
	if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null
	const probe = document.createElement('span')
	probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;background-color:${cssValue}`
	root.appendChild(probe)
	const resolved = getComputedStyle(probe).backgroundColor
	probe.remove()
	return resolved || null
}
