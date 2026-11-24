// How a guest reaches this server, and which connector that guest can run.
// Pairing still lives in connector.mjs; this file stays free of I/O so tests stay cheap.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export const GUEST_PAIR_TTL = 6 * 60 * 60_000

export function guestReachableUrl({addresses = [], port} = {}) {
	const n = Number(port)
	if (!Number.isInteger(n) || n < 1 || n > 65535) return ''
	const rows = (Array.isArray(addresses) ? addresses : []).filter((row) => {
		const address = String(row?.address ?? '').trim()
		return address && !LOOPBACK.has(address.toLowerCase())
	})
	const lan = rows.find((row) => !row.tailscale)
	const chosen = lan ?? rows[0]
	if (!chosen) return ''
	const host = String(chosen.address)
	const v6 = host.includes(':')
	return `https://${v6 ? `[${host}]` : host}:${n}`
}

export function connectorKind(osId = '') {
	const id = String(osId).toLowerCase()
	if (/win/.test(id)) return 'windows'
	if (/macos|osx|darwin|haos|home-?assistant|alpine/.test(id)) return 'unsupported'
	return 'linux'
}
