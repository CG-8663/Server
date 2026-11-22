// Helpers for Hyprland launcher keyboard navigation and keeping the active item scrolled in view.
export type ScrollableList = {children: ArrayLike<{scrollIntoView?: (options?: ScrollIntoViewOptions) => void}>} | null | undefined

export function launcherRowMatches(label: string, query: string): boolean {
	const q = query.trim().toLowerCase()
	return q === '' || label.toLowerCase().includes(q)
}

export function stepLauncherSelection(current: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
	if (count <= 0) return 0
	const clamped = Math.max(0, Math.min(count - 1, current))
	return key === 'ArrowDown' ? Math.min(count - 1, clamped + 1) : Math.max(0, clamped - 1)
}

export function scrollSelectedRow(list: ScrollableList, index: number, count: number): boolean {
	if (!list || count <= 0) return false
	const clamped = Math.max(0, Math.min(count - 1, index))
	const row = list.children[clamped]
	if (!row?.scrollIntoView) return false
	row.scrollIntoView({block: 'nearest'})
	return true
}
