// How a guest reaches this server, and which connector that guest can run.
// Pairing still lives in connector.mjs; this file stays free of I/O so tests stay cheap.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const HTTPS_BASE = /^https:\/\/[^/?#\s]+/i

export const GUEST_PAIR_TTL = 6 * 60 * 60_000
export const LINUX_CONNECTOR_ALLOW = ['terminal', 'desktop', 'manage', 'files']
export const WINDOWS_CONNECTOR_ALLOW = ['terminal', 'files', 'manage']

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

export function connectorCloudInit(img = {}) {
	const python = img.familyId === 'arch' ? 'python' : 'python3'
	const given = img.cloudInit && typeof img.cloudInit === 'object' ? img.cloudInit : {}
	const packages = ['qemu-guest-agent', python, ...(Array.isArray(given.packages) ? given.packages : [])]
	const commands = [['systemctl', 'enable', '--now', 'qemu-guest-agent'], ...(Array.isArray(given.commands) ? given.commands : [])]
	return {...given, packages, commands}
}

export function defaultConnectorAbilities(os) {
	const keys = os === 'windows' ? WINDOWS_CONNECTOR_ALLOW : LINUX_CONNECTOR_ALLOW
	return Object.fromEntries(keys.map((k) => [k, true]))
}

export function connectorAllowList(os, abilities = {}) {
	const keys = os === 'windows' ? WINDOWS_CONNECTOR_ALLOW : LINUX_CONNECTOR_ALLOW
	return keys.filter((k) => abilities[k] === true).join(',')
}

export function connectorInstallCommand({source, server, ca, token, allow}) {
	const given = String(source ?? '').trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = String(server ?? '').replace(/\/+$/, '')
	const src = remote ? given : `${origin}/api/connector`
	const script = remote ? `${src}/main/connector/install.sh` : `${src}/install.sh`
	const curl = remote ? 'curl -fsSL' : 'curl -fsSLk'
	const list = allow ? ` --allow ${allow}` : ''
	return `${curl} ${script} | bash -s -- --server ${server} --ca ${ca} --token ${token}${list} --source ${src}`
}

export function connectorInstallCommandWindows({source, server, ca, token, allow}) {
	const given = String(source ?? '').trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = String(server ?? '').replace(/\/+$/, '')
	const src = remote ? given : `${origin}/api/connector`
	const script = remote ? `${src}/main/connector/install.ps1` : `${src}/install.ps1`
	const fetch = remote
		? `$s = irm '${script}'`
		: `$s = if ($PSVersionTable.PSVersion.Major -ge 6) { irm -SkipCertificateCheck '${script}' } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}; try { irm '${script}' } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback = $null } }`
	const list = allow ? ` -Allow '${allow}'` : ''
	return `${fetch}; & ([scriptblock]::Create($s)) -Server '${server}' -Ca '${ca}' -Token '${token}'${list} -Source '${src}'`
}

export function guestConnectorExec({os, username, source, server, ca, token, allow}) {
	if (os === 'windows') return {path: 'powershell.exe', args: ['-NoProfile', '-Command', connectorInstallCommandWindows({source, server, ca, token, allow})]}
	return {path: 'runuser', args: ['-u', username, '--', 'bash', '-lc', connectorInstallCommand({source, server, ca, token, allow})]}
}
