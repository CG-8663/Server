// Bind sources in a listing's compose file: classified after the same expansion Compose uses,
// then resolved (so `..` and `${HOME}` can't slip past the "own folder" prefix check).
import assert from 'node:assert/strict'
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
