import type {FileEntry} from './api'

/** Check whether a file or folder name is non-empty and free of path separators or dots-only segments. */
export function isValidItemName(name: string): boolean {
	const trimmed = name.trim()
	return trimmed !== '' && !trimmed.includes('/') && trimmed !== '.' && trimmed !== '..'
}

/** Return true when the name prompt form can submit (only rename requires a changed name). */
export function canSubmitNamePrompt({
	name,
	initial,
	requireChange,
	busy,
}: {
	name: string
	initial: string
	requireChange?: boolean
	busy: boolean
}): boolean {
	if (busy || !isValidItemName(name)) return false
	if (requireChange && name.trim() === initial) return false
	return true
}

export type FavoriteItem = FileEntry | string

/** Extract the virtual path from either a FileEntry or a legacy favorite path string. */
export function favoritePath(item: FavoriteItem): string {
	return typeof item === 'string' ? item : item.path
}

/** Activate a file row only when Enter is pressed directly on the row, not a child action button. */
export function shouldActivateRowOnKey(e: {key: string; target: unknown; currentTarget: unknown}): boolean {
	return e.key === 'Enter' && e.target === e.currentTarget
}

export type {FileEntry}
