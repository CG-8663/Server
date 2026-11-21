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

/** Label for the share password row across idle, loading, loaded, and failed states. */
export function sharePasswordLabel({
	data,
	isFetching,
	error,
}: {
	data: string | undefined
	isFetching: boolean
	error: Error | null | undefined
}): string {
	if (data) return data
	if (isFetching) return '…'
	if (error) return `${error.message || 'Couldn’t load password'} · Tap to retry`
	return 'Tap to show'
}

/** Decide what tapping the share password row should do next. */
export function sharePasswordAction({
	data,
	reveal,
	isFetching,
}: {
	data: string | undefined
	reveal: boolean
	isFetching?: boolean
}): 'copy' | 'noop' | 'refetch' | 'reveal' {
	if (data) return 'copy'
	if (isFetching) return 'noop'
	return reveal ? 'refetch' : 'reveal'
}

/** Query keys invalidated once an upload batch finishes so both listings and Recents update. */
export const UPLOAD_REFRESH_KEYS = [['files.list'], ['files.recents']] as const

const COPY_SUFFIX_RE = / \(([2-9]|[1-9]\d+)\)$/

/** Remove a keep-both "(2)" suffix from a filename so collision copies still match originals. */
export function stripCopySuffix(name: string): string {
	if (COPY_SUFFIX_RE.test(name)) return name.replace(COPY_SUFFIX_RE, '')
	const dot = name.lastIndexOf('.')
	if (dot <= 0) return name
	return name.slice(0, dot).replace(COPY_SUFFIX_RE, '') + name.slice(dot)
}

/** Return picked photos whose name (or keep-both base name) and size are not already in Photos. */
export function filterUnsyncedPhotos<T extends {name: string; size: number}>(picked: T[], existing: FileEntry[]): T[] {
	const have = new Set<string>()
	for (const f of existing) {
		if (f.type === 'directory') continue
		have.add(`${f.name}:${f.size}`)
		have.add(`${stripCopySuffix(f.name)}:${f.size}`)
	}
	return picked.filter((f) => !have.has(`${f.name}:${f.size}`) && !have.has(`${stripCopySuffix(f.name)}:${f.size}`))
}

export type {FileEntry}
