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

export type {FileEntry}
