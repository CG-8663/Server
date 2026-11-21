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
			lines.push(`  ${e.name.padEnd(36)}D        0  Thu Nov 19 14:48:56 2026`)
		} else if (e.isFile()) {
			const st = await stat(join(baseDir, e.name))
			lines.push(`  ${e.name.padEnd(36)}A ${String(st.size).padStart(8)}  Thu Nov 19 14:48:56 2026`)
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
