import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {PassThrough} from 'node:stream'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createFrameReader, createHyprland, isPcmSilent} from '../omarchyd/hyprland.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM_PY = join(HERE, '..', 'omarchyd', 'hypr-stream.py')
const RAIL_C = join(HERE, '..', 'omarchyd', 'hypr-rail-capture.c')

function framePacket(type, payloadBuf) {
	const hdr = Buffer.alloc(5)
	hdr[0] = type
	hdr.writeUInt32BE(payloadBuf.length, 1)
	return Buffer.concat([hdr, payloadBuf])
}

test('createFrameReader reassembles fragmented multi-chunk frames and rejects oversized headers', () => {
	const reader = createFrameReader()
	const p1 = framePacket(1, Buffer.from('{"width":3840,"height":2160}'))
	const p2 = framePacket(2, Buffer.alloc(4096, 0xab))
	const wire = Buffer.concat([p1, p2])
	const out = []
	// Feed tiny 3-byte slices to force split headers and split payloads across chunk boundaries
	for (let i = 0; i < wire.length; i += 3) {
		reader.push(wire.subarray(i, Math.min(wire.length, i + 3)))
		assert.equal(
			reader.drain((type, payload) => out.push({type, len: payload.length, first: payload[0]})),
			true,
		)
	}
	assert.equal(out.length, 2)
	assert.equal(out[0].type, 1)
	assert.equal(out[1].type, 2)
	assert.equal(out[1].len, 4096)
	assert.equal(out[1].first, 0xab)

	const bad = Buffer.alloc(5)
	bad[0] = 2
	bad.writeUInt32BE(32 * 1024 * 1024, 1)
	reader.push(bad)
	assert.equal(reader.drain(() => {}), false)
})

test('isPcmSilent detects near-silent PCM frames and passes audible signal', () => {
	const quiet = Buffer.alloc(3840, 0)
	assert.equal(isPcmSilent(quiet), true)
	quiet.writeInt16LE(12, 100)
	assert.equal(isPcmSilent(quiet), true)
	const loud = Buffer.alloc(3840, 0)
	loud.writeInt16LE(-800, 120)
	assert.equal(isPcmSilent(loud), false)
})

test('hyprland status, windows, strict dispatch allowlist, and WebSocket H.264 stream bridge with WAN backpressure', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-test-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const dispatched = []
		const luaDispatched = []
		const spawned = []
		const clients = [
			{address: '0x55a1b2c3d4e0', title: 'Chrome', class: 'chromium', workspace: {id: 1}, at: [10, 10], size: [1200, 800], mapped: true, floating: false, fullscreen: false, pid: 1234},
			{address: '0xbad', title: 'Invalid', mapped: true},
		]
		const monitors = [{id: 0, name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1200, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 1}}]

		const fakeChild = new EventEmitter()
		fakeChild.stdin = new PassThrough()
		fakeChild.stdout = new PassThrough()
		fakeChild.stderr = new PassThrough()
		fakeChild.killed = false
		fakeChild.kill = () => {
			fakeChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'ffmpeg' || cmd === 'python3') return {ok: true, stdout: 'ok', stderr: ''}
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: 'no pkg-config in mock'}
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify(monitors), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'output' && args[1] === 'create') {
					monitors.push({id: 1, name: 'RAIL-1', x: 1920, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}})
					return {ok: true, stdout: 'ok', stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify(clients), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'eval') {
					if (args[1].includes('0x55a1b2c3d4e0') && args[1].includes('hl.dsp.focus')) {
						return {ok: true, stdout: 'unknown request\n', stderr: ''}
					}
					luaDispatched.push(args[1])
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'dispatch') {
					dispatched.push(args)
					return {ok: true, stdout: 'ok', stderr: ''}
				}
				return {ok: false, stdout: '', stderr: 'unknown'}
			},
			spawnImpl(cmd, args) {
				spawned.push({cmd, args})
				return fakeChild
			},
		})

		const st = await hypr.procedures['hyprland.status'].run()
		assert.equal(st.available, true)
		assert.equal(st.wayland, 'wayland-1')
		assert.equal(st.vaapi, true)
		assert.equal(st.encoder, 'h264_vaapi')
		assert.equal(st.monitors[0].name, 'eDP-1')

		const wins = await hypr.procedures['hyprland.windows'].run()
		assert.equal(wins.length, 1)
		assert.equal(wins[0].address, '0x55a1b2c3d4e0')
		assert.equal(wins[0].title, 'Chrome')

		// Strict allowlist for dispatch (both legacy fallback and Hyprland 0.57 Lua path)
		await hypr.procedures['hyprland.dispatch'].run({action: 'focus', address: '0x55a1b2c3d4e0'})
		await hypr.procedures['hyprland.dispatch'].run({action: 'workspace', workspace: 2})
		await hypr.procedures['hyprland.dispatch'].run({action: 'resize', address: '0x55a1b2c3d4e0', width: 1280, height: 720})
		await hypr.procedures['hyprland.dispatch'].run({action: 'moveToRail', address: '0x55a1b2c3d4e0'})
		assert.deepEqual(dispatched, [['dispatch', 'focuswindow', 'address:0x55a1b2c3d4e0']])
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.workspace.change_id({id = 2})')))
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.window.resize({window = "address:0x55a1b2c3d4e0", x = 1280, y = 720, exact = true})')))
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.window.move({window = "address:0x55a1b2c3d4e0", workspace = "11"')))
		await assert.rejects(() => hypr.procedures['hyprland.dispatch'].run({action: 'exec', command: 'id'}), /Unsupported/)
		await assert.rejects(() => hypr.procedures['hyprland.dispatch'].run({action: 'focus', address: '0x12;rm -rf /'}), /Invalid window address/)

		// Attach a mock WebSocket and verify binary H.264 framing + input sanitization + tight 384 KiB WAN backpressure
		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		const stdinChunks = []
		fakeChild.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))

		await hypr.attachStream(fakeWs, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60, bitrate: 10000})
		const streamSpawn = spawned.at(-1)
		assert.ok(streamSpawn.args.includes('--mode') && streamSpawn.args.includes('window') && streamSpawn.args.includes('0x55a1b2c3d4e0'))

		// Emit metadata + keyframe + delta frame under 512 KiB backpressure (>384 KiB ceiling)
		fakeChild.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1200, height: 800, fps: 60, encoder: 'h264_vaapi_dmabuf'}))))
		const keyPayload = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x28])])
		fakeChild.stdout.write(framePacket(2, keyPayload))
		fakeWs.bufferedAmount = 512 * 1024
		const deltaPayload = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x41, 0x9a])])
		fakeChild.stdout.write(framePacket(2, deltaPayload))

		// Once socket drains below 64 KiB, next frame triggers deferred keyframe recovery
		fakeWs.bufferedAmount = 0
		fakeChild.stdout.write(framePacket(2, deltaPayload))

		// Forward allowed input, drop disallowed input & strip injected nested fields
		fakeWs.emit('message', JSON.stringify({type: 'pointer_move', x: 0.25, y: 0.75, extra: {type: 'win_rect', x: 999}}), false)
		fakeWs.emit('message', JSON.stringify({type: 'exec', cmd: 'evil'}), false)
		await new Promise((r) => setTimeout(r, 40))

		assert.equal(sent.length, 2, 'only meta + keyframe should be delivered while waiting for recovery keyframe')
		assert.equal(JSON.parse(sent[0].data).type, 'meta')
		assert.equal(sent[1].binary, true)
		const stdinText = stdinChunks.join('')
		assert.ok(stdinText.includes('"type":"keyframe"'), 'deferred keyframe should fire once send buffer drains')
		assert.ok(stdinText.includes('{"type":"pointer_move","x":0.25,"y":0.75}'), 'sanitized input should strip extra fields')
		assert.ok(stdinText.includes('"win_rect"'), 'initial window rect should be pushed for C-level pointer mapping')
		assert.ok(!stdinText.includes('evil'))
		assert.ok(!stdinText.includes('999'))

		fakeWs.emit('close')
		assert.equal(fakeChild.killed, true)
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('live PipeWire PCM audio suppresses silent chunks, streams audible chunks with 0x02 tag, and stops on mute', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-audio-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const videoChild = new EventEmitter()
		videoChild.stdin = new PassThrough()
		videoChild.stdout = new PassThrough()
		videoChild.stderr = new PassThrough()
		videoChild.killed = false
		videoChild.kill = () => {
			videoChild.killed = true
		}

		const audioChild = new EventEmitter()
		audioChild.stdout = new PassThrough()
		audioChild.killed = false
		audioChild.kill = () => {
			audioChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent'),
			async exec(cmd, args) {
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: false, stdout: '', stderr: ''}
			},
			spawnImpl(cmd) {
				return cmd === 'parec' ? audioChild : videoChild
			},
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'output', audio: true})
		// Emit 2 silent 20ms PCM frames -> must be silence-gated (0 bytes sent)
		audioChild.stdout.write(Buffer.alloc(3840 * 2, 0))
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(sent.filter((s) => s.binary && s.data[0] === 2).length, 0, 'silent audio must not consume TCP bandwidth')

		// Emit 1 audible 20ms PCM frame -> must stream with 0x02 tag
		audioChild.stdout.write(Buffer.alloc(3840, 0x2a))
		await new Promise((r) => setTimeout(r, 30))

		const audioPkts = sent.filter((s) => s.binary && s.data[0] === 2)
		assert.equal(audioPkts.length, 1, 'should emit one tagged 0x02 PCM audio packet')
		assert.equal(audioPkts[0].data.length, 3841)

		fakeWs.emit('message', JSON.stringify({type: 'audio', enabled: false}), false)
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(audioChild.killed, true, 'muting audio must terminate parec immediately')

		fakeWs.emit('close')
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('real hypr-stream.py FrameWriter big-endian wire format decodes cleanly in hyprland.mjs and browser DataView', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-wire-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const pyCode = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("hs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
w = mod.FrameWriter()
w.send_json(1, {"width": 1920, "height": 1200, "fps": 60, "encoder": "h264_vaapi"})
w.send_video(True, 12345678, b"\\x00\\x00\\x00\\x01\\x67\\x42\\xe0\\x28")
`
		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent-vaapi'),
			spawnImpl() {
				return spawn('python3', ['-c', pyCode, STREAM_PY], {stdio: ['pipe', 'pipe', 'pipe']})
			},
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'output'})
		await new Promise((r) => setTimeout(r, 300))

		assert.equal(sent.length, 2, `expected meta + keyframe from real Python FrameWriter, got ${sent.length}`)
		const meta = JSON.parse(sent[0].data)
		assert.equal(meta.type, 'meta')
		assert.equal(meta.width, 1920)
		assert.equal(meta.height, 1200)
		assert.equal(sent[1].binary, true)
		const payload = sent[1].data
		assert.equal(payload[0], 1, 'isKey flag')
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
		const ts = view.getUint32(1, false) * 4294967296 + view.getUint32(5, false)
		assert.equal(ts, 12345678, 'big-endian 64-bit timestamp must match browser DataView decode')
		assert.deepEqual([...payload.subarray(9)], [0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x28])
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('session lock status is pushed to active streams and cleared on notifyUnlocked', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-lock-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		let locked = true
		const focused = []
		const fakeChild = new EventEmitter()
		fakeChild.stdin = new PassThrough()
		fakeChild.stdout = new PassThrough()
		fakeChild.stderr = new PassThrough()
		fakeChild.killed = false
		fakeChild.kill = () => {
			fakeChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent'),
			async exec(cmd, args) {
				if (cmd === 'ffmpeg' || cmd === 'python3') return {ok: true, stdout: 'ok', stderr: ''}
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'activewindow') return {ok: true, stdout: locked ? '{}' : JSON.stringify({address: '0x55a1b2c3d4e0'}), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: JSON.stringify([{id: 0, name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1200, scale: 1, activeWorkspace: {id: 1}}]), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'App', class: 'app', workspace: {id: 1}, at: [10, 10], size: [800, 600], mapped: true, floating: true}]), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'eval') {
					if (args[1].includes('hl.dsp.focus')) focused.push(args[1])
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				return {ok: false, stdout: '', stderr: ''}
			},
			spawnImpl: () => fakeChild,
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data) => sent.push(JSON.parse(data))
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'window', address: '0x55a1b2c3d4e0'})
		await new Promise((r) => setTimeout(r, 40))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === true), 'initial locked state must be reported to viewer')

		locked = false
		await hypr.notifyUnlocked()
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === false), 'notifyUnlocked must broadcast unlocked state')
		assert.ok(focused.length >= 1, 'notifyUnlocked should re-focus active window streams')

		fakeWs.emit('close')
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('omarchyd hyprland RPC routes enforce owner-only authorization', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-http-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	let d
	try {
		await mkdir(home, {recursive: true})
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')

		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))

		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			updaterOptions: {autoCheck: false, installerCheck: true},
			hyprlandOptions: {
				runtimeDir: root,
				vaapiDevice: join(root, 'nonexistent'),
				async exec(cmd, args) {
					if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'Demo', class: 'demo', workspace: {id: 1}, at: [0, 0], size: [640, 480], mapped: true}]), stderr: ''}
					return {ok: false, stdout: '', stderr: ''}
				},
			},
		})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			const body = await r.json()
			return {authorization: `Bearer ${body.result.data.accessToken}`}
		}
		const owner = await login('owner')
		const member = await login('member')

		assert.equal((await fetch(`${d.url}/trpc/hyprland.status`, {headers: member})).status, 403)
		assert.equal((await fetch(`${d.url}/trpc/hyprland.windows`, {headers: member})).status, 403)
		assert.equal((await fetch(`${d.url}/trpc/hyprland.status`, {headers: owner})).status, 200)
	} finally {
		if (d) await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('cursor shape events (msgType 4) and unlock_check probes flow cleanly over the stream WebSocket', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-cur-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		let locked = true
		let remoteUnlockCount = 0
		let fakeChild
		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			vaapiDevice: join(root, 'nonexistent'),
			onRemoteUnlock: () => {
				remoteUnlockCount++
			},
			async exec(cmd, args) {
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: locked ? ['LOCK'] : []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'Chrome', class: 'google-chrome', workspace: {id: 11}, at: [0, 0], size: [1200, 800], mapped: true}]), stderr: ''}
				}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				fakeChild = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
					},
				})
				return fakeChild
			},
		})
		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data) {
				if (typeof data === 'string') sent.push(JSON.parse(data))
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60})
		const curPayload = Buffer.from(JSON.stringify({cursor: 'pointer'}), 'utf8')
		const hdr = Buffer.alloc(5)
		hdr[0] = 4
		hdr.writeUInt32BE(curPayload.length, 1)
		fakeChild.stdout.write(Buffer.concat([hdr, curPayload]))
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(sent.some((m) => m.type === 'cursor' && m.cursor === 'pointer'))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === true))

		locked = false
		ws.emit('message', Buffer.from(JSON.stringify({type: 'unlock_check'})), false)
		await new Promise((r) => setTimeout(r, 420))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === false))
		assert.equal(remoteUnlockCount, 1, 'remote unlock while viewer is connected must arm Lock-after-viewing-remotely')

		locked = true
		ws.emit('message', Buffer.from(JSON.stringify({type: 'unlock_check'})), false)
		await new Promise((r) => setTimeout(r, 420))
		assert.ok(sent.filter((m) => m.type === 'lock' && m.locked === true).length >= 2)
		locked = false
		ws.close()
		await new Promise((r) => setTimeout(r, 60))
		assert.equal(remoteUnlockCount, 2, 'unlock observed on last-viewer disconnect must arm relock')

		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('full binary input fast paths (0x10/0x11/0x12/0x13), focus-delayed drag ordering, EPIPE safety, and SIGKILL escalation', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-bin-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-capture')
		await writeFile(fakeBin, '#!/bin/sh\n')

		const stdinChunks = []
		const killSignals = []
		let focusRelease = null
		let modeScenario = 'stream'
		let lastChild = null

		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'App', class: 'app', workspace: {id: 11}, at: [0, 0], size: [1200, 800], mapped: true}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'eval' && args[1].includes('hl.dsp.focus') && focusRelease) {
					await focusRelease
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				const ch = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill(sig) {
						this.killed = true
						killSignals.push(sig || 'SIGTERM')
						if (modeScenario !== 'sigkill' || sig === 'SIGKILL') {
							this.exitCode = 0
							setImmediate(() => {
								this.emit('exit', 0, sig || null)
								this.emit('close', 0, sig || null)
							})
						}
					},
				})
				lastChild = ch
				ch.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))
				return ch
			},
		})

		const st = await hypr.procedures['hyprland.status'].run()
		assert.equal(st.sessionLocked, false)

		let unlockFocus
		focusRelease = new Promise((r) => (unlockFocus = r))
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60, bitrate: 16000, codec: 'hevc', quality: 20, compression: 5})

		const mkMove = (ux, uy) => {
			const b = Buffer.alloc(5)
			b[0] = 0x10
			b.writeUInt16BE(ux, 1)
			b.writeUInt16BE(uy, 3)
			return b
		}
		const mkBtn = (btnOff, down, ux, uy) => {
			const b = Buffer.alloc(7)
			b[0] = 0x11
			b[1] = btnOff
			b[2] = down
			b.writeUInt16BE(ux, 3)
			b.writeUInt16BE(uy, 5)
			return b
		}
		const mkScroll = (dx256, dy256) => {
			const b = Buffer.alloc(9)
			b[0] = 0x12
			b.writeInt32BE(dx256, 1)
			b.writeInt32BE(dy256, 5)
			return b
		}
		const mkKey = (code, down, mods) => Buffer.from([0x13, code, down, mods])

		// Binary button-down triggers focus switch; drag moves coalesce behind it; scroll + key follow cleanly
		ws.emit('message', mkBtn(0, 1, 6554, 6554), true)
		ws.emit('message', mkMove(10000, 10000), true)
		ws.emit('message', mkMove(32768, 16384), true)
		ws.emit('message', mkScroll(0, 512), true)
		ws.emit('message', mkKey(28, 1, 4), true)
		unlockFocus()
		await new Promise((r) => setTimeout(r, 40))

		const joined = stdinChunks.join('')
		const btnIdx = joined.indexOf('B 272 1 6554 6554\n')
		const moveIdx = joined.indexOf('M 32768 16384\n')
		const scrollIdx = joined.indexOf('S 0 512\n')
		const keyIdx = joined.indexOf('K 28 1 4\n')
		assert.ok(btnIdx >= 0 && moveIdx > btnIdx, `binary button-down must precede coalesced drag move, got:\n${joined}`)
		assert.ok(!joined.includes('M 10000 10000'), 'intermediate drag move during focus stall should coalesce')
		assert.ok(scrollIdx > moveIdx && keyIdx > scrollIdx, `scroll and key must preserve FIFO order, got:\n${joined}`)

		// Async EPIPE on child.stdin must be handled cleanly without uncaught exception
		lastChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}))
		ws.close()

		// Worker ignoring SIGTERM must be escalated to SIGKILL
		modeScenario = 'sigkill'
		killSignals.length = 0
		const ws2 = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws2, {mode: 'output', output: 'RAIL-1', fps: 60})
		ws2.close()
		await new Promise((r) => setTimeout(r, 1650))
		assert.ok(killSignals.includes('SIGTERM') && killSignals.includes('SIGKILL'), `expected SIGTERM then SIGKILL escalation, got: ${killSignals}`)

		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('native C capture engine compiles cleanly with -Wall -Wextra -Werror when Linux VA-API headers are present', async (t) => {
	const pkgs = ['gbm', 'libdrm', 'libva', 'libva-drm', 'libavcodec', 'libavfilter', 'libavutil']
	try {
		execFileSync('gcc', ['--version'], {stdio: 'ignore'})
		execFileSync('pkg-config', ['--exists', ...pkgs], {stdio: 'ignore'})
	} catch {
		t.skip('gcc + Linux gbm/libdrm/libva/libavcodec pkg-config packages not present on this host')
		return
	}
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-c-'))
	try {
		const flags = execFileSync('pkg-config', ['--cflags', '--libs', ...pkgs], {encoding: 'utf8'}).trim().split(/\s+/)
		const out = join(dir, 'hypr-rail-capture')
		execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', '-pthread', RAIL_C, '-o', out, ...flags], {stdio: 'pipe'})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
