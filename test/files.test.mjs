// Files: every path stays inside Home or the Trash, symlinks included; trash and restore round-trip.
import assert from 'node:assert/strict'
import {lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'

let root, home, outside, files
const call = (name, input) => files.procedures[name].run(input)
before(async () => {
	root = await realpath(await mkdtemp(join(os.tmpdir(), 'omarchy-files-')))
	home = join(root, 'home')
	outside = join(root, 'outside')
	await mkdir(join(home, 'Documents'), {recursive: true})
	await mkdir(outside, {recursive: true})
	await writeFile(join(home, 'Documents', 'notes.txt'), 'hello')
	await writeFile(join(outside, 'secret.txt'), 'not yours')
	await symlink(outside, join(home, 'escape')) // a folder link pointing out of Home
	await symlink(join(outside, 'secret.txt'), join(home, 'secret-link.txt'))
	await mkdir(join(root, 'data'))
	files = createFiles({home, dataDir: join(root, 'data')})
})
after(() => rm(root, {recursive: true, force: true}))

describe('files: paths', () => {
	test('lists Home', async () => {
		const l = await call('files.list', {path: '/Home/Documents'})
		assert.deepEqual(l.files.map((f) => f.name), ['notes.txt'])
	})

	test('refuses ../, ./, NUL, relative paths and unknown roots', async () => {
		for (const bad of ['/Home/../etc', '/Home/Documents/../../outside', '/Home/./Documents', '/Home/a\0b', 'Home/Documents', '/etc', '/', '']) {
			await assert.rejects(files.resolve(bad), (e) => ['BAD_REQUEST', 'NOT_FOUND'].includes(e.code), bad)
		}
	})

	test('symlinks can’t lead out of Home: not to list, read, write or make folders', async () => {
		await assert.rejects(call('files.list', {path: '/Home/escape'}), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(files.resolve('/Home/secret-link.txt'), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(call('files.createDirectory', {path: '/Home/escape/new'}), (e) => e.code === 'FORBIDDEN')
		await assert.rejects(call('files.copy', {path: '/Home/Documents/notes.txt', toDirectory: '/Home/escape'}), (e) => e.code === 'FORBIDDEN')
		assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing written outside Home')
	})

	test('names can’t contain a slash or be . or ..', async () => {
		for (const bad of ['a/b', '..', '.', '', 'x'.repeat(256)]) await assert.rejects(call('files.rename', {path: '/Home/Documents/notes.txt', newName: bad}), (e) => e.code === 'BAD_REQUEST', bad)
		await assert.rejects(call('files.createDirectory', {path: '/Home/..'}), (e) => e.code === 'BAD_REQUEST')
	})

	test('an upload over an existing link replaces the link, never the file it points to', async () => {
		const server = http.createServer((req, res) => files.upload(req, res, new URL(req.url, 'http://x')))
		await new Promise((r) => server.listen(0, '127.0.0.1', r))
		try {
			await symlink(join(outside, 'secret.txt'), join(home, 'Documents', 'trap.txt'))
			const r = await fetch(`http://127.0.0.1:${server.address().port}/?path=${encodeURIComponent('/Home/Documents/trap.txt')}&collision=replace`, {method: 'POST', body: 'uploaded'})
			assert.equal(r.status, 200)
			assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'not yours')
			assert.equal(await readFile(join(home, 'Documents', 'trap.txt'), 'utf8'), 'uploaded')
			assert.ok(!(await lstat(join(home, 'Documents', 'trap.txt'))).isSymbolicLink())
		} finally {
			server.close()
		}
	})
})

describe('files: Trash', () => {
	test('trash and restore round-trip, the freedesktop way', async () => {
		const t = await call('files.trash', {path: '/Home/Documents/notes.txt'})
		assert.equal(t, '/Trash/notes.txt')
		const info = await readFile(join(home, '.local/share/Trash/info/notes.txt.trashinfo'), 'utf8')
		assert.match(info, new RegExp(`Path=${join(home, 'Documents', 'notes.txt')}`))
		assert.equal(await call('files.restore', {path: '/Trash/notes.txt'}), '/Home/Documents/notes.txt')
		assert.equal(await readFile(join(home, 'Documents', 'notes.txt'), 'utf8'), 'hello')
	})

	test('a .trashinfo pointing outside Home restores into Home instead', async () => {
		const trash = join(home, '.local/share/Trash')
		const cases = [
			['dots.txt', `${home}/../outside/dots.txt`], // starts with Home but climbs out
			['abs.txt', `${outside}/abs.txt`],
			['link.txt', `${home}/escape/link.txt`], // through a folder link
		]
		for (const [name, path] of cases) {
			await writeFile(join(trash, 'files', name), name)
			await writeFile(join(trash, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=2026-11-14T10:00:00\n`)
			assert.equal(await call('files.restore', {path: `/Trash/${name}`}), `/Home/${name}`, name)
		}
		assert.deepEqual(await readdir(outside), ['secret.txt'], 'nothing restored outside Home')
	})

	test('only the Trash can be deleted from; Home itself can’t be trashed', async () => {
		await assert.rejects(call('files.delete', {path: '/Home/Documents/notes.txt'}), (e) => e.code === 'BAD_REQUEST')
		await assert.rejects(call('files.trash', {path: '/Home'}), (e) => e.code === 'BAD_REQUEST')
		await call('files.trash', {path: '/Home/Documents/notes.txt'})
		await call('files.delete', {path: '/Trash/notes.txt'})
		assert.deepEqual(await readdir(join(home, '.local/share/Trash/files')), [])
		assert.equal(await readlink(join(home, 'escape')), outside, 'links themselves left alone')
	})
})

describe('files: list paging', () => {
	let paged
	before(async () => {
		paged = join(home, 'Paged')
		await mkdir(paged, {recursive: true})
		for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await writeFile(join(paged, n), n)
	})

	test('limit returns a page after sort, with hasMore and the real total', async () => {
		const l = await call('files.list', {path: '/Home/Paged', limit: 3, sortBy: 'name'})
		assert.equal(l.files.length, 3)
		assert.equal(l.hasMore, true)
		assert.equal(l.totalFiles, 5)
		assert.deepEqual(l.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt'])
		assert.ok(l.files.every((f) => f.path.startsWith('/Home/Paged/')))
		assert.ok(l.files.every((f) => !String(f.path).includes(outside) && !String(f.path).includes(root)))
	})

	test('omitted limit still returns everything', async () => {
		const l = await call('files.list', {path: '/Home/Paged', sortBy: 'name'})
		assert.equal(l.files.length, 5)
		assert.equal(l.hasMore, false)
		assert.equal(l.totalFiles, 5)
		assert.deepEqual(l.files.map((f) => f.name), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
	})

	test('limit 0 or negative is ignored and lists all', async () => {
		for (const limit of [0, -1, -99]) {
			const l = await call('files.list', {path: '/Home/Paged', limit})
			assert.equal(l.files.length, 5, `limit ${limit}`)
			assert.equal(l.hasMore, false, `limit ${limit}`)
			assert.equal(l.totalFiles, 5, `limit ${limit}`)
		}
	})

	test('limit is applied after the requested sort', async () => {
		const {utimes} = await import('node:fs/promises')
		const t0 = new Date('2026-01-01T00:00:00Z')
		for (const [i, n] of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].entries()) {
			await utimes(join(paged, n), t0, new Date(t0.getTime() + i * 60_000))
		}
		const newest = await call('files.list', {path: '/Home/Paged', sortBy: 'modified', sortOrder: 'descending', limit: 2})
		assert.deepEqual(newest.files.map((f) => f.name), ['e.txt', 'd.txt'])
		assert.equal(newest.hasMore, true)
		assert.equal(newest.totalFiles, 5)
		const first = await call('files.list', {path: '/Home/Paged', sortBy: 'name', sortOrder: 'descending', limit: 2})
		assert.deepEqual(first.files.map((f) => f.name), ['e.txt', 'd.txt'])
	})
})
