#!/usr/bin/env node
// omarchy-server [--backend <address>] [--port 7780] [--host 0.0.0.0] [--data <dir>] [--app-hosts <pattern|off>]
import http from 'node:http'
import {networkInterfaces, homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

import {createApp, normalizeBackendUrl, VERSION} from './app.mjs'
import {createStore} from './store.mjs'
import {parsePort} from '../omarchyd/cli-args.mjs'
import {defaultTlsDir, dualProtocolServer, tlsContext} from '../omarchyd/tls.mjs'

let values
try {
	const parsed = parseArgs({
		strict: true,
		allowPositionals: false,
		options: {
			backend: {type: 'string'},
			port: {type: 'string'},
			host: {type: 'string'},
			data: {type: 'string'},
			'app-hosts': {type: 'string'},
			help: {type: 'boolean', short: 'h'},
		},
	})
	values = parsed.values
} catch (error) {
	console.error(`[omarchy-server] ${error.message}`)
	console.error('Run with --help for usage.')
	process.exit(2)
}

if (values.help) {
	console.log(`Omarchy Server ${VERSION}

  omarchy-server [--backend <address>] [--port <n>] [--host <addr>] [--data <dir>] [--app-hosts <pattern|off>]

  --backend    Address of omarchyd, the backend (default http://127.0.0.1:2021 when set by installer, env OMARCHY_BACKEND_URL)
  --port       Port to listen on (default 7780, env PORT)
  --host       Address to bind (default 0.0.0.0, env HOST)
  --data       Where config and device sessions live (default ~/.config/omarchy-server, env OMARCHY_SERVER_DATA)
  --app-hosts  App subdomain pattern, e.g. "{app}-touch.example.com" ("off" or "" to clear, env TOUCH_APP_HOSTS)
  -h, --help   Show this help

Environment:
  OMARCHY_SERVER_SECURE_COOKIES=1  Mark the session cookie Secure (when served only behind HTTPS)`)
	process.exit(0)
}

let port
try {
	port = parsePort(values.port, process.env.PORT, {flag: '--port', env: 'PORT', fallback: 7780})
} catch (error) {
	console.error(`[omarchy-server] ${error.message}`)
	process.exit(1)
}
const host = values.host || process.env.HOST || '0.0.0.0'
const dataDir = values.data ?? process.env.OMARCHY_SERVER_DATA ?? join(homedir(), '.config', 'omarchy-server')
const staticDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const store = await createStore(dataDir)
const backendArg = values.backend ?? process.env.OMARCHY_BACKEND_URL
if (backendArg) await store.setConfig({backendUrl: normalizeBackendUrl(backendArg)})
// App addresses for remote access, e.g. "{app}-touch.example.com"; kept until set to "off".
const appHosts = values['app-hosts'] ?? process.env.TOUCH_APP_HOSTS
if (appHosts) await store.setConfig({appHosts: appHosts === 'off' ? null : appHosts})

// https:// on the same port as http:// (see omarchyd/tls.mjs). The certificate is shared with omarchyd.
const secure = tlsContext({dir: defaultTlsDir()})
const app = createApp({store, staticDir, tls: secure, secureCookies: process.env.OMARCHY_SERVER_SECURE_COOKIES === '1'})
const httpServer = http.createServer(app)
const server = dualProtocolServer(httpServer, secure.get)
server.listen(port, host, () => {
	const lan = Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === 'IPv4' && !i.internal)
		.flatMap((i) => [`http://${i.address}:${port}`, `https://${i.address}:${port}`])
	console.log(`\n  Omarchy Server ${VERSION}`)
	console.log(`  Backend   ${store.getConfig().backendUrl ?? '(not set: open the app to connect)'}`)
	console.log(`  Data      ${dataDir}`)
	for (const url of lan.length ? lan : [`http://localhost:${port}`]) console.log(`  Open      ${url}`)
	console.log('')
})
app.attachConsole(httpServer)
server.on('error', (error) => {
	console.error(`[omarchy-server] ${error.message}`)
	process.exit(1)
})
// Stopping (a restart, an update): stop taking new connections, say goodbye to the open ones, and
// don't wait on a browser that keeps its WebSocket open. 5 seconds at most, whatever happens.
let stopping = false
function stop() {
	if (stopping) return
	stopping = true
	setTimeout(() => process.exit(0), 5000).unref()
	server.close(() => process.exit(0))
	app.closeAll()
	httpServer.closeIdleConnections?.()
	setTimeout(() => server.destroyConnections(), 1000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
