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
import {backpressureBudgets, createFrameReader, createHyprland, isPcmSilent} from '../omarchyd/hyprland.mjs'
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

test('backpressureBudgets stays tight on WAN bitrates and scales up cleanly for 100+ Mbps LAN streams', () => {
	const wan = backpressureBudgets(16000)
	const high = backpressureBudgets(45000)
	const ultra = backpressureBudgets(100000)
	assert.equal(wan.deltaDropBytes, 500_000)
	assert.ok(high.deltaDropBytes > 1_200_000, '45 Mbps should absorb 685 KB keyframes')
	assert.ok(ultra.deltaDropBytes >= 3_000_000, '100 Mbps LAN should absorb 1.7 MiB near-lossless 4K keyframes without false delta drops')
	assert.ok(ultra.hardDropBytes > ultra.deltaDropBytes * 2)
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
		const deadline = Date.now() + 3000
		while (sent.length < 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20))
		}

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

test('live zero-reconnect reconfig, RTT 0x14/0x04 ping-pong, msgType 5 telemetry, and 10ms Opus 0x03 with PCM fallback', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-r2-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-capture')
		await writeFile(fakeBin, '#!/bin/sh\n')

		let videoChild = null
		let opusChild = null
		let parecCount = 0
		const stdinChunks = []
		const spawned = []

		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl(cmd, args) {
				spawned.push({cmd, args})
				const ch = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
						this.exitCode = 0
					},
				})
				if (cmd === 'parec') {
					parecCount++
					return ch
				}
				if (args.includes('--opus-stdin')) {
					opusChild = ch
					return ch
				}
				videoChild = ch
				ch.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))
				return ch
			},
		})

		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data, opts) {
				sent.push({data, binary: !!opts?.binary})
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})

		await hypr.attachStream(ws, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 20000, codec: 'hevc444', audio: true, audioCodec: 'opus'})
		assert.ok(spawned.some((s) => s.args.includes('hevc444')), 'should forward hevc444 codec flag')
		assert.ok(opusChild, 'should spawn --opus-stdin encoder when audioCodec=opus')

		// Emit framed Opus packet ([u16be len][payload]) -> must forward as binary 0x03
		const fakeOpus = Buffer.from([0xf8, 0x11, 0x22, 0x33, 0x44])
		const opusHdr = Buffer.alloc(2)
		opusHdr.writeUInt16BE(fakeOpus.length, 0)
		opusChild.stdout.write(Buffer.concat([opusHdr, fakeOpus]))

		// Emit msgType 5 telemetry JSON -> must forward as {type:'stats', ...}
		videoChild.stdout.write(framePacket(5, Buffer.from(JSON.stringify({encMs: 10.4, encP95Ms: 11.3, mbps: 42.1, polish: 2, roi: 9, slices: 4}))))

		// Send 9-byte binary RTT ping (0x14) -> immediate 9-byte 0x04 pong echo with identical payload
		const ping = Buffer.alloc(9)
		ping[0] = 0x14
		ping.writeDoubleBE(1234.5, 1)
		ws.emit('message', ping, true)

		// Send zero-reconnect live reconfig -> forwards R <bitrate> <quality> <codec> and raises backpressure budget to 100 Mbps
		ws.emit('message', JSON.stringify({type: 'reconfig', bitrate: 100000, quality: 12, codec: 'hevc444'}), false)
		ws.bufferedAmount = 1_800_000 // > 20 Mbps delta cap, but well under 100 Mbps delta cap (~3.1 MB)
		const deltaPayload = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x02, 0x01])])
		videoChild.stdout.write(framePacket(2, deltaPayload))

		await new Promise((r) => setTimeout(r, 40))

		const opusPkt = sent.find((m) => m.binary && m.data[0] === 0x03)
		assert.ok(opusPkt && opusPkt.data.length === 1 + fakeOpus.length, 'should forward 0x03 Opus packet')
		const pongPkt = sent.find((m) => m.binary && m.data[0] === 0x04)
		assert.ok(pongPkt && pongPkt.data.length === 9 && pongPkt.data.readDoubleBE(1) === 1234.5, 'should echo 0x04 RTT pong immediately')
		const statsMsg = sent.find((m) => !m.binary && JSON.parse(m.data).type === 'stats')
		assert.ok(statsMsg && JSON.parse(statsMsg.data).slices === 4, 'should forward msgType 5 telemetry stats')
		assert.ok(stdinChunks.join('').includes('R 100000 12 hevc444\n'), 'reconfig should write compact R line to capture stdin')
		assert.ok(sent.some((m) => m.binary && m.data[0] === 0), 'live reconfig to 100 Mbps should raise backpressure budget immediately')

		// Simulate --opus-stdin exiting with code 2 (missing libopus.so.0) -> must fall back cleanly to parec 20ms PCM
		opusChild.exitCode = 2
		opusChild.emit('exit', 2, null)
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(parecCount >= 2, 'missing libopus.so.0 exit(2) must fall back transparently to PCM parec')

		ws.close()
		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('session revocation closes active streams, lock probe failure does not invent unlock, double congestion recovers, and Python AU framing assembles multi-slice pictures', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-hard-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	let d
	try {
		await mkdir(home, {recursive: true})
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-cap')
		await writeFile(fakeBin, '#!/bin/sh\n')

		// 1. Lock probe failure (hyprctl error) must NOT invent an unlock or invoke onRemoteUnlock
		let lockMode = 'locked'
		let remoteUnlockCount = 0
		const stdinLines = []
		let capChild = null
		const hypr = createHyprland({
			dataDir: join(root, 'd1'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			onRemoteUnlock: () => remoteUnlockCount++,
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					if (lockMode === 'error') return {ok: false, stdout: '', stderr: 'socket busy'}
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: lockMode === 'locked' ? ['LOCK'] : []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				capChild = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
						this.exitCode = 0
					},
				})
				capChild.stdin.on('data', (c) => stdinLines.push(c.toString('utf8')))
				return capChild
			},
		})
		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data, opts) {
				sent.push({data, binary: !!opts?.binary})
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 10000})
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(sent.some((m) => !m.binary && JSON.parse(m.data).type === 'lock' && JSON.parse(m.data).locked === true))
		lockMode = 'error'
		ws.emit('message', JSON.stringify({type: 'unlock_check'}), false)
		await new Promise((r) => setTimeout(r, 360))
		assert.equal(remoteUnlockCount, 0, 'failed lock probe must not invent a remote unlock')
		assert.ok(!sent.some((m) => !m.binary && JSON.parse(m.data).type === 'lock' && JSON.parse(m.data).locked === false))

		// 2. Two congestion episodes inside one 1500ms cooldown must still schedule and emit a recovery keyframe without extra frames arriving
		const delta = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x41, 0x9a])])
		const key = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x65, 0x88])])
		ws.bufferedAmount = 512 * 1024
		capChild.stdout.write(framePacket(2, delta))
		ws.bufferedAmount = 0
		capChild.stdout.write(framePacket(2, delta)) // triggers immediate 1st 'F\n'
		capChild.stdout.write(framePacket(2, key)) // recovers 1st drop
		ws.bufferedAmount = 512 * 1024
		capChild.stdout.write(framePacket(2, delta)) // 2nd congestion inside 1500ms cooldown!
		ws.bufferedAmount = 0 // socket drains, no more video frames arrive (static desktop)
		await new Promise((r) => setTimeout(r, 1700))
		const fCount = stdinLines.join('').split('\n').filter((l) => l === 'F').length
		assert.ok(fCount >= 2, `expected scheduled 2nd recovery keyframe after cooldown, got ${fCount}`)
		// Calling synchronous __omarchyRevoke must immediately block subsequent input before the 'close' event even fires
		const beforeRevokeCount = stdinLines.join('').length
		let closeCalled = false
		ws.close = () => {
			closeCalled = true
		}
		ws.__omarchyRevoke(1008, 'Session ended')
		assert.equal(closeCalled, true)
		ws.emit('message', Buffer.from([0x13, 28, 1, 0]), true)
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(stdinLines.join('').length, beforeRevokeCount, 'synchronous revoke must discard input immediately before close event')

		// 2b. Final lock probe transient failure on disconnect must retry and still arm remote unlock
		lockMode = 'locked'
		const wsRetry = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(wsRetry, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 10000})
		await new Promise((r) => setTimeout(r, 30))
		// Transient error on first disconnect probe, then unlocked on retry!
		lockMode = 'error'
		setTimeout(() => {
			lockMode = 'unlocked'
		}, 120)
		wsRetry.close()
		await new Promise((r) => setTimeout(r, 520))
		assert.equal(remoteUnlockCount, 1, 'final disconnect lock probe must retry across unknown result and still arm remote unlock')
		hypr.close()

		// 3. Python _read_loop assembles multi-slice NALs into 1 Access Unit per picture, flushes at clean EOF,
		//    discards partial pictures on cancellation, and validates SHM layouts strictly
		const pyOut = execFileSync(
			'python3',
			[
				'-c',
				`
import importlib.util, io, sys
spec = importlib.util.spec_from_file_location("hs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# Two slices for picture 1 (IDR: slice1 first_mb=0 0x88, slice2 first_mb>0 0x01) + AUD + picture 2 (P-frame, 2 slices)
bitstream = (
    b"\\x00\\x00\\x00\\x01\\x67\\x42\\xe0\\x28"
    b"\\x00\\x00\\x00\\x01\\x68\\xce\\x38\\x80"
    b"\\x00\\x00\\x00\\x01\\x65\\x88\\x01\\x02"
    b"\\x00\\x00\\x00\\x01\\x65\\x01\\x03\\x04"
    b"\\x00\\x00\\x00\\x01\\x09\\x30"
    b"\\x00\\x00\\x00\\x01\\x41\\x9a\\x05\\x06"
    b"\\x00\\x00\\x00\\x01\\x41\\x01\\x07\\x08"
)
out = []
class W:
    def send_video(self, is_key, ts, data):
        out.append((is_key, len(data)))
enc = object.__new__(mod.H264Encoder)
enc.stop_event = __import__("threading").Event()
enc.writer = W()
enc.proc = type("P", (), {"stdout": io.BytesIO(bitstream)})()
enc._read_loop()

# Cancelled mid-IDR must NOT emit a truncated keyframe
out2 = []
class W2:
    def send_video(self, is_key, ts, data):
        out2.append((is_key, len(data)))
class CancellingStream:
    def __init__(self, ev):
        self.ev = ev
        self.done = False
    def read(self, _n):
        if self.done:
            return b""
        self.done = True
        self.ev.set()
        return b"\\x00\\x00\\x00\\x01\\x65\\x88\\x01\\x02"
ev2 = __import__("threading").Event()
enc2 = object.__new__(mod.H264Encoder)
enc2.stop_event = ev2
enc2.writer = W2()
enc2.proc = type("P", (), {"stdout": CancellingStream(ev2)})()
enc2._read_loop()

# SHM layout allowlist & bounds
shm_ok = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 1920, 1080, 1920 * 4)
shm_bad_fmt = mod.is_valid_shm_layout(0x36314752, 1920, 1080, 1920 * 4)
shm_bad_stride = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 1920, 1080, 100)
shm_bad_size = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 8192, 8192, 0x40000000)
print(len(out), out[0][0], out[1][0], len(out2), shm_ok, shm_bad_fmt, shm_bad_stride, shm_bad_size)
`,
				STREAM_PY,
			],
			{encoding: 'utf8'},
		).trim()
		assert.equal(pyOut, '2 True False 0 True False False False', `unexpected Python AU/cancellation/SHM validation result: ${pyOut}`)

		// 4. omarchyd user.logout immediately revokes outstanding tickets and closes an active /hyprland/stream socket
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
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
					if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
					return {ok: true, stdout: 'ok', stderr: ''}
				},
				spawnImpl() {
					return Object.assign(new EventEmitter(), {
						stdin: new PassThrough(),
						stdout: new PassThrough(),
						stderr: new PassThrough(),
						killed: false,
						exitCode: null,
						kill() {
							this.killed = true
							this.exitCode = 0
						},
					})
				},
			},
		})
		const loginRes = await fetch(`${d.url}/trpc/user.loginNative`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 'dev-1'}}),
		})
		const tok = (await loginRes.json()).result.data.accessToken
		const authHdr = {authorization: `Bearer ${tok}`, 'content-type': 'application/json'}
		const t1 = (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: authHdr, body: JSON.stringify({target: 'hyprland'})})).json()).result.data
		const t2 = (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: authHdr, body: JSON.stringify({target: 'hyprland'})})).json()).result.data

		const {WebSocket} = await import('ws')
		const wsUrl = d.url.replace(/^http/, 'ws')
		const liveWs = new WebSocket(`${wsUrl}/hyprland/stream?mode=output&ticket=${encodeURIComponent(t1)}`)
		await new Promise((resolve, reject) => {
			liveWs.once('open', resolve)
			liveWs.once('error', reject)
		})
		const closedP = new Promise((resolve) => liveWs.once('close', (code) => resolve(code)))
		await fetch(`${d.url}/trpc/user.logout`, {method: 'POST', headers: authHdr, body: '{}'})
		const closeCode = await Promise.race([closedP, new Promise((r) => setTimeout(() => r(-1), 2000))])
		assert.equal(closeCode, 1008, 'user.logout must immediately close active /hyprland/stream sockets')

		// Outstanding unused ticket t2 from the revoked session must be rejected (401)
		const rejectedStatus = await new Promise((resolve) => {
			const wsBad = new WebSocket(`${wsUrl}/hyprland/stream?mode=output&ticket=${encodeURIComponent(t2)}`)
			wsBad.once('unexpected-response', (_req, res) => {
				res.resume()
				resolve(res.statusCode)
			})
			wsBad.once('open', () => {
				wsBad.close()
				resolve(200)
			})
			wsBad.once('error', () => {})
		})
		assert.equal(rejectedStatus, 401, 'revoked session ticket must be rejected with 401')
	} finally {
		if (d) await d.close()
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
		execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', '-pthread', RAIL_C, '-o', out, ...flags, '-ldl'], {stdio: 'pipe'})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
