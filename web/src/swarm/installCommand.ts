// The command a guest pastes. A GitHub install is a raw URL. A copy installed from a
// directory on this computer is not: curl rejects it with "No host present". That guest
// downloads the connector from this server instead.
const HTTPS_BASE = /^https:\/\/[^/?#\s]+/i

export function connectorInstallCommand({
	source,
	server,
	ca,
	token,
	allow,
}: {
	source: string
	server: string
	ca: string
	token: string
	allow: string
}): {command: string; uninstall: string} {
	const given = source.trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = server.replace(/\/+$/, '')
	const src = remote ? given : `${origin}/api/connector`
	const script = remote ? `${src}/main/connector/install.sh` : `${src}/install.sh`
	const curl = remote ? 'curl -fsSL' : 'curl -fsSLk'
	const list = allow ? ` --allow ${allow}` : ''
	return {
		command: `${curl} ${script} | bash -s -- --server ${server} --ca ${ca} --token ${token}${list} --source ${src}`,
		uninstall: `${curl} ${script} | bash -s -- --uninstall`,
	}
}
