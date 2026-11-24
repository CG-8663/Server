// How a guest reaches this server, and which connector that guest can run.
// Pairing still lives in connector.mjs; this file stays free of I/O so tests stay cheap.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const HTTPS_BASE = /^https:\/\/[^/?#\s]+/i

export const GUEST_PAIR_TTL = 6 * 60 * 60_000
export const LINUX_CONNECTOR_ALLOW = ['terminal', 'desktop', 'manage', 'files']

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
	// The connector runs on Linux with systemd. Windows, macOS, and Home Assistant do not run it.
	if (/win|macos|osx|darwin|haos|home-?assistant|alpine/.test(id)) return 'unsupported'
	return 'linux'
}

export function connectorCloudInit(img = {}) {
	const python = img.familyId === 'arch' ? 'python' : 'python3'
	const given = img.cloudInit && typeof img.cloudInit === 'object' ? img.cloudInit : {}
	const packages = ['qemu-guest-agent', python, ...(Array.isArray(given.packages) ? given.packages : [])]
	const commands = [['systemctl', 'enable', '--now', 'qemu-guest-agent'], ...(Array.isArray(given.commands) ? given.commands : [])]
	const username = String(img.username ?? '').trim()
	if (username) commands.splice(1, 0, ['loginctl', 'enable-linger', username])
	return {...given, packages, commands}
}

// qemu-ga is root. Linger is argv, not a shell. Python is installed only when neither name is on PATH.
const PYTHON_IF_MISSING = [
	'if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then exit 0; fi',
	'if command -v apt-get >/dev/null 2>&1; then apt-get install -y python3',
	'elif command -v dnf >/dev/null 2>&1; then dnf install -y python3',
	'elif command -v pacman >/dev/null 2>&1; then pacman -S --needed --noconfirm python',
	'elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install python3',
	'else exit 1; fi',
].join('; ')

export function guestConnectorPrep({username} = {}) {
	return [
		{path: 'loginctl', args: ['enable-linger', String(username ?? '')]},
		{path: 'bash', args: ['-lc', PYTHON_IF_MISSING]},
	]
}

export function defaultConnectorAbilities(os) {
	if (os !== 'linux') return {}
	return Object.fromEntries(LINUX_CONNECTOR_ALLOW.map((k) => [k, true]))
}

export function connectorAllowList(os, abilities = {}) {
	if (os !== 'linux') return ''
	return LINUX_CONNECTOR_ALLOW.filter((k) => abilities[k] === true).join(',')
}

const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function installParts({source, server, ca, token, allow}) {
	const given = String(source ?? '').trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = String(server ?? '').replace(/\/+$/, '')
	if (!/^https:\/\/[A-Za-z0-9._:-]+$/.test(origin) && !/^https:\/\/\[[0-9a-f:.]+\](?::[0-9]{1,5})?$/i.test(origin)) throw new Error('The server address has to be https')
	if (!/^[a-f0-9]{64}$/.test(String(ca ?? ''))) throw new Error('The certificate fingerprint is not valid')
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(token ?? ''))) throw new Error('The pairing code is not valid')
	const allowList = String(allow ?? '')
	if (allowList && !/^(?:terminal|desktop|manage|files|storage|backup|services|vms)(?:,(?:terminal|desktop|manage|files|storage|backup|services|vms))*$/.test(allowList)) throw new Error('The permission list is not valid')
	const src = remote ? given : `${origin}/api/connector`
	if (!HTTPS_BASE.test(src) && src !== `${origin}/api/connector`) throw new Error('The download address has to be https')
	const script = remote ? `${src}/main/connector/install.sh` : `${src}/install.sh`
	const args = `--server ${sh(origin)} --ca ${sh(ca)} --token ${sh(token)}${allowList ? ` --allow ${sh(allowList)}` : ''} --source ${sh(src)}`
	return {remote, script, args}
}

// A public catalog is fetched with the system trust store. This server's own copy is fetched
// with this server's certificate on stdin, never with verification turned off.
export function connectorInstallCommand({source, server, ca, token, allow, caPem}) {
	const {remote, script, args} = installParts({source, server, ca, token, allow})
	if (remote) return {command: `curl -fsSL --max-time 60 ${sh(script)} | bash -s -- ${args}`, input: undefined}
	if (typeof caPem !== 'string' || !caPem.includes('BEGIN CERTIFICATE')) throw new Error('This server’s certificate is required')
	const command = [`d=$(mktemp -d)`, `trap 'rm -rf "$d"' EXIT`, `cat > "$d/ca.crt"`, `curl -fsSL --cacert "$d/ca.crt" --max-time 60 ${sh(script)} | bash -s -- ${args}`].join('; ')
	return {command, input: caPem}
}

export function guestConnectorExec({os, username, source, server, ca, token, allow, caPem}) {
	if (os !== 'linux') throw new Error('This operating system can’t run the connector.')
	if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(username ?? '')) || username === 'root') throw new Error('Use a lower-case username')
	const built = connectorInstallCommand({source, server, ca, token, allow, caPem})
	const exec = {path: 'runuser', args: ['-u', username, '--', 'bash', '-lc', `${built.command} --user-enroll-only`]}
	if (built.input) exec.input = built.input
	return exec
}
