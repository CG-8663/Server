import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import YAML from 'yaml'

import {containerPlan, createUnraid, rsyncProgress, slug, sq, unraidPath, vmPlan, webuiPort} from '../omarchyd/unraid.mjs'

const plex = {
	Name: '/plex',
	State: {Running: true},
	Config: {Image: 'lscr.io/linuxserver/plex:latest', Env: ['PUID=99', 'PGID=100', 'VERSION=docker', 'PATH=/usr/bin', 'LSIO_DEFAULT=1'], ExposedPorts: {'32400/tcp': {}}, Labels: {'net.unraid.docker.webui': 'http://[IP]:[PORT:32400]/web'}, Cmd: null},
	HostConfig: {NetworkMode: 'host', PortBindings: {}, Devices: [{PathOnHost: '/dev/dri'}]},
	Mounts: [
		{Type: 'bind', Source: '/mnt/user/appdata/plex', Destination: '/config', RW: true},
		{Type: 'bind', Source: '/mnt/user/Media/Movies', Destination: '/movies', RW: true},
	],
}
const nginx = {
	Name: '/nginx',
	State: {Running: false},
	Config: {Image: 'nginx:1.27', Env: ['NGINX_VERSION=1.27', 'SECRET=a$b'], ExposedPorts: {'80/tcp': {}}, Labels: {}, Cmd: ['nginx', '-g', 'daemon off;'], User: '99:100'},
	HostConfig: {NetworkMode: 'bridge', PortBindings: {'80/tcp': [{HostPort: '8085'}], '53/udp': [{HostPort: '53'}], '9443/tcp': [{HostPort: '9443'}]}, Privileged: true, CapAdd: ['NET_ADMIN']},
	Mounts: [
		{Type: 'bind', Source: '/mnt/cache/appdata/nginx', Destination: '/etc/nginx/conf.d', RW: true},
		{Type: 'bind', Source: '/etc/localtime', Destination: '/etc/localtime', RW: false},
		{Type: 'bind', Source: '/boot/config', Destination: '/flash', RW: true},
	],
}

test('where a path on Unraid lives', () => {
	assert.deepEqual(unraidPath('/mnt/user/appdata/plex'), {kind: 'appdata', rest: 'plex'})
	assert.deepEqual(unraidPath('/mnt/cache/appdata/nginx/conf'), {kind: 'appdata', rest: 'nginx/conf'})
	assert.deepEqual(unraidPath('/mnt/user/Media/Movies'), {kind: 'share', share: 'Media', rest: 'Movies'})
	assert.deepEqual(unraidPath('/mnt/disk3/Media'), {kind: 'share', share: 'Media', rest: ''})
	assert.equal(unraidPath('/boot/config').kind, 'other')
	assert.equal(unraidPath('/mnt/disks/usbstick/x').kind, 'other')
	// ".." in the path after the share would copy or bind outside the folder we chose.
	assert.equal(unraidPath('/mnt/user/appdata/../../.ssh').kind, 'other')
	assert.equal(unraidPath('/mnt/user/appdata/plex/../../.ssh').kind, 'other')
	assert.equal(unraidPath('/mnt/cache/Media/../.config').kind, 'other')
	assert.deepEqual(webuiPort('http://[IP]:[PORT:8096]/web'), {port: 8096, path: '/web'})
	assert.equal(webuiPort(''), null)
	assert.equal(slug('Home Assistant!'), 'home-assistant')
	assert.equal(sq("it's"), `'it'\\''s'`)
})

test('a container mount that climbs out of appdata is not copied or bind-mounted', () => {
	const escaped = {
		...plex,
		Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/../../.ssh', Destination: '/config', RW: true}],
	}
	const p = containerPlan(escaped)
	assert.equal(p.copies.length, 0)
	const compose = YAML.parse(p.files['docker-compose.yml'])
	const volumes = JSON.stringify(compose.services)
	assert.doesNotMatch(volumes, /\.\./)
	assert.ok(p.notes.some((n) => n.includes('isn’t brought over')))
})

test('a container on Unraid becomes the same app here', () => {
	const p = containerPlan(plex, {imageEnv: ['PATH=/usr/bin', 'LSIO_DEFAULT=1']})
	assert.equal(p.id, 'unraid-plex')
	const app = YAML.parse(p.files['omarchy-app.yml'])
	const svc = YAML.parse(p.files['docker-compose.yml']).services.plex
	assert.equal(app.port, 32400)
	assert.deepEqual(app.web, {service: 'plex', port: 32400})
	assert.equal(app.path, '/web')
	assert.equal(svc.image, 'lscr.io/linuxserver/plex:latest')
	// Unraid's nobody:users becomes the app user here; the image's own settings aren't repeated.
	assert.deepEqual(svc.environment, {PUID: '${PUID}', PGID: '${PGID}', VERSION: 'docker'})
	assert.deepEqual(svc.ports, ['32400:32400'])
	assert.deepEqual(p.copies, [{from: '/mnt/user/appdata/plex', to: 'plex'}])
	assert.ok(svc.volumes.includes('${APP_DATA_DIR:-.}/data/plex:/config'))
	assert.deepEqual(p.shares, ['Media'])
	assert.ok(p.notes.some((n) => /\/dev\/dri/.test(n)))
	assert.ok(p.notes.some((n) => /Media share/.test(n)))
	assert.ok(p.notes.some((n) => /own network setting \(host\)/.test(n)))
	assert.equal(p.running, true)
	// …with the share it uses being brought over: that folder.
	const withShare = containerPlan(plex, {shareDest: (s) => (s === 'Media' ? '/home/chris/Unraid/Media' : null)})
	assert.ok(YAML.parse(withShare.files['docker-compose.yml']).services.plex.volumes.includes('/home/chris/Unraid/Media/Movies:/movies'))
})

test('what can’t come across is left out and said', () => {
	const p = containerPlan(nginx, {imageEnv: ['NGINX_VERSION=1.27'], imageCmd: ['nginx', '-g', 'daemon off;'], takenIds: new Set(['unraid-nginx'])})
	assert.equal(p.id, 'unraid-nginx-2')
	const svc = YAML.parse(p.files['docker-compose.yml']).services.nginx
	const app = YAML.parse(p.files['omarchy-app.yml'])
	assert.equal(app.port, 8085)
	assert.deepEqual(app.web, {service: 'nginx', port: 80})
	assert.deepEqual(app.openPorts, [9443])
	assert.deepEqual(svc.ports, ['8085:80', '9443:9443'])
	// A "$" in a setting stays a "$" (Compose would read it as a variable).
	assert.equal(svc.environment.SECRET, 'a$$b')
	assert.equal(svc.user, '${PUID}:${PGID}')
	assert.equal(svc.command, undefined, 'the image’s own command isn’t repeated')
	assert.equal(svc.privileged, undefined)
	assert.ok(svc.volumes.includes('/etc/localtime:/etc/localtime:ro'))
	assert.ok(!svc.volumes.some((v) => v.includes('/boot')))
	for (const what of [/privileged/, /NET_ADMIN/, /below 1024 \(53\)/, /\/boot\/config/]) assert.ok(p.notes.some((n) => what.test(n)), String(what))
})

test('a VM on Unraid: its settings and disks', () => {
	const xml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>8388608</memory><vcpu placement='static'>4</vcpu>
<os><loader readonly='yes' type='pflash'>/usr/share/qemu/ovmf-x64/OVMF_CODE-pure-efi.fd</loader><type arch='x86_64' machine='pc-q35-7.2'>hvm</type></os>
<devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='hdc' bus='virtio'/></disk>
<disk type='file' device='cdrom'><source file='/mnt/user/isos/w.iso'/><target dev='hda' bus='sata'/></disk>
<disk type='block' device='disk'><source dev='/dev/disk/by-id/ata-X'/><target dev='hdd' bus='sata'/></disk>
<interface type='bridge'><model type='e1000'/></interface><hostdev mode='subsystem' type='pci'/></devices></domain>`
	const v = vmPlan(xml, 'shut off')
	assert.equal(v.name, 'Win11')
	assert.equal(v.memoryMb, 8192)
	assert.equal(v.cores, 4)
	assert.equal(v.firmware, 'efi')
	assert.equal(v.machineType, 'q35')
	assert.equal(v.nic, 'e1000e')
	assert.deepEqual(v.disks, [{file: '/mnt/user/domains/Win11/vdisk1.img', bus: 'virtio', format: 'raw'}])
	assert.ok(v.notes.some((n) => /whole drive/.test(n)))
	assert.ok(v.notes.some((n) => /graphics card/.test(n)))
	assert.equal(vmPlan('<domain><name>x</name><os><type machine="pc-i440fx-7.1">hvm</type></os></domain>').machineType, 'pc')
	assert.deepEqual(vmPlan('<domain><name>x</name></domain>').problems, ['It has no disk image to copy'])
})

test('rsync progress', () => {
	assert.deepEqual(rsyncProgress('    1,234,567  45%   10.00MB/s    0:01:23 (xfr#3, to-chk=0/9)'), {bytes: 1234567, percent: 0.45})
	assert.equal(rsyncProgress('sending incremental file list'), null)
})

test('bad details never reach ssh', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-'))
	const calls = []
	const u = createUnraid({dataDir: dir, files: {}, apps: {}, machines: {}, storage: null, run: async (...a) => (calls.push(a), {stdout: '', stderr: ''})})
	try {
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower; rm -rf /', password: 'x'}), /name or address/)
		await assert.rejects(u.procedures['unraid.connect'].run({host: 'tower.local', password: 'a\nb'}), /root password/)
		await assert.rejects(u.procedures['unraid.scan'].run(), /Connect/)
		assert.equal(calls.length, 0)
		await u.procedures['unraid.connect'].run({host: 'tower.local', password: 's3cret'}).catch(() => {})
		const ssh = calls.find((c) => c[0] === 'ssh')
		assert.ok(ssh)
		// The password goes to ssh only through its askpass helper's environment.
		assert.ok(!ssh[1].join(' ').includes('s3cret'))
		assert.equal(ssh[2].env.OMARCHY_UNRAID_SECRET, 's3cret')
		assert.ok(ssh[1].includes('StrictHostKeyChecking=accept-new'))
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})

// End to end against a real SSH server standing in for Unraid (see the test's notes in the PR):
// OMARCHY_UNRAID_IT="host:port user password".
const it = process.env.OMARCHY_UNRAID_IT ? false : 'set OMARCHY_UNRAID_IT to run against an SSH stand-in for Unraid'
test('connect, look around, and bring shares, containers and a VM over', {skip: it, timeout: 300_000}, async () => {
	const [hostport, user, password] = String(process.env.OMARCHY_UNRAID_IT).split(' ')
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-it-'))
	const home = join(dir, 'home')
	await mkdir(home)
	const files = {
		async resolve(v, {mustExist = true} = {}) {
			const real = join(home, v.slice('/Home'.length))
			if (mustExist) await stat(real)
			return {real, top: 'Home'}
		},
	}
	const installed = []
	const shared = []
	const vmsMade = []
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async (id) => installed.push(id),
		importState: () => ({done: true, error: null}),
	}
	const machines = {
		importVm: async (spec) => {
			vmsMade.push({...spec, sizes: await Promise.all(spec.disks.map(async (d) => (await stat(d.file)).size))})
			return {id: 'vm1'}
		},
		importState: () => ({done: true, error: null}),
	}
	const storage = {procedures: {'files.addShare': {run: async ({path}) => shared.push(path)}}}
	const u = createUnraid({dataDir: join(dir, 'data'), files, apps, machines, storage, user, runtimeDir: dir})
	await writeFile('/srv/fake-unraid/vmstate', 'shut off\n').catch(() => {})
	const log = '/srv/fake-unraid/log'
	await writeFile(log, '').catch(() => {})
	try {
		await assert.rejects(u.procedures['unraid.connect'].run({host: hostport, password: 'wrong'}), /didn’t accept that password/)
		const c = await u.procedures['unraid.connect'].run({host: hostport, password})
		assert.equal(c.version, '7.0.1')
		assert.match(c.fingerprint, /^SHA256:/)
		const s = await u.procedures['unraid.scan'].run()
		const names = s.shares.map((x) => x.name)
		for (const n of ['Media', 'Documents', 'appdata', 'system', 'domains']) assert.ok(names.includes(n), n)
		assert.equal(s.shares.find((x) => x.name === 'appdata').kind, 'appdata')
		assert.ok(s.shares.find((x) => x.name === 'Media').size > 0)
		assert.deepEqual(s.containers.map((x) => x.id).sort(), ['unraid-nginx', 'unraid-plex'])
		assert.ok(s.containers.find((x) => x.id === 'unraid-plex').size > 0)
		assert.equal(s.vms.length, 1)
		assert.equal(s.vms[0].size, 2 * 1024 * 1024)
		assert.equal(s.containers[0].files, undefined, 'the listings stay on the server')

		await u.procedures['unraid.start'].run({shares: ['Media', 'Documents', 'system'], containers: ['unraid-plex', 'unraid-nginx'], vms: ['Win11'], destination: '/Home/Unraid'})
		let st
		for (let i = 0; i < 600; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job.endedAt) break
			await new Promise((r) => setTimeout(r, 250))
		}
		const items = Object.fromEntries(st.job.items.map((x) => [x.key, x]))
		for (const k of ['Media', 'Documents', 'unraid-plex', 'unraid-nginx', 'Win11']) assert.equal(items[k]?.status, 'done', `${k}: ${items[k]?.error}`)
		assert.equal(items.system, undefined, 'Unraid’s system share isn’t brought over')
		// Shares: copied and shared on the network.
		assert.equal(await readFile(join(home, 'Unraid/Media/Movies/film.txt'), 'utf8'), 'pretend movie\n')
		assert.equal(await readFile(join(home, 'Unraid/Documents/2026.txt'), 'utf8'), 'taxes\n')
		assert.deepEqual(shared.sort(), ['/Home/Unraid/Documents', '/Home/Unraid/Media'])
		// Containers: appdata in the app's folder, the listing in the imported store, installed.
		assert.equal(await readFile(join(dir, 'apps/unraid-plex/data/plex/Library/Application Support/Preferences.xml'), 'utf8'), '<Preferences/>\n')
		assert.equal(await readFile(join(dir, 'apps/unraid-nginx/data/nginx/site.conf'), 'utf8'), 'server {}\n')
		const compose = YAML.parse(await readFile(join(dir, 'store/unraid-plex/docker-compose.yml'), 'utf8'))
		assert.ok(compose.services.plex.volumes.includes(`${join(home, 'Unraid/Media/Movies')}:/movies`))
		assert.ok(compose.services.plex.volumes.includes(`${join(home, 'Unraid/Documents')}:/docs:ro`), 'read-only stays read-only')
		assert.deepEqual(installed, ['unraid-plex', 'unraid-nginx'])
		assert.match(items['unraid-plex'].note, /\/dev\/dri/)
		assert.doesNotMatch(items['unraid-plex'].note, /Media share/, 'the share it uses came over, so no warning about it')
		// Only the running one was paused on Unraid, and started again.
		assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['stop plex', 'start plex'])
		// The VM: its disk copied, then made into a machine; the copy is cleaned up afterwards.
		assert.equal(vmsMade.length, 1)
		assert.deepEqual(vmsMade[0].sizes, [2 * 1024 * 1024])
		assert.equal(vmsMade[0].firmware, 'efi')
		assert.deepEqual(await readdir(join(dir, 'data/unraid/staging')), [])

		// A VM still running on Unraid isn't copied.
		await writeFile('/srv/fake-unraid/vmstate', 'running\n')
		await u.procedures['unraid.start'].run({vms: ['Win11']})
		for (let i = 0; i < 200; i++) {
			st = await u.procedures['unraid.status'].run()
			if (st.job.endedAt) break
			await new Promise((r) => setTimeout(r, 100))
		}
		assert.match(st.job.items[0].error, /Shut down Win11 on Unraid first/)
	} finally {
		await writeFile('/srv/fake-unraid/vmstate', 'shut off\n').catch(() => {})
		u.close()
		await rm(dir, {recursive: true, force: true})
	}
})
