// Theme dropdown on a swarm computer. A connector packet (metrics, lastSeen) must not count as a
// change: re-rendering the <select> closes it in the browser.
export type ThemePickerState = {themes: readonly string[]; theme: string; disabled: boolean}

export function sameThemePicker(a: ThemePickerState, b: ThemePickerState): boolean {
	return a.disabled === b.disabled && a.theme === b.theme && sameStringList(a.themes, b.themes)
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i])
}
