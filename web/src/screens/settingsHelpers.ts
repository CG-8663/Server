// Pure helpers and constants for Settings sheets.
export const PASSWORD_SHEET_SUBTITLE = 'Used to sign in'

// The server (omarchyd/accounts.mjs setPassword) refuses anything shorter.
export const MIN_PASSWORD_LENGTH = 8

// A refusal from system.update that the server sent back (not a dropped connection): its message to show, or null to keep waiting.
export function updateStartFailure(e: unknown): string | null {
	const err = e as {message?: unknown; status?: unknown; code?: unknown} | null
	if (!err || typeof err.status !== 'number' || err.status <= 0) return null
	// omarchyd restarting mid-update reaches us as UNREACHABLE (or a timeout): that is the update working, not a refusal.
	if (err.code === 'UNREACHABLE' || err.code === 'TIMEOUT') return null
	return typeof err.message === 'string' && err.message ? err.message : 'The update did not start'
}
