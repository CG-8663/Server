import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {dirname, join, relative, sep} from 'node:path'
import {test} from 'node:test'
import {promisify} from 'node:util'

import {createBackups, defaultSpawn, nextRun} from '../omarchyd/backups.mjs'

const execFileAsync = promisify(execFile)

const fakeFiles = (home) => ({
	async resolve(v, {mustExist = true} = {}) {
		if (!v.startsWith('/Home')) throw new Error('outside')
		const real = join(home, v.slice('/Home'.length))
		if (mustExist) await stat(real)
		return {real, top: 'Home'}
	},
})

function unquote(s) {
	return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function splitSmbLine(line) {
	const tokens = []
	const re = /"[^"]*"|\S+/g
	for (const m of line.matchAll(re)) tokens.push(unquote(m[0]))
	return tokens
}

async function listSmbDir(baseDir, smbPrefix, recurse) {
	const lines = []
	const entries = (await readdir(baseDir, {withFileTypes: true}).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
	lines.push('  .                                   D        0  Thu Nov 19 14:48:56 2026')
	lines.push('  ..                                  D        0  Thu Nov 19 14:48:56 2026')
	const dirs = []
	for (const e of entries) {
		if (e.isDirectory()) {
			dirs.push(e.name)
			lines.push(`  ${e.name.padEnd(36)} D        0  Thu Nov 19 14:48:56 2026`)
		} else if (e.isFile()) {
			const st = await stat(join(baseDir, e.name))
			lines.push(`  ${e.name.padEnd(36)} A ${String(st.size).padStart(8)}  Thu Nov 19 14:48:56 2026`)
		}
	}
	if (recurse) {
		for (const d of dirs) {
			const subPrefix = smbPrefix ? `${smbPrefix}\\${d}` : d
			lines.push('')
			lines.push(`\\${subPrefix}`)
			lines.push(...(await listSmbDir(join(baseDir, d), subPrefix, true)))
		}
	}
	return lines
}

function makeFakeNas(nasRoot, {shareName = 'backups', onCommand} = {}) {
	return async (args, opts = {}) => {
		if (args[0] === '-L') {
			return {stdout: `Disk|${shareName}|Backups\n`, stderr: ''}
		}
		const shareRoot = join(nasRoot, shareName)
		await mkdir(shareRoot, {recursive: true})
		let cwd = shareRoot
		let lcd = process.cwd()
		let recurse = false
		let stdout = ''
		let stderr = ''
		const lines = String(opts.input ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
		for (const raw of lines) {
			if (onCommand) await onCommand(raw, {shareRoot, cwd})
			const [cmd, ...rest] = splitSmbLine(raw)
			if (cmd === 'recurse') recurse = rest[0]?.toUpperCase() === 'ON'
			else if (cmd === 'prompt') continue
			else if (cmd === 'lcd') lcd = rest[0]
			else if (cmd === 'mkdir') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				await mkdir(target, {recursive: true})
			} else if (cmd === 'cd') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				const st = await stat(target).catch(() => null)
				if (!st?.isDirectory()) {
					stderr += 'NT_STATUS_OBJECT_NAME_NOT_FOUND\n'
					break
				}
				cwd = target
			} else if (cmd === 'put') {
				const [localPath, remotePath] = rest
				const dest = join(cwd, ...remotePath.split(/[\\/]/).filter(Boolean))
				await mkdir(dirname(dest), {recursive: true})
				await writeFile(dest, await readFile(localPath))
				stdout += `putting file ${localPath} as ${remotePath}\n`
			} else if (cmd === 'get') {
				const [remotePath, localPath] = rest
				const src = join(cwd, ...remotePath.split(/[\\/]/).filter(Boolean))
				const buf = await readFile(src).catch(() => null)
				if (!buf) {
					stderr += 'NT_STATUS_OBJECT_NAME_NOT_FOUND\n'
				} else {
					await mkdir(dirname(localPath), {recursive: true})
					await writeFile(localPath, buf)
				}
			} else if (cmd === 'del') {
				const target = join(cwd, ...rest[0].split(/[\\/]/).filter(Boolean))
				const st = await stat(target).catch(() => null)
				if (!st?.isFile()) stderr += 'NT_STATUS_NO_SUCH_FILE\n'
				else await rm(target)
			} else if (cmd === 'ls') {
				const rel = relative(shareRoot, cwd).split(sep).filter(Boolean).join('\\')
				stdout += (await listSmbDir(cwd, rel, recurse)).join('\n') + '\n'
			} else if (cmd === 'mget') {
				for (const name of await readdir(cwd).catch(() => [])) {
					await cp(join(cwd, name), join(lcd, name), {recursive: true})
				}
			}
		}
		return {stdout, stderr}
	}
}

function makeFakeRestic({onCall, onBackup} = {}) {
	const calls = []
	const runner = async (args, opts = {}) => {
		const sub = args[0]
		calls.push({args: [...args], repo: opts.env?.RESTIC_REPOSITORY, passwordFile: opts.env?.RESTIC_PASSWORD_FILE})
		if (onCall) {
			const res = await onCall(args, opts)
			if (res) return res
		}
		if (sub === 'version') return {stdout: 'restic 0.18.1 compiled with go1.25.1 on linux/amd64\n', stderr: ''}
		const repo = opts.env?.RESTIC_REPOSITORY
		if (sub === 'init') {
			await mkdir(join(repo, 'keys'), {recursive: true})
			await mkdir(join(repo, 'data', 'aa'), {recursive: true})
			await mkdir(join(repo, 'index'), {recursive: true})
			await mkdir(join(repo, 'snapshots'), {recursive: true})
			// Fixed 64-byte config with unique random content to catch size-only comparisons.
			await writeFile(join(repo, 'config'), randomBytes(32).toString('hex'))
			await writeFile(join(repo, 'keys', randomBytes(8).toString('hex')), 'key-data')
			return {stdout: '', stderr: ''}
		}
		if (sub === 'cat' && args[1] === 'config') {
			const buf = await readFile(join(repo, 'config')).catch(() => null)
			if (!buf) throw Object.assign(new Error('restic: config missing'), {code: 1, stdout: '', stderr: 'config missing'})
			return {stdout: buf.toString('utf8'), stderr: ''}
		}
		if (sub === 'backup') {
			if (onBackup) {
				const custom = await onBackup(args, opts)
				if (custom) return custom
			}
			const pack = randomBytes(32).toString('hex')
			const snap = randomBytes(32).toString('hex')
			await mkdir(join(repo, 'data', pack.slice(0, 2)), {recursive: true})
			await writeFile(join(repo, 'data', pack.slice(0, 2), pack), `pack-${snap}`)
			await mkdir(join(repo, 'snapshots'), {recursive: true})
			const tags = []
			for (let i = 0; i < args.length; i++) if (args[i] === '--tag') tags.push(args[i + 1])
			const paths = args.filter((a) => a.startsWith('/'))
			await writeFile(join(repo, 'snapshots', snap), JSON.stringify({id: snap, short_id: snap.slice(0, 8), time: new Date().toISOString(), tags, paths, summary: {total_bytes_processed: 1024}}))
			const line = JSON.stringify({message_type: 'summary', data_added: 1024, total_files_processed: 3})
			opts.onLine?.(line)
			return {stdout: `${line}\n`, stderr: ''}
		}
		if (sub === 'snapshots') {
			const dir = join(repo, 'snapshots')
			const names = await readdir(dir).catch(() => [])
			const out = []
			for (const n of names) out.push(JSON.parse(await readFile(join(dir, n), 'utf8')))
			return {stdout: JSON.stringify(out), stderr: ''}
		}
		if (sub === 'key') return {stdout: '', stderr: ''}
		if (sub === 'forget' || sub === 'check') return {stdout: '', stderr: ''}
		return {stdout: '', stderr: ''}
	}
	return {calls, run: runner}
}

async function listNasFiles(nasRoot, shareName = 'backups', folder = 'Omarchy Server') {
	const root = join(nasRoot, shareName, ...folder.split('/'))
	const out = new Map()
	async function walk(d) {
		for (const e of await readdir(d, {withFileTypes: true}).catch(() => [])) {
			const p = join(d, e.name)
			if (e.isDirectory()) await walk(p)
			else if (e.isFile()) out.set(relative(root, p).split(sep).join('/'), await readFile(p))
		}
	}
	await walk(root)
	return out
}

test('#603 setting up or mirroring on a NAS folder that already holds backups is refused without deleting them', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-603-'))
	const nasRoot = join(root, 'nas')
	const homeA = join(root, 'homeA')
	const homeB = join(root, 'homeB')
	const dataA = join(root, 'dataA')
	const dataB = join(root, 'dataB')
	await mkdir(homeA, {recursive: true})
	await mkdir(homeB, {recursive: true})
	await mkdir(dataA, {recursive: true})
	await mkdir(dataB, {recursive: true})
	await writeFile(join(dataA, 'settings.json'), '{"a":1}\n')
	await writeFile(join(dataB, 'settings.json'), '{"b":1}\n')

	const fakeNas = makeFakeNas(nasRoot)
	const resticA = makeFakeRestic()
	const resticB = makeFakeRestic()
	const runWith = (resticRunner) => async (cmd, args, opts) => {
		if (cmd === 'smbclient') return fakeNas(args, opts)
		return resticRunner.run(args, opts)
	}

	const a = createBackups({dataDir: dataA, home: homeA, serverDataDir: join(root, 'noneA'), files: fakeFiles(homeA), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticA)})
	const b = createBackups({dataDir: dataB, home: homeB, serverDataDir: join(root, 'noneB'), files: fakeFiles(homeB), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticB)})
	t.after(async () => {
		a.close()
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await a.procedures['backups.configure'].run({nas})
	await (await a.runBackup()).done
	await (await a.runBackup()).done

	const beforeFiles = await listNasFiles(nasRoot)
	assert.ok(beforeFiles.has('server/config'))
	assert.ok(beforeFiles.size >= 5)

	// Server B tries to configure on the same NAS folder: must fail and leave Server A's NAS files untouched.
	await assert.rejects(
		b.procedures['backups.configure'].run({nas}),
		(err) => err.code === 'PRECONDITION_FAILED' && /already has backups/i.test(err.message) && /Restore from an existing backup/i.test(err.message),
	)
	const afterConfigureFiles = await listNasFiles(nasRoot)
	assert.deepEqual([...afterConfigureFiles.keys()].sort(), [...beforeFiles.keys()].sort())
	assert.deepEqual(afterConfigureFiles.get('server/config'), beforeFiles.get('server/config'))

	// Server A re-configuring its own NAS folder (e.g. changing password) still succeeds.
	const updated = await a.procedures['backups.configure'].run({nas: {...nas, password: 'p2'}})
	assert.equal(updated.configured, true)

	// Even if Server B had its own separate NAS folder first and was later pointed directly at Server A's folder
	// (bypassing configure), mirror() must refuse when server/config differs (even at identical byte length!).
	const nasB = {host: 'nas.local', share: 'backups', folder: 'Server B Folder', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas: nasB})
	await (await b.runBackup()).done
	// Point B's config.json at Server A's folder on disk and reload a fresh instance B2.
	const bCfgFile = join(dataB, 'backups', 'config.json')
	const bCfg = JSON.parse(await readFile(bCfgFile, 'utf8'))
	bCfg.nas.folder = 'Omarchy Server'
	await writeFile(bCfgFile, JSON.stringify(bCfg))
	const b2 = createBackups({dataDir: dataB, home: homeB, serverDataDir: join(root, 'noneB'), files: fakeFiles(homeB), apps: {backupTargets: async () => []}, resticPath: '/bin/restic', unshare: false, timers: false, run: runWith(resticB)})
	t.after(() => b2.close())
	await b2.ready
	await assert.rejects(b2.mirror(), /different backup|already has backups/i)

	const afterMirrorFiles = await listNasFiles(nasRoot)
	assert.deepEqual([...afterMirrorFiles.keys()].sort(), [...beforeFiles.keys()].sort())
	assert.deepEqual(afterMirrorFiles.get('server/config'), beforeFiles.get('server/config'))
})

test('#598 refuses to recreate a missing or empty backup store or wipe the NAS copy', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-598-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home, {recursive: true})
	await mkdir(dataDir, {recursive: true})
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic()
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas})
	await (await b.runBackup()).done
	const beforeFiles = await listNasFiles(nasRoot)
	assert.ok(beforeFiles.has('server/config'))
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)

	// Case A: empty mount point (backup folder replaced with empty directory).
	const repoDir = join(home, 'Backups', 'Omarchy Server')
	await rm(repoDir, {recursive: true, force: true})
	await mkdir(repoDir, {recursive: true})

	await (await b.runBackup()).done
	let st = await b.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, false)
	assert.match(st.history[0].error, /empty or missing/i)
	assert.equal(st.history[0].nas, null)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())

	// mirror() alone must not wipe the NAS when the local store is missing.
	await assert.rejects(b.mirror(), /missing/i)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())

	// configure({schedule}) while drive is empty/missing must not run restic init.
	await assert.rejects(b.procedures['backups.configure'].run({schedule: {frequency: 'weekly', hour: 4, weekday: 1}}), /empty or missing/i)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)

	// Case B: backup folder deleted completely.
	await rm(repoDir, {recursive: true, force: true})
	await (await b.runBackup()).done
	st = await b.procedures['backups.status'].run()
	assert.equal(st.history[0].ok, false)
	assert.match(st.history[0].error, /empty or missing/i)
	assert.equal(st.history[0].nas, null)
	assert.equal(restic.calls.filter((c) => c.args[0] === 'init').length, 1)
	assert.deepEqual([...(await listNasFiles(nasRoot)).keys()].sort(), [...beforeFiles.keys()].sort())
})

test('#599 restic exit 3 is recorded as a warning and settings/VM failures still prune and copy to the NAS', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-599-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const appDir = join(dataDir, 'apps', 'installed', 'notes')
	await mkdir(appDir, {recursive: true})
	await mkdir(home, {recursive: true})
	await writeFile(join(appDir, 'note.txt'), 'hi\n')
	await writeFile(join(dataDir, 'settings.json'), '{"x":1}\n')

	let settingsMode = 'exit3'
	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic({
		async onBackup(args, opts) {
			if (!args.includes('settings')) return null
			if (settingsMode === 'exit1') {
				throw Object.assign(new Error('/bin/restic: Fatal: repository damaged'), {code: 1, stdout: '', stderr: 'Fatal: repository damaged\n'})
			}
			const line = JSON.stringify({message_type: 'summary', data_added: 1024, total_files_processed: 2})
			opts.onLine?.(line)
			const pack = randomBytes(32).toString('hex')
			const snap = randomBytes(32).toString('hex')
			const repo = opts.env.RESTIC_REPOSITORY
			await mkdir(join(repo, 'data', pack.slice(0, 2)), {recursive: true})
			await writeFile(join(repo, 'data', pack.slice(0, 2), pack), 'pack')
			await writeFile(join(repo, 'snapshots', snap), JSON.stringify({id: snap, short_id: snap.slice(0, 8), time: new Date().toISOString(), tags: ['settings'], paths: [dataDir]}))
			throw Object.assign(new Error('/bin/restic: Warning: at least one source file could not be read'), {
				code: 3,
				stdout: `${line}\n`,
				stderr: 'Warning: at least one source file could not be read\n',
			})
		},
	})
	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => [{id: 'notes', name: 'Notes', dir: appDir, running: false}]},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run: async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts)),
	})
	t.after(async () => {
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b.procedures['backups.configure'].run({nas})
	await (await b.runBackup()).done

	let st = await b.procedures['backups.status'].run()
	const run1 = st.history[0]
	assert.equal(run1.ok, true, run1.error)
	assert.equal(run1.error, null)
	const settingsItem = run1.items.find((i) => i.kind === 'settings')
	assert.ok(settingsItem)
	assert.equal(settingsItem.ok, true)
	assert.equal(settingsItem.added, 1024)
	assert.equal(settingsItem.warning, 'Saved, but some files couldn’t be read')
	assert.equal(run1.nas?.ok, true)
	assert.ok(restic.calls.some((c) => c.args[0] === 'forget' && c.args.includes('--prune')))
	assert.ok(restic.calls.some((c) => c.args[0] === 'check'))
	assert.ok((await listNasFiles(nasRoot)).size >= 5)

	// Real settings failure (exit 1) marks the settings item failed, but still prunes and mirrors apps to the NAS.
	settingsMode = 'exit1'
	restic.calls.length = 0
	await (await b.runBackup()).done
	st = await b.procedures['backups.status'].run()
	const run2 = st.history[0]
	assert.equal(run2.ok, false)
	assert.match(run2.error, /Server settings/)
	assert.equal(run2.items.find((i) => i.kind === 'app')?.ok, true)
	assert.equal(run2.items.find((i) => i.kind === 'settings')?.ok, false)
	assert.equal(run2.nas?.ok, true)
	assert.ok(restic.calls.some((c) => c.args[0] === 'forget' && c.args.includes('--prune')))
})

test('#435 schedules keep their chosen hour across daylight-saving changes', async () => {
	const modUrl = new URL('../omarchyd/backups.mjs', import.meta.url).href
	const script = `
		import assert from 'node:assert/strict'
		import {latestSlot, nextRun} from ${JSON.stringify(modUrl)}

		const checkInvariant = (sc, startIso, hours) => {
			const start = Date.parse(startIso)
			const end = start + hours * 3600_000
			// Build exact sequence of slots by walking nextRun forward from well before start.
			const slots = []
			let cur = start - 14 * 86400_000
			while (true) {
				const n = nextRun(sc, cur)
				slots.push(n)
				cur = n
				if (n > end) break
			}
			for (let t = start; t <= end; t += 15 * 60_000) {
				let expected = null
				for (const s of slots) if (s <= t) expected = s
				const actual = latestSlot(sc, t)
				assert.equal(actual, expected, 'latestSlot mismatch at ' + new Date(t).toString() + ' for ' + JSON.stringify(sc))
			}
		}

		if (process.env.TZ === 'America/New_York') {
			const n = nextRun({frequency: 'daily', hour: 2, weekday: 0}, Date.parse('2026-03-08T07:30:00Z'))
			const d = new Date(n)
			assert.equal(d.getFullYear(), 2026)
			assert.equal(d.getMonth(), 2)
			assert.equal(d.getDate(), 9)
			assert.equal(d.getHours(), 2)

			const w = new Date(nextRun({frequency: 'weekly', hour: 2, weekday: 0}, Date.parse('2026-03-08T07:30:00Z')))
			assert.equal(w.getDate(), 15)
			assert.equal(w.getHours(), 2)

			for (const hour of [0, 1, 2, 3]) {
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-03-07T00:00:00Z', 72)
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-10-31T00:00:00Z', 72)
				checkInvariant({frequency: 'weekly', hour, weekday: 0}, '2026-03-07T00:00:00Z', 96)
				checkInvariant({frequency: 'weekly', hour, weekday: 0}, '2026-10-31T00:00:00Z', 96)
			}
		} else if (process.env.TZ === 'Europe/Berlin') {
			const n = nextRun({frequency: 'daily', hour: 2, weekday: 0}, Date.parse('2026-03-29T01:30:00Z'))
			const d = new Date(n)
			assert.equal(d.getFullYear(), 2026)
			assert.equal(d.getMonth(), 2)
			assert.equal(d.getDate(), 30)
			assert.equal(d.getHours(), 2)

			for (const hour of [0, 1, 2, 3]) {
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-03-28T00:00:00Z', 72)
				checkInvariant({frequency: 'daily', hour, weekday: 0}, '2026-10-24T00:00:00Z', 72)
			}
		}
	`
	for (const tz of ['America/New_York', 'Europe/Berlin']) {
		await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: tz}})
	}
})

test('#437 backups.status includes the server timeZone', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-437-'))
	t.after(() => rm(root, {recursive: true, force: true}))
	const modUrl = new URL('../omarchyd/backups.mjs', import.meta.url).href
	const script = `
		import assert from 'node:assert/strict'
		import {createBackups} from ${JSON.stringify(modUrl)}
		const root = ${JSON.stringify(root)}
		const b = createBackups({
			dataDir: root + '/data',
			home: root,
			files: {async resolve(v) { return {real: root + v, top: 'Home'} }},
			apps: {backupTargets: async () => []},
			timers: false,
			run: async () => ({stdout: '', stderr: ''}),
		})
		try {
			const st = await b.procedures['backups.status'].run()
			assert.equal(st.timeZone, process.env.TZ)
		} finally {
			b.close()
		}
	`
	for (const tz of ['UTC', 'America/New_York']) {
		await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, TZ: tz}})
	}
})

test('#451 defaultSpawn decodes multi-byte UTF-8 characters split across stdout and stderr chunks', async () => {
	const expected = '{"p":"Ünïcödé-日本語-файл"}'
	const stdoutScript = `
		const buf = Buffer.from(${JSON.stringify(expected + '\n')}, 'utf8')
		const cut = buf.indexOf(Buffer.from('日', 'utf8')) + 1
		process.stdout.write(buf.subarray(0, cut))
		setTimeout(() => process.stdout.write(buf.subarray(cut)), 20)
	`
	const lines = []
	const res = await defaultSpawn(process.execPath, ['-e', stdoutScript], {onLine: (l) => lines.push(l)})
	assert.equal(res.stdout, `${expected}\n`)
	assert.deepEqual(lines, [expected])
	assert.equal(res.stdout.includes('\uFFFD'), false)

	const errText = 'Warning: Ünïcödé-日本語-файл unreadable'
	const stderrScript = `
		const buf = Buffer.from(${JSON.stringify(errText + '\n')}, 'utf8')
		const cut = buf.indexOf(Buffer.from('日', 'utf8')) + 2
		process.stderr.write(buf.subarray(0, cut))
		setTimeout(() => {
			process.stderr.write(buf.subarray(cut))
			process.exit(1)
		}, 20)
	`
	await assert.rejects(defaultSpawn(process.execPath, ['-e', stderrScript]), (err) => {
		assert.equal(err.code, 1)
		assert.equal(err.stderr, `${errText}\n`)
		assert.ok(err.message.includes(errText))
		assert.equal(err.stderr.includes('\uFFFD'), false)
		return true
	})
})

test('#568 aborted uploads close their file streams without leaking descriptors', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-568-'))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const repoDir = join(home, 'Backups', 'Omarchy Server')
	await mkdir(join(repoDir, 'computers', 'pc1'), {recursive: true})
	await writeFile(join(repoDir, 'computers', 'pc1', 'config'), 'cfg')
	await mkdir(dataDir, {recursive: true})

	const b = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => []},
		timers: false,
		run: async () => ({stdout: '', stderr: ''}),
	})
	const pending = []
	const server = http.createServer((req, res) => {
		const p = b.handleUpload(req, res, 'pc1', req.url.slice(1)).catch(() => {})
		pending.push(p)
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const {port} = server.address()
	t.after(async () => {
		await Promise.allSettled(pending)
		await new Promise((r) => server.close(r))
		b.close()
		await rm(root, {recursive: true, force: true})
	})

	await b.ready
	const countFds = async () => (await readdir('/proc/self/fd').catch(() => readdir('/dev/fd'))).length
	const before = await countFds()

	const objId = 'a'.repeat(64)
	for (let i = 0; i < 25; i++) {
		const id = `${i.toString(16).padStart(2, '0')}${'b'.repeat(62)}`
		await new Promise((resolve) => {
			const req = http.request({
				host: '127.0.0.1',
				port,
				path: `/data/${id}`,
				method: 'POST',
				headers: {'content-length': '1000000'},
			})
			req.on('error', () => {})
			req.write(Buffer.alloc(1000, 0x41))
			setTimeout(() => {
				req.destroy()
				resolve()
			}, 5)
		})
	}
	await Promise.allSettled(pending)
	await new Promise((r) => setTimeout(r, 80))

	const after = await countFds()
	assert.ok(after <= before + 2, `leaked file descriptors: before=${before}, after=${after}`)
	const dataFiles = await readdir(join(repoDir, 'computers', 'pc1', 'data'), {recursive: true}).catch(() => [])
	assert.deepEqual(dataFiles.filter((f) => String(f).endsWith('.tmp')), [])

	// Normal upload still succeeds and writes exact bytes.
	const body = Buffer.from('hello restic object')
	const res = await fetch(`http://127.0.0.1:${port}/data/${objId}`, {method: 'POST', body})
	assert.equal(res.status, 200)
	assert.deepEqual(await readFile(join(repoDir, 'computers', 'pc1', 'data', objId.slice(0, 2), objId)), body)
})

test('#572 apps paused for a backup are recorded on disk and resumed on startup after a restart', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'bk-572-'))
	const nasRoot = join(root, 'nas')
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	const appDir = join(dataDir, 'apps', 'installed', 'immich')
	await mkdir(appDir, {recursive: true})
	await mkdir(home, {recursive: true})
	await writeFile(join(appDir, 'db.sqlite'), 'data')

	let backupStartedResolve
	let releaseBackup
	const backupStarted = new Promise((r) => (backupStartedResolve = r))
	const backupGate = new Promise((r) => (releaseBackup = r))
	let stallNext = false

	const fakeNas = makeFakeNas(nasRoot)
	const restic = makeFakeRestic({
		async onBackup(args) {
			if (stallNext && args.includes('app:immich')) {
				backupStartedResolve()
				await backupGate
			}
			return null
		},
	})
	const events1 = []
	const apps1 = {
		backupTargets: async () => [{id: 'immich', name: 'Immich', dir: appDir, running: true}],
		pauseForBackup: async (id) => events1.push(`pause ${id}`),
		resumeAfterBackup: async (id) => events1.push(`resume ${id}`),
	}
	const run = async (cmd, args, opts) => (cmd === 'smbclient' ? fakeNas(args, opts) : restic.run(args, opts))
	const b1 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: apps1, resticPath: '/bin/restic', unshare: false, timers: false, run})
	let b2
	let b3
	t.after(async () => {
		releaseBackup?.()
		b1.close()
		b2?.close()
		b3?.close()
		await rm(root, {recursive: true, force: true})
	})

	const nas = {host: 'nas.local', share: 'backups', folder: 'Omarchy Server', username: 'u', password: 'p'}
	await b1.procedures['backups.configure'].run({nas})

	// Normal backup pauses, tracks on disk while running, resumes, and removes marker when done.
	await (await b1.runBackup()).done
	assert.deepEqual(events1, ['pause immich', 'resume immich'])
	await assert.rejects(stat(join(dataDir, 'backups', 'paused-apps.json')))

	// Stalled backup (simulates omarchyd killed before resumeAfterBackup runs).
	stallNext = true
	const run1 = await b1.runBackup()
	await backupStarted
	const marker = JSON.parse(await readFile(join(dataDir, 'backups', 'paused-apps.json'), 'utf8'))
	assert.deepEqual(marker, ['immich'])

	// Simulated restart while immich is still paused: new instance resumes immich on startup and clears marker.
	const events2 = []
	const apps2 = {
		backupTargets: async () => [],
		pauseForBackup: async (id) => events2.push(`pause ${id}`),
		resumeAfterBackup: async (id) => events2.push(`resume ${id}`),
	}
	b2 = createBackups({dataDir, home, serverDataDir: join(root, 'none'), files: fakeFiles(home), apps: apps2, resticPath: '/bin/restic', unshare: false, timers: false, run})
	await b2.ready
	assert.deepEqual(events2, ['resume immich'])
	await assert.rejects(stat(join(dataDir, 'backups', 'paused-apps.json')))

	// Release first backup's stalled gate before closing, then verify a clean restart doesn't resume again.
	releaseBackup()
	await run1.done
	const events3 = []
	b3 = createBackups({
		dataDir,
		home,
		serverDataDir: join(root, 'none'),
		files: fakeFiles(home),
		apps: {backupTargets: async () => [], resumeAfterBackup: async (id) => events3.push(`resume ${id}`)},
		resticPath: '/bin/restic',
		unshare: false,
		timers: false,
		run,
	})
	await b3.ready
	assert.deepEqual(events3, [])
})
