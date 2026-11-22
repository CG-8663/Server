// Files places for joined computers. The path is not a server folder: files.list must not see it.
// Offline computers, and computers that have not granted Files, are left out.

export const COMPUTER_PLACE = '::computer/'

/** This server's own places (Home, Photos, Trash). Not a filesystem path. */
export const SERVER_FILES = '::server'

export type ComputerFileInput = {
	id: string
	name: string
	online: boolean
	filesGranted: boolean
}

function safeComputerId(id: string): boolean {
	return !!id && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\')
}

function safeRel(rel: string): boolean {
	return !rel.split('/').some((part) => part === '..' || part === '.' || part.includes('\\'))
}

export function computerPlacePath(id: string, rel = ''): string | null {
	if (!safeComputerId(id)) return null
	const clean = rel.replace(/^\/+|\/+$/g, '')
	if (clean && !safeRel(clean)) return null
	return clean ? `${COMPUTER_PLACE}${id}/${clean}` : `${COMPUTER_PLACE}${id}`
}

export function parseComputerPlace(path: string): {id: string; rel: string} | null {
	if (!path.startsWith(COMPUTER_PLACE)) return null
	const rest = path.slice(COMPUTER_PLACE.length)
	const slash = rest.indexOf('/')
	const id = slash < 0 ? rest : rest.slice(0, slash)
	const rel = slash < 0 ? '' : rest.slice(slash + 1)
	if (!safeComputerId(id) || !safeRel(rel)) return null
	return {id, rel}
}

/**
 * Parent in the Files manager.
 * Null is the machine list. A shallow server folder returns to this server's places.
 * A computer's own root returns to the machine list.
 */
export function filesParent(path: string): string | null {
	if (parseComputerPlace(path)) return computerParent(path)
	if (path === SERVER_FILES) return null
	if (path.startsWith('::')) return SERVER_FILES
	const parts = path.split('/').filter(Boolean)
	if (parts.length <= 1) return SERVER_FILES
	parts.pop()
	return `/${parts.join('/')}`
}

/** A file manager locked to one machine. The global manager has no scope. */
export type FilesScope = {kind: 'server'} | {kind: 'computer'; id: string; name: string}

export function scopeRoot(scope: FilesScope): string | null {
	if (scope.kind === 'server') return SERVER_FILES
	return computerPlacePath(scope.id)
}

/** Keep navigation inside one machine. A path outside that machine becomes its root. */
export function withinScope(scope: FilesScope | undefined, path: string | null): string | null {
	if (!scope) return path
	const root = scopeRoot(scope)
	if (!root) return path
	if (scope.kind === 'server') {
		if (path == null || parseComputerPlace(path)) return root
		return path
	}
	const here = path ? parseComputerPlace(path) : null
	if (!here || here.id !== scope.id) return root
	return path
}

/** Parent path inside a computer place. Null means the Files root (the place list). */
export function computerParent(path: string): string | null {
	const here = parseComputerPlace(path)
	if (!here) return null
	if (!here.rel) return null
	const parts = here.rel.split('/').filter(Boolean)
	parts.pop()
	return computerPlacePath(here.id, parts.join('/'))
}

export function filePlaces(computers: readonly ComputerFileInput[]): {places: {id: string; name: string; path: string}[]} {
	const places = computers
		.filter((row) => row.online && row.filesGranted)
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((row) => {
			const path = computerPlacePath(row.id)
			return path ? [{id: row.id, name: row.name, path}] : []
		})
	return {places}
}
