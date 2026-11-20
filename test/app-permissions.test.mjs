// Bind sources in a listing's compose file: classified after the same expansion Compose uses,
// then resolved (so `..` and `${HOME}` can't slip past the "own folder" prefix check).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, symlink} from 'node:fs/promises'
import os from 'node:os'
import {join, resolve} from 'node:path'
import {test} from 'node:test'

import {appPermissions, expandVars} from '../omarchyd/apps.mjs'

const home = '/home/chris'
const appDir = '/home/chris/.local/share/omarchy-server/apps/installed/demo'
const shared = '/home/chris/.local/share/omarchy-server/shared-root'
const downloads = join(home, 'Downloads')
const videos = join(home, 'Videos')
const music = join(home, 'Music')
const pictures = join(home, 'Pictures')
const documents = join(home, 'Documents')
const env = {
	APP_DATA_DIR: appDir,
	DOWNLOADS_DIR: downloads,
	VIDEOS_DIR: videos,
	MUSIC_DIR: music,
	PICTURES_DIR: pictures,
	DOCUMENTS_DIR: documents,
	HOME: home,
}
const where = {
	home,
	cwd: appDir,
	expand: (v) => expandVars(String(v), env).replace(/^\.(?=\/|$)/, appDir).replace(/^~(?=\/|$)/, home),
	allowed: [appDir, shared, downloads, videos, music, pictures, documents],
}

const compose = (...volumes) => `services:\n  web:\n    image: x\n    volumes:\n${volumes.map((v) => `      - ${v}\n`).join('')}`
const ids = (text) => appPermissions(text, where).map((p) => p.id)
const what = (text, id) => appPermissions(text, where).find((p) => p.id === id)?.what ?? []

test('its own data, your media folders and the time zone ask for nothing extra', () => {
	assert.deepEqual(ids(compose('${APP_DATA_DIR}/data:/data', '${VIDEOS_DIR}:/videos', '/etc/localtime:/etc/localtime:ro')), [])
})

test('a folder outside those is host-files; /etc and $HOME are refused', () => {
	assert.deepEqual(what(compose('/srv/media:/media'), 'host-files'), ['/srv/media'])
	assert.ok(ids(compose('~:/home')).includes('refused'))
	assert.ok(what(compose('~:/home'), 'refused').includes(home))
	assert.ok(ids(compose('/etc:/host-etc')).includes('refused'))
})

test('`..` after an allowed prefix is refused, not treated as own', () => {
	for (const src of ['${DOWNLOADS_DIR}/../.ssh:/keys', '${VIDEOS_DIR}/../.ssh:/keys', '${APP_DATA_DIR}/../../../../../../.ssh:/keys']) {
		const perms = appPermissions(compose(src), where)
		assert.ok(perms.some((p) => p.id === 'refused'), src)
		assert.ok(what(compose(src), 'refused').includes(join(home, '.ssh')), src)
		assert.ok(!perms.some((p) => p.id === 'host-files'), src)
	}
})

test('${HOME} is the home folder Compose will bind, so it is refused', () => {
	assert.ok(ids(compose('${HOME}:/host')).includes('refused'))
	assert.ok(what(compose('${HOME}:/host'), 'refused').includes(home))
	assert.ok(ids(compose('${HOME}/.ssh:/keys')).includes('refused'))
	assert.ok(what(compose('${HOME}/.ssh:/keys'), 'refused').includes(join(home, '.ssh')))
})

test('a relative bind is resolved from the app folder, so ../.ssh is refused', () => {
	assert.ok(ids(compose('../.ssh:/keys')).includes('refused'))
	assert.ok(what(compose('../.ssh:/keys'), 'refused').includes(resolve(appDir, '../.ssh')))
})

test('long-syntax type: bind and a relative source without a leading dot are resolved, not skipped', () => {
	const climb = 'foo/../../../../../../../.ssh'
	assert.equal(resolve(appDir, climb), join(home, '.ssh'))
	const long = `services:\n  web:\n    image: x\n    volumes:\n      - type: bind\n        source: ${climb}\n        target: /keys\n`
	assert.ok(ids(long).includes('refused'), 'type: bind')
	assert.ok(what(long, 'refused').includes(join(home, '.ssh')), 'type: bind')
	assert.ok(ids(compose(`${climb}:/keys`)).includes('refused'), 'short syntax with /')
	assert.ok(what(compose(`${climb}:/keys`), 'refused').includes(join(home, '.ssh')))
})

test('a placed FOLDER_ path is what Compose will bind, so climbing out of it is refused', () => {
	const projects = join(home, 'Projects')
	const folderWhere = {
		...where,
		expand: (v) => expandVars(String(v), {...env, FOLDER_PROJECTS: projects}).replace(/^\.(?=\/|$)/, appDir).replace(/^~(?=\/|$)/, home),
		allowed: [...where.allowed, projects],
	}
	const text = compose('${FOLDER_PROJECTS}/../.ssh:/keys')
	const perms = appPermissions(text, folderWhere)
	assert.ok(perms.some((p) => p.id === 'refused'))
	assert.ok((perms.find((p) => p.id === 'refused')?.what ?? []).includes(join(home, '.ssh')))
})

test('a leftover ${VAR} bind is not classified from the process working directory', () => {
	const perms = appPermissions(compose('${SECRET_DIR}:/keys'), {
		...where,
		expand: (v) => expandVars(String(v), {...env, SECRET_DIR: '${DOWNLOADS_DIR}/../.ssh'}),
	})
	assert.ok(perms.some((p) => p.id === 'refused'), 'unresolved $ in a bind source is refused')
	assert.ok((perms.find((p) => p.id === 'refused')?.what ?? []).includes('invalid path'))
	const cwdish = (perms.find((p) => p.id === 'refused')?.what ?? []).some((w) => String(w).includes('{DOWNLOADS_DIR}'))
	assert.equal(cwdish, false, 'realpath of "." must not glue a leftover $ path onto cwd')
	assert.ok(!perms.some((p) => (p.what ?? []).some((w) => String(w).startsWith(process.cwd()))), 'cwd is not a bind source')
})

test('an empty bind source after expansion is refused, not skipped', () => {
	assert.ok(ids(compose('${SECRET_DIR}:/keys')).includes('refused'))
	assert.ok(what(compose('${SECRET_DIR}:/keys'), 'refused').includes('invalid path'))
	const long = 'services:\n  web:\n    image: x\n    volumes:\n      - type: bind\n        source: ${SECRET_DIR}\n        target: /keys\n'
	assert.ok(ids(long).includes('refused'), 'type: bind with an empty source')
})

test('a symlink under an allowed folder is classified as the folder it really is', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-bind-'))
	try {
		const h = join(root, 'home')
		const dl = join(h, 'Downloads')
		const ssh = join(h, '.ssh')
		const app = join(root, 'app')
		await mkdir(dl, {recursive: true})
		await mkdir(ssh, {recursive: true})
		await mkdir(app, {recursive: true})
		await symlink(ssh, join(dl, 'keys'))
		const w = {
			home: h,
			cwd: app,
			expand: (v) => expandVars(String(v), {DOWNLOADS_DIR: dl, HOME: h}),
			allowed: [app, dl],
		}
		const perms = appPermissions(compose('${DOWNLOADS_DIR}/keys:/keys'), w)
		assert.ok(perms.some((p) => p.id === 'refused'))
		assert.ok((perms.find((p) => p.id === 'refused')?.what ?? []).includes(ssh))
		const dangling = join(h, '.missing-ssh')
		await rm(join(dl, 'keys'), {force: true})
		await symlink(dangling, join(dl, 'keys'))
		const gone = appPermissions(compose('${DOWNLOADS_DIR}/keys:/keys'), w)
		assert.ok(gone.some((p) => p.id === 'refused'), 'a dangling symlink is the folder it names, not the parent')
		assert.ok((gone.find((p) => p.id === 'refused')?.what ?? []).includes(dangling))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('/lib/modules is a system folder (asks), even where /lib is a link to /usr/lib as on Arch', () => {
	// WireGuard's listing binds it. Resolving /lib/modules to /usr/lib/modules must not make it refused.
	assert.deepEqual(ids(compose('/lib/modules:/lib/modules:ro')), ['system'])
	assert.deepEqual(what(compose('/lib/modules:/lib/modules:ro'), 'system'), ['/lib/modules'])
	assert.deepEqual(ids(compose('/usr/lib/modules:/lib/modules:ro')), ['system'])
	// The rest of /usr is still refused.
	assert.ok(ids(compose('/usr/bin:/host-bin')).includes('refused'))
})

const portFile = (ports) => `services:\n a:\n  image: x\n  ports:\n${ports.map((p) => `   - ${p}\n`).join('')}`
const lowPorts = (text) => appPermissions(text).find((p) => p.id === 'low-ports')?.what ?? []

test('a port below 1024 in long syntax or a variable is low-ports', () => {
	assert.ok(lowPorts(portFile(['"53:53"'])).includes('53'), 'short 53:53')
	assert.deepEqual(lowPorts(portFile(['published: 53'])), ['53'], 'long published 53')
	assert.deepEqual(lowPorts(portFile(['published: "80"\n     host_ip: 127.0.0.1\n     target: 8080'])), ['80'], 'long published 80 with host_ip')
	assert.deepEqual(lowPorts(portFile(['"${PORT:-80}:80"'])), ['80'], '${PORT:-80}')
	assert.deepEqual(lowPorts(portFile(['"${PORT:-443}:80"'])), ['443'], '${PORT:-443}')
	assert.deepEqual(lowPorts(portFile(['"${PORT:-8080}:80"'])), [], '${PORT:-8080} is not a low port')
	assert.deepEqual(lowPorts(portFile(['"80-90:80"'])), ['80'], 'short range 80-90')
	assert.deepEqual(lowPorts(portFile(['published: "2000-2010"'])), [], 'long range 2000-2010')
	assert.deepEqual(lowPorts(portFile(['"80"', 'target: 80'])), [], 'container port alone')
})
