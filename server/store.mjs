// Small JSON-file persistence for config and device sessions. Files are written
// atomically with mode 0600 because sessions hold Omarchy Server device credentials.

import {createHash, randomBytes} from 'node:crypto'
import {chmod, mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'

function plainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

// A missing file is the fallback. A parse or shape problem is also the fallback, but the
// damaged bytes stay on disk: renamed to *.bad once, or left in place when *.bad already
// exists. Any other read error still rejects startup. The log is the file name only.
async function readJson(file, fallback) {
	let text
	try {
		text = await readFile(file, 'utf8')
	} catch (error) {
		if (error.code === 'ENOENT') return fallback
		throw error
	}
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error
		parsed = undefined
	}
	if (plainObject(parsed)) return parsed
	console.error(`${basename(file)} is empty or invalid and was left unchanged`)
	await keepDamaged(file)
	return fallback
}

async function keepDamaged(file) {
	const aside = `${file}.bad`
	try {
		await stat(aside)
		return
	} catch (error) {
		if (error.code !== 'ENOENT') throw error
	}
	await rename(file, aside)
}

async function writeJson(file, value) {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	await writeFile(tmp, JSON.stringify(value, null, 2), {mode: 0o600})
	await rename(tmp, file)
	await chmod(file, 0o600).catch(() => {})
}

export const hashId = (id) => createHash('sha256').update(id).digest('hex')
export const newSessionId = () => randomBytes(32).toString('base64url')

export async function createStore(dataDir) {
	await mkdir(dataDir, {recursive: true, mode: 0o700})
	const configFile = join(dataDir, 'config.json')
	const sessionsFile = join(dataDir, 'sessions.json')

	let config = await readJson(configFile, {})
	// Keyed by sha256(cookie value) so the file alone can't be replayed as a cookie.
	let sessions = await readJson(sessionsFile, {})
	let writing = Promise.resolve()
	const persistSessions = () => (writing = writing.then(() => writeJson(sessionsFile, sessions)).catch(() => {}))
	let configWriting = Promise.resolve()

	return {
		dataDir,
		getConfig: () => ({...config}),
		async setConfig(patch) {
			const run = configWriting.then(async () => {
				const next = {...config, ...patch}
				await writeJson(configFile, next)
				config = next
				return {...config}
			})
			// Queue past a failure so the next save still runs, but this caller gets the rejection.
			configWriting = run.catch(() => {})
			return run
		},
		getSession: (cookieId) => (cookieId ? sessions[hashId(cookieId)] : undefined),
		async putSession(cookieId, session) {
			sessions[hashId(cookieId)] = session
			await persistSessions()
		},
		async updateSession(cookieId, patch) {
			const key = hashId(cookieId)
			if (!sessions[key]) return
			sessions[key] = {...sessions[key], ...patch}
			await persistSessions()
		},
		async deleteSession(cookieId) {
			delete sessions[hashId(cookieId)]
			await persistSessions()
		},
		async clearSessions() {
			sessions = {}
			await persistSessions()
		},
		sessionCount: () => Object.keys(sessions).length,
		// Every stored session with its key (sha256 of the cookie), for Settings › Signed-in devices.
		sessionEntries: () => Object.entries(sessions).map(([key, session]) => ({key, session})),
		async updateSessionByKey(key, patch) {
			if (!sessions[key]) return
			sessions[key] = {...sessions[key], ...patch}
			await persistSessions()
		},
		async deleteSessionByKey(key) {
			delete sessions[key]
			await persistSessions()
		},
	}
}
