// Direct 60 FPS GPU Hyprland capture & WebCodecs streamer (owner-only).
//
// Capabilities:
//   - Zero-copy 60 FPS GPU DMA-BUF -> VA-API H.264/HEVC/AV1 C engine (`hypr-rail-capture.c`, auto-built once on demand,
//     with transparent fallback to `hypr-stream.py` on hosts without gcc/VA-API headers).
//   - Dedicated headless 60 Hz output (`RAIL-1`) so streams render at 60 FPS even when the physical display is asleep.
//   - Dual Hyprland 0.57+ Lua (`hyprctl eval`) + legacy `hyprctl dispatch` window control (focus, resize, close, workspace).
//   - Silence-gated low-latency PipeWire audio, native cursor shape forwarding, full binary input fast paths, and
//     session lock-state reporting wired into Lock-after-viewing-remotely.
import {execFile, spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {access, chmod, mkdir, readFile, readdir, rename, rm, stat} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {RpcError} from './rpc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM_SCRIPT = join(HERE, 'hypr-stream.py')
const CAPTURE_SOURCE = join(HERE, 'hypr-rail-capture.c')
const ADDRESS_RE = /^0x[0-9a-f]{4,16}$/i
const OUTPUT_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/
const MAX_STREAMS = 12
const RAIL_OUTPUT = 'RAIL-1'

// O(1)-amortized chunk queue for framed stdout streams ([u8 type][u32be len][payload]), avoiding O(N^2) Buffer.concat and Array.shift().
export function createFrameReader() {
	let chunks = []
	let headIdx = 0
	let headOff = 0
	let total = 0

	const advanceHead = () => {
		headIdx++
		headOff = 0
		if (headIdx >= chunks.length) {
			chunks = []
			headIdx = 0
		} else if (headIdx >= 64 && headIdx * 2 >= chunks.length) {
			chunks = chunks.slice(headIdx)
			headIdx = 0
		}
	}

	const consume = (n) => {
		if (n <= 0) return Buffer.alloc(0)
		const first = chunks[headIdx]
		if (first && first.length - headOff >= n) {
			const out = first.subarray(headOff, headOff + n)
			headOff += n
			total -= n
			if (headOff >= first.length) advanceHead()
			return out
		}
		const out = Buffer.allocUnsafe(n)
		let written = 0
		while (written < n && headIdx < chunks.length) {
			const cur = chunks[headIdx]
			const avail = cur.length - headOff
			const take = Math.min(avail, n - written)
			cur.copy(out, written, headOff, headOff + take)
			written += take
			headOff += take
			total -= take
			if (headOff >= cur.length) advanceHead()
		}
		return out
	}

	const peekHeader = () => {
		const first = chunks[headIdx]
		if (first && first.length - headOff >= 5) {
			return {type: first[headOff], len: first.readUInt32BE(headOff + 1)}
		}
		const hdr = Buffer.allocUnsafe(5)
		let filled = 0
		for (let i = headIdx; i < chunks.length && filled < 5; i++) {
			const c = chunks[i]
			const off = i === headIdx ? headOff : 0
			const take = Math.min(c.length - off, 5 - filled)
			c.copy(hdr, filled, off, off + take)
			filled += take
		}
		return {type: hdr[0], len: hdr.readUInt32BE(1)}
	}

	return {
		push(chunk) {
			if (!chunk || chunk.length === 0) return
			chunks.push(chunk)
			total += chunk.length
		},
		drain(onFrame, maxLen = 16 * 1024 * 1024) {
			while (total >= 5) {
				const {type, len} = peekHeader()
				if (len > maxLen) return false
				if (total < 5 + len) break
				consume(5)
				const payload = consume(len)
				onFrame(type, payload)
			}
			return true
		},
		clear() {
			chunks = []
			headIdx = 0
			headOff = 0
			total = 0
		},
	}
}

// Fast silence detector for 16-bit signed little-endian stereo PCM (threshold ~ -66 dBFS).
export function isPcmSilent(buf, threshold = 16) {
	const limit = buf.length - 1
	for (let i = 0; i < limit; i += 2) {
		const s = buf.readInt16LE(i)
		if (s > threshold || s < -threshold) return false
	}
	return true
}

// Bitrate-proportional WebSocket backpressure ceilings (~250 ms budget):
// stays tight on WAN (384 KiB at 16 Mbps) while giving high-bitrate LAN (80-120 Mbps, 1.5+ MiB near-lossless 4K keyframes) headroom without false drops.
export function backpressureBudgets(bitrateKbps = 22000) {
	const kbps = Math.max(1000, Math.min(150000, Math.round(Number(bitrateKbps) || 22000)))
	const deltaDropBytes = Math.max(384 * 1024, Math.min(4 * 1024 * 1024, Math.round(((kbps * 1000) / 8) * 0.25)))
	const hardDropBytes = Math.max(1536 * 1024, deltaDropBytes * 4)
	const keyDrainBytes = Math.max(64 * 1024, Math.round(deltaDropBytes / 4))
	return {deltaDropBytes, hardDropBytes, keyDrainBytes}
}

const exists = (p) => access(p).then(() => true, () => false)

function execOut(cmd, args, {env, timeout = 5000, input = null} = {}) {
	return new Promise((resolveDone) => {
		const child = execFile(cmd, args, {env, timeout, maxBuffer: 4 * 1024 * 1024}, (err, stdout, stderr) => {
			resolveDone({ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '')})
		})
		if (input != null && child.stdin) {
			child.stdin.on('error', () => {})
			child.stdin.end(input)
		}
	})
}

export function createHyprland({
	dataDir = join(os.tmpdir(), 'omarchy-hypr'),
	runtimeDir = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : ''),
	exec = execOut,
	spawnImpl = spawn,
	scriptPath = STREAM_SCRIPT,
	captureSource = CAPTURE_SOURCE,
	captureBin = null,
	vaapiDevice = '/dev/dri/renderD128',
	onRemoteUnlock = null,
} = {}) {
	const activeStreams = new Set()
	let pendingStreams = 0
	let rectSyncTimer = null
	let lastLockedState = null
	let lockProbeSeq = 0
	let lastAppliedLockSeq = 0
	let lastFocusedAddr = ''
	let compilePromise = null
	let compiledBin = captureBin || null
	let compileFailedAt = 0

	async function discoverEnv() {
		if (!runtimeDir) return null
		const entries = await readdir(runtimeDir).catch(() => [])
		const wlCands = []
		for (const f of entries) {
			if (!/^wayland-\d+$/.test(f)) continue
			const st = await stat(join(runtimeDir, f)).catch(() => null)
			if (st) wlCands.push({f, mtime: st.mtimeMs})
		}
		wlCands.sort((a, b) => b.mtime - a.mtime)
		const wayland = wlCands[0]?.f
		const hyprDir = join(runtimeDir, 'hypr')
		const sigs = await readdir(hyprDir).catch(() => [])
		let sig = process.env.HYPRLAND_INSTANCE_SIGNATURE || ''
		if (!sig || !sigs.includes(sig)) {
			// Pick the newest live Hyprland instance (stale dirs from prior crashed sessions can leave old .socket.sock files behind)
			const live = []
			for (const cand of sigs) {
				const st = await stat(join(hyprDir, cand, '.socket.sock')).catch(() => null)
				if (st) live.push({cand, mtime: st.mtimeMs})
			}
			live.sort((a, b) => b.mtime - a.mtime)
			if (live.length) sig = live[0].cand
		}
		if (!wayland && !sig) return null
		return {
			...process.env,
			XDG_RUNTIME_DIR: runtimeDir,
			...(wayland ? {WAYLAND_DISPLAY: wayland} : {}),
			...(sig ? {HYPRLAND_INSTANCE_SIGNATURE: sig} : {}),
		}
	}

	async function hyprctl(args) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
		}
		const r = await exec('hyprctl', args, {env, timeout: 4000})
		if (!r.ok) throw new RpcError('BAD_GATEWAY', `hyprctl failed: ${r.stderr.trim() || 'no response'}`)
		return r.stdout
	}

	// Run a Hyprland 0.57+ Lua eval with automatic fallback to legacy `hyprctl dispatch` for older Hyprland releases.
	async function hyprDispatch(luaExpr, legacyArgs) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session isn’t running right now')
		}
		if (luaExpr) {
			const r = await exec('hyprctl', ['eval', luaExpr], {env, timeout: 4000})
			if (r.ok && r.stdout.trim() === 'ok') return r.stdout
		}
		if (legacyArgs?.length) {
			const r2 = await exec('hyprctl', legacyArgs, {env, timeout: 4000})
			const out2 = r2.stdout.trim()
			if (r2.ok && (!out2 || out2 === 'ok')) return r2.stdout
			throw new RpcError('BAD_GATEWAY', `hyprctl failed: ${r2.stderr.trim() || out2 || 'no response'}`)
		}
		throw new RpcError('BAD_GATEWAY', 'Hyprland dispatch failed')
	}

	// Auto-build the zero-copy 60 FPS DMA-BUF/VA-API C capture engine once into <dataDir>/bin/hypr-rail-capture-<sha12>.
	async function ensureCaptureBinary() {
		if (compiledBin && (await exists(compiledBin))) return compiledBin
		if (compileFailedAt && Date.now() - compileFailedAt < 5 * 60_000) return null
		if (compilePromise) return compilePromise
		compilePromise = (async () => {
			if (!(await exists(captureSource)) || !(await exists(vaapiDevice))) {
				compileFailedAt = Date.now()
				return null
			}
			const srcBytes = await readFile(captureSource).catch(() => null)
			if (!srcBytes) {
				compileFailedAt = Date.now()
				return null
			}
			const hash = createHash('sha256').update(srcBytes).digest('hex').slice(0, 12)
			const binDir = join(dataDir, 'bin')
			const outBin = join(binDir, `hypr-rail-capture-${hash}`)
			const binSt = await stat(outBin).catch(() => null)
			if (binSt && binSt.size > 8192) {
				compiledBin = outBin
				return outBin
			}
			const pkg = await exec('pkg-config', ['--cflags', '--libs', 'gbm', 'libva', 'libva-drm', 'libavcodec', 'libavfilter', 'libavutil', 'libdrm'], {timeout: 4000})
			if (!pkg.ok) {
				compileFailedAt = Date.now()
				return null
			}
			await mkdir(binDir, {recursive: true, mode: 0o700})
			const flags = pkg.stdout.trim().split(/\s+/).filter(Boolean)
			const tmpBin = `${outBin}.${process.pid}.tmp`
			const cc = await exec('gcc', ['-O2', '-pthread', captureSource, '-o', tmpBin, ...flags, '-ldl'], {timeout: 30_000})
			if (!cc.ok) {
				await rm(tmpBin, {force: true}).catch(() => {})
				compileFailedAt = Date.now()
				return null
			}
			await chmod(tmpBin, 0o755)
			await rename(tmpBin, outBin)
			// Clean up older hashed binaries in binDir
			for (const f of await readdir(binDir).catch(() => [])) {
				if (f.startsWith('hypr-rail-capture-') && f !== `hypr-rail-capture-${hash}`) {
					await rm(join(binDir, f), {force: true}).catch(() => {})
				}
			}
			compiledBin = outBin
			return outBin
		})().finally(() => {
			compilePromise = null
		})
		return compilePromise
	}

	async function monitorsInfo() {
		try {
			const raw = await hyprctl(['monitors', '-j'])
			return JSON.parse(raw || '[]').map((m) => ({
				id: m.id,
				name: String(m.name ?? ''),
				x: Number(m.x) || 0,
				y: Number(m.y) || 0,
				width: Number(m.width) || 0,
				height: Number(m.height) || 0,
				scale: Number(m.scale) || 1,
				refreshRate: Math.round(Number(m.refreshRate) || 60),
				dpmsStatus: m.dpmsStatus !== false,
				activeWorkspace: m.activeWorkspace?.id ?? 1,
				reserved: Array.isArray(m.reserved) && m.reserved.length === 4 ? m.reserved.map((n) => Number(n) || 0) : [0, 0, 0, 0],
				locked: Array.isArray(m.solitaryBlockedBy) && m.solitaryBlockedBy.includes('LOCK'),
				hasLockInfo: Array.isArray(m.solitaryBlockedBy),
			}))
		} catch {
			return []
		}
	}

	// Compute the global logical coordinate bounding box across all Hyprland monitors (for pointer_move/button mapping).
	function layoutBounds(mons) {
		if (!mons.length) return {lx: 0, ly: 0, lw: 1920, lh: 1080}
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		for (const m of mons) {
			const sc = m.scale > 0 ? m.scale : 1
			const lw = Math.round(m.width / sc)
			const lh = Math.round(m.height / sc)
			if (m.x < minX) minX = m.x
			if (m.y < minY) minY = m.y
			if (m.x + lw > maxX) maxX = m.x + lw
			if (m.y + lh > maxY) maxY = m.y + lh
		}
		return {lx: minX, ly: minY, lw: Math.max(1, maxX - minX), lh: Math.max(1, maxY - minY)}
	}

	// Wake the headless RAIL-1 monitor without lighting up physical displays (eDP-1 stays dark/asleep).
	async function wakeRailOutput() {
		await hyprDispatch(
			`hl.dispatch(hl.dsp.dpms({state = "on", monitor = "${RAIL_OUTPUT}"}))`,
			['dispatch', 'dpms', 'on', RAIL_OUTPUT],
		).catch(() => {})
	}

	// Ensure a dedicated headless 60 Hz output (`RAIL-1`) exists at 3840x2160@60 scale=1 and is awake even when the physical display is asleep.
	// Note: RAIL-1 is kept persistently for the session rather than torn down when idle; removing a headless output on a lid-closed laptop triggers clamshell monitor watchers.
	async function ensureRailOutput() {
		let mons = await monitorsInfo()
		let rail = mons.find((m) => m.name === RAIL_OUTPUT)
		if (!rail) {
			const env = await discoverEnv()
			if (!env?.HYPRLAND_INSTANCE_SIGNATURE) return null
			await exec('hyprctl', ['output', 'create', 'headless', RAIL_OUTPUT], {env, timeout: 4000})
			await new Promise((r) => setTimeout(r, 250))
			await hyprDispatch(
				`hl.monitor({output = "${RAIL_OUTPUT}", mode = "3840x2160@60", position = "auto", scale = 1})`,
				['keyword', 'monitor', `${RAIL_OUTPUT},3840x2160@60,auto,1`],
			).catch(() => {})
			await new Promise((r) => setTimeout(r, 150))
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT)
			if (rail) syncAllStreamRects().catch(() => {})
		} else if (rail.scale !== 1 || rail.width < 3840 || rail.height < 2160) {
			await hyprDispatch(
				`hl.monitor({output = "${RAIL_OUTPUT}", mode = "3840x2160@60", position = "auto", scale = 1})`,
				['keyword', 'monitor', `${RAIL_OUTPUT},3840x2160@60,auto,1`],
			).catch(() => {})
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT) ?? rail
			syncAllStreamRects().catch(() => {})
		}
		if (rail && !rail.dpmsStatus) {
			await wakeRailOutput()
			mons = await monitorsInfo()
			rail = mons.find((m) => m.name === RAIL_OUTPUT) ?? rail
		}
		return rail ?? null
	}

	// Size & position a floating window strictly inside RAIL-1's usable rect.
	async function placeOnRail(addr, reqW, reqH) {
		const rail = await ensureRailOutput().catch(() => null)
		const padL = rail?.reserved?.[0] ?? 0
		const padT = rail?.reserved?.[1] ?? 0
		const padR = rail?.reserved?.[2] ?? 0
		const padB = rail?.reserved?.[3] ?? 0
		const maxW = rail ? Math.max(360, Math.round(rail.width / (rail.scale || 1)) - padL - padR) : 3840
		const maxH = rail ? Math.max(260, Math.round(rail.height / (rail.scale || 1)) - padT - padB) : 2160
		const w = Math.max(240, Math.min(maxW, Math.round(Number(reqW) || 1100)))
		const h = Math.max(180, Math.min(maxH, Math.round(Number(reqH) || 740)))
		await hyprDispatch(
			`hl.dispatch(hl.dsp.window.resize({window = "address:${addr}", x = ${w}, y = ${h}, exact = true}))`,
			['dispatch', 'resizewindowpixel', `exact ${w} ${h},address:${addr}`],
		).catch(() => {})
		if (rail) {
			const tx = rail.x + padL
			const ty = rail.y + padT
			const env = await discoverEnv()
			if (env?.HYPRLAND_INSTANCE_SIGNATURE) {
				await exec('hyprctl', ['dispatch', 'movewindowpixel', `exact ${tx} ${ty},address:${addr}`], {env, timeout: 4000}).catch(() => {})
			}
		}
		return {w, h}
	}

	// Detect whether Wayland ext_session_lock_v1 (e.g. Omarchy shell lockscreen) is holding pointer/keyboard input.
	// Returns true (locked), false (unlocked), or null (unknown/probe failed) so transient hyprctl failures never fabricate an unlock.
	async function isSessionLocked() {
		try {
			const rawMons = await hyprctl(['monitors', '-j'])
			const parsedMons = JSON.parse(rawMons || '[]')
			if (!Array.isArray(parsedMons)) return null
			const mons = parsedMons.map((m) => ({
				locked: Array.isArray(m.solitaryBlockedBy) && m.solitaryBlockedBy.includes('LOCK'),
				hasLockInfo: Array.isArray(m.solitaryBlockedBy),
			}))
			if (mons.some((m) => m.locked)) return true
			// When Hyprland reports solitaryBlockedBy, trust it directly so an unlocked empty workspace is never misclassified as locked.
			if (mons.some((m) => m.hasLockInfo)) return false
			const wins = await windows({strict: true})
			if (!wins.length) return false
			const raw = await hyprctl(['activewindow', '-j'])
			const active = JSON.parse(raw || '{}')
			return !active || !active.address
		} catch {
			return null
		}
	}

	// ---- Status, Windows, Dispatch --------------------------------------------------------------
	async function status() {
		const env = await discoverEnv()
		const hasVaapi = await exists(vaapiDevice)
		// Never block the fast status RPC on a 10-30s cold gcc compile; kick off compile in background if needed.
		let hasNativeCapture = !!(compiledBin && (await exists(compiledBin)))
		if (!hasNativeCapture && env?.WAYLAND_DISPLAY && hasVaapi) {
			ensureCaptureBinary().catch(() => {})
		}
		const hasFfmpeg = hasNativeCapture || (await exec('ffmpeg', ['-version'], {timeout: 3000})).ok
		const hasPython = (await exec('python3', ['--version'], {timeout: 3000})).ok
		const available = !!(env?.WAYLAND_DISPLAY && env?.HYPRLAND_INSTANCE_SIGNATURE && (hasNativeCapture || (hasFfmpeg && hasPython)))
		const [monitors, rawLocked] = available ? await Promise.all([monitorsInfo(), isSessionLocked()]) : [[], false]
		const sessionLocked = rawLocked === true
		return {
			available,
			wayland: env?.WAYLAND_DISPLAY ?? null,
			vaapi: hasVaapi,
			nativeEngine: hasNativeCapture,
			sessionLocked,
			encoder: hasNativeCapture ? 'h264_vaapi_dmabuf' : hasVaapi ? 'h264_vaapi' : hasFfmpeg ? 'libx264' : null,
			monitors,
			activeStreams: activeStreams.size,
		}
	}

	async function windows({strict = false} = {}) {
		const env = await discoverEnv()
		if (!env?.HYPRLAND_INSTANCE_SIGNATURE) {
			if (strict) throw new RpcError('PRECONDITION_FAILED', 'Hyprland desktop session is unavailable')
			return []
		}
		const raw = await hyprctl(['clients', '-j'])
		const list = strict ? JSON.parse(raw) : JSON.parse(raw || '[]')
		if (!Array.isArray(list)) {
			if (strict) throw new RpcError('BAD_GATEWAY', 'Unexpected hyprctl clients response')
			return []
		}
		return list
			.filter((c) => c && c.mapped !== false && ADDRESS_RE.test(String(c.address ?? '')))
			.map((c) => ({
				address: String(c.address),
				title: String(c.title || c.initialTitle || c.class || 'Window').slice(0, 140),
				class: String(c.class || c.initialClass || '').slice(0, 80),
				workspace: Number(c.workspace?.id) || 1,
				at: Array.isArray(c.at) ? [Number(c.at[0]) || 0, Number(c.at[1]) || 0] : [0, 0],
				size: Array.isArray(c.size) ? [Number(c.size[0]) || 0, Number(c.size[1]) || 0] : [0, 0],
				floating: !!c.floating,
				fullscreen: !!c.fullscreen,
				pid: Number(c.pid) || 0,
			}))
			.sort((a, b) => a.workspace - b.workspace || a.title.localeCompare(b.title))
	}

	// Push updated window or monitor logical rect straight to live streams so pointer clicks stay pixel-perfect across multi-monitor layouts.
	function writeRectForEntry(entry, mons, wins) {
		const b = layoutBounds(mons)
		let rect = null
		if (entry.mode === 'window' && entry.address) {
			const w = wins.find((x) => x.address.toLowerCase() === entry.address.toLowerCase())
			if (w) rect = {x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1]}
		} else if (entry.mode === 'output') {
			const m = (entry.output ? mons.find((x) => x.name === entry.output) : null) ?? mons[0]
			if (m) {
				const sc = m.scale > 0 ? m.scale : 1
				rect = {x: m.x, y: m.y, w: Math.round(m.width / sc), h: Math.round(m.height / sc)}
			}
		}
		if (!rect) return
		const msg = JSON.stringify({type: 'win_rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, lx: b.lx, ly: b.ly, lw: b.lw, lh: b.lh}) + '\n'
		try {
			if (entry.child.stdin?.writable) entry.child.stdin.write(msg)
		} catch {}
	}

	async function syncStreamRect(address) {
		const target = String(address).toLowerCase()
		const matching = [...activeStreams].filter((s) => s.address && s.address.toLowerCase() === target)
		if (!matching.length) return
		const [mons, wins] = await Promise.all([monitorsInfo(), windows().catch(() => [])])
		for (const s of matching) writeRectForEntry(s, mons, wins)
	}

	async function syncAllStreamRects() {
		if (activeStreams.size === 0) return
		const [mons, wins] = await Promise.all([monitorsInfo(), windows().catch(() => [])])
		for (const s of [...activeStreams]) writeRectForEntry(s, mons, wins)
	}

	async function notifyUnlocked() {
		await new Promise((r) => setTimeout(r, 300))
		const seq = ++lockProbeSeq
		const locked = await isSessionLocked().catch(() => null)
		if (locked === null) return
		if (seq < lastAppliedLockSeq) return
		lastAppliedLockSeq = seq
		lastLockedState = locked
		for (const s of [...activeStreams]) {
			if (s.ws.readyState === s.ws.OPEN) {
				try {
					s.ws.send(JSON.stringify({type: 'lock', locked}))
				} catch {}
			}
		}
		if (!locked) {
			await wakeRailOutput()
			await syncAllStreamRects().catch(() => {})
			const lastWin = [...activeStreams].reverse().find((s) => s.mode === 'window' && s.address)
			if (lastWin) {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.focus({window = "address:${lastWin.address}"}))`,
					['dispatch', 'focuswindow', `address:${lastWin.address}`],
				).catch(() => {})
			}
		}
	}

	function applyLockState(locked, {hadViewer = activeStreams.size > 0, seq = ++lockProbeSeq} = {}) {
		if (locked === null) return
		if (seq < lastAppliedLockSeq) return
		lastAppliedLockSeq = seq
		if (locked === lastLockedState) return
		const prev = lastLockedState
		lastLockedState = locked
		// Initial unlocked state on first connect needs no redundant unlock broadcast.
		if (prev === null && !locked) return
		if (prev === true && !locked && hadViewer) {
			onRemoteUnlock?.()
		}
		for (const s of [...activeStreams]) {
			if (s.ws.readyState === s.ws.OPEN) {
				try {
					s.ws.send(JSON.stringify({type: 'lock', locked}))
				} catch {}
			}
		}
		if (!locked) {
			const lastWin = [...activeStreams].reverse().find((s) => s.mode === 'window' && s.address)
			if (lastWin) {
				hyprDispatch(
					`hl.dispatch(hl.dsp.focus({window = "address:${lastWin.address}"}))`,
					['dispatch', 'focuswindow', `address:${lastWin.address}`],
				).catch(() => {})
			}
		}
	}

	function ensureRectSyncTimer() {
		if (activeStreams.size > 0 && !rectSyncTimer) {
			rectSyncTimer = setInterval(() => {
				if (activeStreams.size === 0) {
					clearInterval(rectSyncTimer)
					rectSyncTimer = null
					return
				}
				monitorsInfo()
					.then((mons) => {
						const rail = mons.find((m) => m.name === RAIL_OUTPUT)
						if (rail && !rail.dpmsStatus) return wakeRailOutput()
					})
					.catch(() => {})
				const hadViewer = activeStreams.size > 0
				const seq = ++lockProbeSeq
				isSessionLocked()
					.then((locked) => applyLockState(locked, {hadViewer: hadViewer || activeStreams.size > 0, seq}))
					.catch(() => {})
				syncAllStreamRects().catch(() => {})
			}, 1200)
			rectSyncTimer.unref?.()
		} else if (activeStreams.size === 0 && rectSyncTimer) {
			clearInterval(rectSyncTimer)
			rectSyncTimer = null
		}
	}

	// Sanitize browser input messages strictly before forwarding to the C/Python stream engine.
	function sanitizeInputMsg(msg) {
		if (!msg || typeof msg !== 'object') return null
		const clamp = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null)
		if (msg.type === 'keyframe') return {type: 'keyframe'}
		if (msg.type === 'pointer_move') {
			const x = clamp(msg.x, 0, 1)
			const y = clamp(msg.y, 0, 1)
			if (x === null || y === null) return null
			return {type: 'pointer_move', x, y}
		}
		if (msg.type === 'pointer_button') {
			const btn = clamp(msg.button, 272, 279)
			if (btn === null || typeof msg.down !== 'boolean') return null
			const out = {type: 'pointer_button', button: Math.round(btn), down: msg.down}
			const x = clamp(msg.x, 0, 1)
			const y = clamp(msg.y, 0, 1)
			if (x !== null && y !== null) {
				out.x = x
				out.y = y
			}
			return out
		}
		if (msg.type === 'pointer_scroll') {
			const dx = clamp(msg.dx ?? 0, -10000, 10000) ?? 0
			const dy = clamp(msg.dy ?? 0, -10000, 10000) ?? 0
			return {type: 'pointer_scroll', dx, dy}
		}
		if (msg.type === 'key') {
			const code = clamp(msg.code, 1, 247)
			if (code === null || typeof msg.down !== 'boolean') return null
			const out = {type: 'key', code: Math.round(code), down: msg.down}
			const mods = clamp(msg.mods, 0, 255)
			if (mods !== null) out.mods = Math.round(mods)
			return out
		}
		if (msg.type === 'audio' && typeof msg.enabled === 'boolean') {
			const out = {type: 'audio', enabled: msg.enabled}
			if (msg.codec === 'pcm' || msg.codec === 'opus') out.codec = msg.codec
			return out
		}
		if (msg.type === 'unlock_check') return {type: 'unlock_check'}
		if (msg.type === 'reconfig') {
			const out = {type: 'reconfig'}
			const br = clamp(msg.bitrate, 1000, 150000)
			if (br !== null) out.bitrate = Math.round(br)
			const q = clamp(msg.quality, 0, 34)
			if (q !== null && (q === 0 || q >= 10)) out.quality = Math.round(q)
			if (msg.codec === 'h264' || msg.codec === 'hevc' || msg.codec === 'hevc10' || msg.codec === 'hevc444') {
				out.codec = msg.codec
			}
			return out
		}
		return null
	}

	// Strict allowlisted Hyprland window controls (never arbitrary exec/shell).
	async function dispatch(input = {}) {
		const action = String(input.action ?? '')
		if (action === 'focus') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			await hyprDispatch(`hl.dispatch(hl.dsp.focus({window = "address:${addr}"}))`, ['dispatch', 'focuswindow', `address:${addr}`])
			await syncStreamRect(addr).catch(() => {})
			return true
		}
		if (action === 'close') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			await hyprDispatch(`hl.dispatch(hl.dsp.window.close({window = "address:${addr}"}))`, ['dispatch', 'closewindow', `address:${addr}`])
			return true
		}
		if (action === 'resize') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			const w = Math.max(240, Math.min(3840, Math.round(Number(input.width) || 0)))
			const h = Math.max(180, Math.min(2160, Math.round(Number(input.height) || 0)))
			const cur = (await windows().catch(() => [])).find((x) => x.address.toLowerCase() === addr.toLowerCase())
			if (cur && !cur.floating) {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.window.float({window = "address:${addr}", state = true}))`,
					['dispatch', 'setfloating', `address:${addr}`],
				).catch(() => {})
			}
			const mons = await monitorsInfo()
			const rail = mons.find((m) => m.name === RAIL_OUTPUT)
			if (rail && cur && cur.workspace === rail.activeWorkspace) {
				await placeOnRail(addr, w, h)
			} else {
				await hyprDispatch(
					`hl.dispatch(hl.dsp.window.resize({window = "address:${addr}", x = ${w}, y = ${h}, exact = true}))`,
					['dispatch', 'resizewindowpixel', `exact ${w} ${h},address:${addr}`],
				)
			}
			await syncStreamRect(addr).catch(() => {})
			return true
		}
		if (action === 'moveToRail') {
			const addr = String(input.address ?? '')
			if (!ADDRESS_RE.test(addr)) throw new RpcError('BAD_REQUEST', 'Invalid window address')
			const railMon = await ensureRailOutput()
			const railWs = Number.isInteger(railMon?.activeWorkspace) && railMon.activeWorkspace >= 1 && railMon.activeWorkspace <= 99 ? railMon.activeWorkspace : 11
			await hyprDispatch(
				`hl.dispatch(hl.dsp.window.move({window = "address:${addr}", workspace = "${railWs}", silent = true}))`,
				['dispatch', 'movetoworkspacesilent', `${railWs},address:${addr}`],
			)
			await syncStreamRect(addr).catch(() => {})
			return {workspace: railWs}
		}
		if (action === 'workspace') {
			const id = Number(input.workspace)
			if (!Number.isInteger(id) || id < 1 || id > 20) throw new RpcError('BAD_REQUEST', 'Invalid workspace')
			await hyprDispatch(`hl.dispatch(hl.dsp.workspace.change_id({id = ${id}}))`, ['dispatch', 'workspace', String(id)])
			return true
		}
		throw new RpcError('BAD_REQUEST', 'Unsupported Hyprland action')
	}

	let disconnectLockRetryTimer = null

	// Attach an authenticated owner WebSocket to a live 60 FPS GPU H.264/HEVC/HEVC-4:4:4 Hyprland stream (with 10 ms Opus or silence-gated PCM PipeWire audio).
	async function attachStream(ws, {mode = 'output', address = '', output = '', fps = 60, bitrate = 22000, audio = false, audioCodec = 'pcm', codec = 'h264', quality = 0, compression = 0} = {}) {
		if (activeStreams.size + pendingStreams >= MAX_STREAMS) {
			ws.close(1013, 'Too many active Hyprland streams')
			return
		}
		if (disconnectLockRetryTimer) {
			clearTimeout(disconnectLockRetryTimer)
			disconnectLockRetryTimer = null
		}
		pendingStreams++
		let closedEarly = false
		let revoked = false
		let cleanupRef = null
		let wantAudio = !!audio
		let earlyAudioCodec = null
		let earlyReconfig = null
		ws.__omarchyRevoke = (code = 1008, reason = 'Session ended') => {
			revoked = true
			closedEarly = true
			try {
				cleanupRef?.()
			} catch {}
			try {
				ws.close(code, reason)
			} catch {}
		}
		const onEarlyClose = () => {
			closedEarly = true
		}
		// Capture any audio mute/codec or live reconfig sent immediately on ws.onopen while attachStream is still awaiting setup.
		const onEarlyMessage = (data, isBinary) => {
			if (revoked || isBinary) return
			const text = String(data ?? '')
			if (text.length > 512) return
			try {
				const clean = sanitizeInputMsg(JSON.parse(text))
				if (!clean) return
				if (clean.type === 'audio') {
					wantAudio = clean.enabled
					if (clean.codec) earlyAudioCodec = clean.codec
				} else if (clean.type === 'reconfig') {
					earlyReconfig = {...(earlyReconfig || {}), ...clean}
				}
			} catch {}
		}
		ws.once('close', onEarlyClose)
		ws.once('error', onEarlyClose)
		ws.on('message', onEarlyMessage)

		let entry = null
		try {
			const cleanMode = mode === 'window' ? 'window' : 'output'
			const cleanAddr = cleanMode === 'window' ? String(address ?? '') : ''
			const cleanOutput = cleanMode === 'output' && OUTPUT_NAME_RE.test(String(output ?? '')) ? String(output) : ''
			if (cleanMode === 'window' && !ADDRESS_RE.test(cleanAddr)) {
				ws.close(1008, 'Invalid window address')
				return
			}
			const env = await discoverEnv()
			if (closedEarly || ws.readyState !== ws.OPEN) return
			if (!env?.WAYLAND_DISPLAY) {
				ws.close(1011, 'Hyprland desktop session is not active')
				return
			}
			const cleanFps = Math.max(5, Math.min(120, Math.round(Number(fps) || 60)))
			let curBitrate = Math.max(1000, Math.min(150000, Math.round(Number(bitrate) || 22000)))
			let curCodec = codec === 'hevc444' || codec === 'hevc10' || codec === 'hevc' ? codec : 'h264'
			let curQuality = Number.isFinite(Number(quality)) && Number(quality) >= 10 && Number(quality) <= 34 ? Math.round(Number(quality)) : 0
			const cleanComp = Number.isFinite(Number(compression)) && Number(compression) >= 1 && Number(compression) <= 7 ? Math.round(Number(compression)) : 0
			let wantOpus = (earlyAudioCodec ?? audioCodec) === 'opus'
			let opusFailed = false

			// Ensure target window is on an awake, active workspace (move onto awake headless RAIL-1 if its monitor is asleep or workspace is hidden)
			if (cleanMode === 'window') {
				const mons = await monitorsInfo()
				const wins = await windows().catch(() => [])
				const targetWin = wins.find((w) => w.address.toLowerCase() === cleanAddr.toLowerCase())
				const railMon = mons.find((m) => m.name === RAIL_OUTPUT)
				const visibleAwake = targetWin && mons.some((m) => m.dpmsStatus && m.activeWorkspace === targetWin.workspace)
				if (targetWin && !visibleAwake) {
					const ensured = await ensureRailOutput().catch(() => null)
					const railWs = Number.isInteger(ensured?.activeWorkspace) && ensured.activeWorkspace >= 1 && ensured.activeWorkspace <= 99 ? ensured.activeWorkspace : 11
					if (ensured) {
						await hyprDispatch(
							`hl.dispatch(hl.dsp.window.move({window = "address:${cleanAddr}", workspace = "${railWs}", silent = true}))`,
							['dispatch', 'movetoworkspacesilent', `${railWs},address:${cleanAddr}`],
						).catch(() => {})
						await placeOnRail(cleanAddr, targetWin.size[0], targetWin.size[1]).catch(() => {})
					}
				} else if (targetWin && railMon && targetWin.workspace === railMon.activeWorkspace) {
					const padL = railMon.reserved?.[0] ?? 0
					const padT = railMon.reserved?.[1] ?? 0
					const padR = railMon.reserved?.[2] ?? 0
					const padB = railMon.reserved?.[3] ?? 0
					const overflows =
						targetWin.at[0] < railMon.x + padL ||
						targetWin.at[1] < railMon.y + padT ||
						targetWin.at[0] + targetWin.size[0] > railMon.x + railMon.width - padR ||
						targetWin.at[1] + targetWin.size[1] > railMon.y + railMon.height - padB
					if (overflows || railMon.width < 3840 || railMon.height < 2160) {
						await placeOnRail(cleanAddr, targetWin.size[0], targetWin.size[1]).catch(() => {})
					}
				}
			}

			if (cleanMode === 'output' && cleanOutput === RAIL_OUTPUT) {
				await ensureRailOutput().catch(() => null)
			}
			let resolvedOutput = cleanOutput
			if (cleanMode === 'output' && !resolvedOutput) {
				const mons = await monitorsInfo()
				if (mons.length && !mons[0].dpmsStatus) {
					const awake = mons.find((m) => m.dpmsStatus)
					if (awake) resolvedOutput = awake.name
				}
			}

			const nativeBin = await ensureCaptureBinary().catch(() => null)
			if (revoked || closedEarly || ws.readyState !== ws.OPEN) return

			if (earlyReconfig) {
				if (nativeBin) {
					if (earlyReconfig.bitrate !== undefined) curBitrate = earlyReconfig.bitrate
					if (earlyReconfig.quality !== undefined) curQuality = earlyReconfig.quality
					if (earlyReconfig.codec !== undefined) curCodec = earlyReconfig.codec
					try {
						ws.send(JSON.stringify({type: 'reconfig_applied', bitrate: curBitrate, quality: curQuality, codec: curCodec}))
					} catch {}
				} else {
					try {
						ws.send(JSON.stringify({type: 'reconfig_unsupported'}))
					} catch {}
				}
			}
			if (earlyAudioCodec) wantOpus = earlyAudioCodec === 'opus'
			let bp = backpressureBudgets(curBitrate)

			let child
			if (nativeBin) {
				const args = ['--mode', cleanMode, '--fps', String(cleanFps), '--bitrate', String(curBitrate), '--codec', curCodec, '--vaapi-device', vaapiDevice]
				if (curQuality) args.push('--quality', String(curQuality))
				if (cleanComp) args.push('--compression', String(cleanComp))
				if (cleanAddr) args.push('--address', cleanAddr)
				if (resolvedOutput) args.push('--output', resolvedOutput)
				child = spawnImpl(nativeBin, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
			} else {
				const args = [scriptPath, '--mode', cleanMode, '--fps', String(Math.min(60, cleanFps)), '--bitrate', String(curBitrate)]
				if (cleanAddr) args.push('--address', cleanAddr)
				if (resolvedOutput) args.push('--output', resolvedOutput)
				child = spawnImpl('python3', args, {env, stdio: ['pipe', 'pipe', 'pipe']})
			}

			entry = {child, ws, mode: cleanMode, address: cleanAddr, output: resolvedOutput}
			activeStreams.add(entry)
			ensureRectSyncTimer()
			let stderrBuf = ''
			const frameReader = createFrameReader()
			let dropUntilKey = false
			let pendingKeyReq = false
			let lastKeyframeReqAt = 0
			let keyframeTimer = null
			let cleaned = false
			let childExited = false
			let killTimer = null
			// Track per-child exit state & kill timers so rapid mute/unmute toggles can never orphan parec or opus workers.
			let audioState = null // {procs: [{proc, exited, killTimer}]}
			let audioRx = Buffer.alloc(0)
			let audioHangFrames = 0 // keep sending ~240ms of tail after non-silent audio, then gate to 0 kbps during silence
			const AUDIO_CHUNK = 3840 // 20 ms of 48 kHz 16-bit stereo PCM (960 frames * 4 bytes)

			const killAudioProc = (item) => {
				if (item.killTimer) {
					clearTimeout(item.killTimer)
					item.killTimer = null
				}
				if (item.exited || item.proc.exitCode != null) return
				try {
					item.proc.kill('SIGTERM')
					item.killTimer = setTimeout(() => {
						item.killTimer = null
						try {
							if (!item.exited && item.proc.exitCode == null) item.proc.kill('SIGKILL')
						} catch {}
					}, 1000)
					item.killTimer.unref?.()
				} catch {}
			}

			const stopAudio = () => {
				if (!audioState) return
				const st = audioState
				audioState = null
				audioRx = Buffer.alloc(0)
				audioHangFrames = 0
				for (const item of st.procs) killAudioProc(item)
			}

			const startAudio = () => {
				if (cleaned || audioState) return
				// Prefer 10 ms Opus (128 kbps active, 0 kbps silent) via nativeBin --opus-stdin when supported; fallback cleanly to PCM 0x02.
				if (wantOpus && nativeBin && !opusFailed) {
					let ac = null
					let pItem = null
					try {
						ac = spawnImpl('parec', ['--device=@DEFAULT_MONITOR@', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=10'], {env, stdio: ['ignore', 'pipe', 'ignore']})
						pItem = {proc: ac, exited: false, killTimer: null}
						const st = {procs: [pItem]}
						audioState = st
						const oe = spawnImpl(nativeBin, ['--opus-stdin'], {env, stdio: ['pipe', 'pipe', 'ignore']})
						const oItem = {proc: oe, exited: false, killTimer: null}
						st.procs.push(oItem)
						let opusRx = Buffer.alloc(0)
						const onProcDone = (item, other, isOpus, code) => {
							item.exited = true
							if (item.killTimer) {
								clearTimeout(item.killTimer)
								item.killTimer = null
							}
							if (audioState === st) {
								audioState = null
								killAudioProc(other)
								if (isOpus && !cleaned && code !== 0) {
									opusFailed = true
									if (wantAudio) startAudio()
								}
							}
						}
						ac.once('error', () => onProcDone(pItem, oItem, false, 1))
						ac.once('exit', (code) => onProcDone(pItem, oItem, false, code))
						ac.once('close', (code) => onProcDone(pItem, oItem, false, code))
						oe.once('error', () => onProcDone(oItem, pItem, true, 2))
						oe.once('exit', (code) => onProcDone(oItem, pItem, true, code))
						oe.once('close', (code) => onProcDone(oItem, pItem, true, code))
						oe.stdin?.on('error', () => {})
						ac.stdout?.on('data', (chunk) => {
							if (cleaned || audioState !== st || !oe.stdin?.writable) return
							try {
								if (!oe.stdin.write(chunk)) {
									ac.stdout.pause?.()
									oe.stdin.once('drain', () => {
										if (!cleaned && audioState === st) ac.stdout?.resume?.()
									})
								}
							} catch {}
						})
						oe.stdout?.on('data', (chunk) => {
							if (cleaned || audioState !== st || ws.readyState !== ws.OPEN) return
							opusRx = opusRx.length ? Buffer.concat([opusRx, chunk]) : chunk
							while (opusRx.length >= 2) {
								const len = opusRx.readUInt16BE(0)
								if (len === 0 || len > 4096) {
									opusRx = Buffer.alloc(0)
									break
								}
								if (opusRx.length < 2 + len) break
								const frame = opusRx.subarray(2, 2 + len)
								opusRx = opusRx.subarray(2 + len)
								if (ws.bufferedAmount > 256 * 1024) continue
								const pkt = Buffer.allocUnsafe(1 + len)
								pkt[0] = 3 // 3 = 10 ms 48 kHz stereo Opus packet
								frame.copy(pkt, 1)
								ws.send(pkt, {binary: true})
							}
						})
						return
					} catch {
						if (pItem) killAudioProc(pItem)
						opusFailed = true
						audioState = null
					}
				}
				try {
					const ac = spawnImpl('parec', ['--device=@DEFAULT_MONITOR@', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20'], {env, stdio: ['ignore', 'pipe', 'ignore']})
					const pItem = {proc: ac, exited: false, killTimer: null}
					const st = {procs: [pItem]}
					audioState = st
					const onAudioEnd = () => {
						pItem.exited = true
						if (audioState === st) audioState = null
						if (pItem.killTimer) {
							clearTimeout(pItem.killTimer)
							pItem.killTimer = null
						}
					}
					ac.once('error', onAudioEnd)
					ac.once('exit', onAudioEnd)
					ac.once('close', onAudioEnd)
					ac.stdout?.on('data', (chunk) => {
						if (cleaned || audioState !== st || ws.readyState !== ws.OPEN) return
						audioRx = audioRx.length ? Buffer.concat([audioRx, chunk]) : chunk
						while (audioRx.length >= AUDIO_CHUNK) {
							const pcm = audioRx.subarray(0, AUDIO_CHUNK)
							audioRx = audioRx.subarray(AUDIO_CHUNK)
							if (!isPcmSilent(pcm)) {
								audioHangFrames = 12 // 240 ms tail
							} else if (audioHangFrames > 0) {
								audioHangFrames--
							} else {
								continue // silence-gated: 0 kbps on TCP socket when desktop audio is silent
							}
							if (ws.bufferedAmount > 256 * 1024) continue
							const pkt = Buffer.allocUnsafe(1 + AUDIO_CHUNK)
							pkt[0] = 2 // 0=video delta, 1=video keyframe, 2=48kHz s16le stereo PCM, 3=Opus
							pcm.copy(pkt, 1)
							ws.send(pkt, {binary: true})
						}
					})
				} catch {
					audioState = null
				}
			}

			if (wantAudio) startAudio()

			// Single ordered input writer: synchronous fast path in steady state, strict FIFO + coalesced motion during focus switch or pipe backpressure.
			let focusing = false
			let stdinBackpressured = false
			let pendingMoveLine = null
			const pendingControl = []
			const MAX_PENDING_INPUT = 256

			const cleanup = () => {
				if (cleaned) return
				cleaned = true
				focusing = false
				pendingMoveLine = null
				pendingControl.length = 0
				if (keyframeTimer) {
					clearTimeout(keyframeTimer)
					keyframeTimer = null
				}
				frameReader.clear()
				stopAudio()
				const wasLastLocked = lastLockedState === true
				activeStreams.delete(entry)
				ensureRectSyncTimer()
				// If the last viewer closes right after unlocking (before the 1.2s poll tick), check lock state with bounded retries across transient unknown probes so remoteSignIn relock still arms.
				if (activeStreams.size === 0) {
					if (disconnectLockRetryTimer) {
						clearTimeout(disconnectLockRetryTimer)
						disconnectLockRetryTimer = null
					}
					if (wasLastLocked) {
						const retryDelays = [0, 300, 700, 1200]
						const probeAttempt = (idx) => {
							if (activeStreams.size > 0) return
							const seq = ++lockProbeSeq
							isSessionLocked()
								.then((locked) => {
									if (activeStreams.size > 0) return
									if (locked === null) {
										if (idx + 1 < retryDelays.length) {
											disconnectLockRetryTimer = setTimeout(() => {
												disconnectLockRetryTimer = null
												probeAttempt(idx + 1)
											}, retryDelays[idx + 1])
											disconnectLockRetryTimer.unref?.()
										} else {
											lastLockedState = null
										}
										return
									}
									applyLockState(locked, {hadViewer: true, seq})
									if (activeStreams.size === 0) lastLockedState = null
								})
								.catch(() => {
									if (activeStreams.size > 0) return
									if (idx + 1 < retryDelays.length) {
										disconnectLockRetryTimer = setTimeout(() => {
											disconnectLockRetryTimer = null
											probeAttempt(idx + 1)
										}, retryDelays[idx + 1])
										disconnectLockRetryTimer.unref?.()
									} else {
										lastLockedState = null
									}
								})
						}
						probeAttempt(0)
					} else {
						lastLockedState = null
					}
				}
				try {
					child.stdin?.end()
				} catch {}
				if (childExited || child.exitCode != null) return
				try {
					child.kill('SIGTERM')
					// Track actual exit (NOT child.killed, which turns true immediately on SIGTERM!)
					killTimer = setTimeout(() => {
						try {
							if (!childExited && child.exitCode == null) child.kill('SIGKILL')
						} catch {}
					}, 1500)
					killTimer.unref?.()
				} catch {}
			}
			cleanupRef = cleanup
			if (revoked) {
				cleanup()
				return
			}

			// Guard against async EPIPE/broken-pipe errors on child.stdin so a crashing worker never crashes omarchyd.
			child.stdin?.on('error', () => cleanup())

			const rawWriteStdin = (line) => {
				if (cleaned || !child.stdin?.writable) return true
				try {
					const ok = child.stdin.write(line)
					if (!ok) stdinBackpressured = true
					return ok
				} catch {
					cleanup()
					return false
				}
			}

			const flushInputQueue = () => {
				while (!cleaned && !focusing && !stdinBackpressured) {
					if (pendingControl.length > 0) {
						const next = pendingControl.shift()
						if (!rawWriteStdin(next)) return
					} else if (pendingMoveLine !== null) {
						const mv = pendingMoveLine
						pendingMoveLine = null
						if (!rawWriteStdin(mv)) return
					} else {
						break
					}
				}
			}

			child.stdin?.on('drain', () => {
				stdinBackpressured = false
				flushInputQueue()
			})

			const enqueueMoveLine = (line) => {
				if (cleaned) return
				if (!focusing && !stdinBackpressured && pendingControl.length === 0 && pendingMoveLine === null) {
					rawWriteStdin(line)
					return
				}
				// Coalesce consecutive pointer moves into the latest coordinate only.
				pendingMoveLine = line
			}

			const enqueueControlLine = (line) => {
				if (cleaned) return
				if (!focusing && !stdinBackpressured && pendingControl.length === 0 && pendingMoveLine === null) {
					rawWriteStdin(line)
					return
				}
				const extra = pendingMoveLine !== null ? 2 : 1
				if (pendingControl.length + extra > MAX_PENDING_INPUT) {
					// Never silently drop key/button releases (which would leave inputs stuck held); tear down the stalled worker so Wayland releases all virtual inputs.
					cleanup()
					if (ws.readyState === ws.OPEN) {
						try {
							ws.close(1013, 'Input queue overflow')
						} catch {}
					}
					return
				}
				if (pendingMoveLine !== null) {
					pendingControl.push(pendingMoveLine)
					pendingMoveLine = null
				}
				pendingControl.push(line)
			}

			const enqueueButtonLine = (line, isDown) => {
				if (isDown && cleanAddr) {
					const targetLower = cleanAddr.toLowerCase()
					const needsFocus = lastFocusedAddr !== targetLower
					if (needsFocus && !focusing) {
						focusing = true
						enqueueControlLine(line)
						// Raise & sync rect before button-down only when switching focus to another window; all subsequent moves/events queue cleanly behind it.
						;(async () => {
							if (cleaned) return
							await hyprDispatch(`hl.dispatch(hl.dsp.focus({window = "address:${cleanAddr}"}))`, ['dispatch', 'focuswindow', `address:${cleanAddr}`]).catch(() => {})
							lastFocusedAddr = targetLower
							await syncStreamRect(cleanAddr).catch(() => {})
						})().finally(() => {
							focusing = false
							flushInputQueue()
						})
						return
					}
				}
				enqueueControlLine(line)
			}

			const scheduleKeyframeRecovery = () => {
				if (cleaned || !pendingKeyReq || ws.readyState !== ws.OPEN) return
				const nowMs = Date.now()
				const cooldownLeft = Math.max(0, 1500 - (nowMs - lastKeyframeReqAt))
				if (ws.bufferedAmount <= bp.keyDrainBytes && cooldownLeft === 0) {
					lastKeyframeReqAt = nowMs
					enqueueControlLine(nativeBin ? 'F\n' : '{"type":"keyframe"}\n')
					if (keyframeTimer) {
						clearTimeout(keyframeTimer)
						keyframeTimer = null
					}
					// Re-check after 1500 ms if still waiting on a keyframe (e.g., static screen or second drop inside one cooldown)
					keyframeTimer = setTimeout(() => {
						keyframeTimer = null
						if (dropUntilKey && pendingKeyReq) scheduleKeyframeRecovery()
					}, 1500)
					keyframeTimer.unref?.()
					return
				}
				if (!keyframeTimer) {
					const waitMs = cooldownLeft > 0 ? cooldownLeft : 120
					keyframeTimer = setTimeout(() => {
						keyframeTimer = null
						scheduleKeyframeRecovery()
					}, waitMs)
					keyframeTimer.unref?.()
				}
			}

			// Push initial window or monitor logical rect for pixel-perfect pointer mapping (window AND multi-monitor output mode)
			syncAllStreamRects().catch(() => {})
			const initHadViewer = activeStreams.size > 0
			const initSeq = ++lockProbeSeq
			isSessionLocked()
				.then((locked) => {
					if (locked === null) return
					const changed = locked !== lastLockedState
					applyLockState(locked, {hadViewer: initHadViewer || activeStreams.size > 0, seq: initSeq})
					if (!changed && locked && ws.readyState === ws.OPEN) {
						ws.send(JSON.stringify({type: 'lock', locked: true}))
					}
				})
				.catch(() => {})

			child.stderr?.on('data', (d) => {
				stderrBuf = (stderrBuf + d.toString('utf8')).slice(-2048)
			})

			child.stdout?.on('data', (chunk) => {
				if (cleaned) return
				frameReader.push(chunk)
				const ok = frameReader.drain((msgType, payload) => {
					if (ws.readyState !== ws.OPEN) return

					if (msgType === 1) {
						try {
							ws.send(JSON.stringify({type: 'meta', ...JSON.parse(payload.toString('utf8'))}))
						} catch {}
					} else if (msgType === 3) {
						try {
							const info = JSON.parse(payload.toString('utf8'))
							ws.send(JSON.stringify({type: 'error', error: info.error || 'Stream error'}))
						} catch {}
					} else if (msgType === 4) {
						try {
							const info = JSON.parse(payload.toString('utf8'))
							if (typeof info.cursor === 'string') ws.send(JSON.stringify({type: 'cursor', cursor: info.cursor}))
						} catch {}
					} else if (msgType === 5) {
						try {
							ws.send(JSON.stringify({type: 'stats', ...JSON.parse(payload.toString('utf8'))}))
						} catch {}
					} else if (msgType === 2 && payload.length > 9) {
						const isKey = payload[0] === 1
						// Bitrate-proportional bufferbloat ceiling (~250 ms of stream bitrate) prevents WAN lag while giving high-bitrate LAN keyframes headroom.
						if (ws.bufferedAmount > bp.hardDropBytes) {
							dropUntilKey = true
							pendingKeyReq = true
							scheduleKeyframeRecovery()
							return
						}
						if (ws.bufferedAmount > bp.deltaDropBytes && !isKey) {
							dropUntilKey = true
							pendingKeyReq = true
							scheduleKeyframeRecovery()
							return
						}
						// Wait for TCP send queue to drain below keyDrainBytes before requesting a recovery IDR so keyframes never pile onto congestion.
						if (pendingKeyReq && ws.bufferedAmount <= bp.keyDrainBytes) {
							scheduleKeyframeRecovery()
						}
						if (dropUntilKey && !isKey) return
						if (isKey) {
							dropUntilKey = false
							pendingKeyReq = false
							if (keyframeTimer) {
								clearTimeout(keyframeTimer)
								keyframeTimer = null
							}
						}
						ws.send(payload, {binary: true})
					}
				})
				if (!ok) {
					cleanup()
					ws.close(1011, 'Stream framing error')
				}
			})

			ws.off?.('message', onEarlyMessage)
			ws.on('message', (data, isBinary) => {
				if (cleaned) return
				if (isBinary) {
					// Zero-overhead binary input fast paths routed through ordered writer:
					//   0x10 (5B): pointer_move   [0x10][u16be x][u16be y]
					//   0x11 (7B): pointer_button [0x11][u8 btnOffset(0..7)][u8 down][u16be x][u16be y]
					//   0x12 (9B): pointer_scroll [0x12][i32be dx256][i32be dy256]
					//   0x13 (4B): key            [0x13][u8 evdevCode(1..247)][u8 down][u8 mods]
					const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
					const tag = buf[0]
					if (tag === 0x10 && buf.length === 5) {
						const ux = buf.readUInt16BE(1)
						const uy = buf.readUInt16BE(3)
						enqueueMoveLine(
							nativeBin
								? `M ${ux} ${uy}\n`
								: `{"type":"pointer_move","x":${(ux / 65535).toFixed(5)},"y":${(uy / 65535).toFixed(5)}}\n`,
						)
					} else if (tag === 0x11 && buf.length === 7) {
						const btnOff = buf[1]
						const down = buf[2]
						if (btnOff <= 7 && (down === 0 || down === 1)) {
							const btn = 272 + btnOff
							const ux = buf.readUInt16BE(3)
							const uy = buf.readUInt16BE(5)
							const line = nativeBin
								? `B ${btn} ${down} ${ux} ${uy}\n`
								: `{"type":"pointer_button","button":${btn},"down":${down === 1},"x":${(ux / 65535).toFixed(5)},"y":${(uy / 65535).toFixed(5)}}\n`
							enqueueButtonLine(line, down === 1)
						}
					} else if (tag === 0x12 && buf.length === 9) {
						const dx256 = Math.max(-2560000, Math.min(2560000, buf.readInt32BE(1)))
						const dy256 = Math.max(-2560000, Math.min(2560000, buf.readInt32BE(5)))
						enqueueControlLine(
							nativeBin
								? `S ${dx256} ${dy256}\n`
								: `{"type":"pointer_scroll","dx":${(dx256 / 256).toFixed(3)},"dy":${(dy256 / 256).toFixed(3)}}\n`,
						)
					} else if (tag === 0x13 && buf.length === 4) {
						const code = buf[1]
						const down = buf[2]
						const mods = buf[3]
						if (code >= 1 && code <= 247 && (down === 0 || down === 1)) {
							enqueueControlLine(
								nativeBin
									? `K ${code} ${down} ${mods}\n`
									: `{"type":"key","code":${code},"down":${down === 1},"mods":${mods}}\n`,
							)
						}
					} else if (tag === 0x14 && buf.length === 9) {
						// Sub-millisecond binary RTT ping -> immediate 0x04 pong echo
						if (ws.readyState === ws.OPEN) {
							const pong = Buffer.allocUnsafe(9)
							pong[0] = 0x04
							buf.copy(pong, 1, 1, 9)
							ws.send(pong, {binary: true})
						}
					}
					return
				}
				const text = String(data ?? '')
				if (text.length > 1024) return
				let clean
				try {
					clean = sanitizeInputMsg(JSON.parse(text))
				} catch {
					return
				}
				if (!clean) return
				if (clean.type === 'audio') {
					wantAudio = clean.enabled
					if (clean.codec === 'pcm') {
						wantOpus = false
						opusFailed = true
						stopAudio()
						if (clean.enabled) startAudio()
						return
					}
					if (clean.enabled) startAudio()
					else stopAudio()
					return
				}
				if (clean.type === 'reconfig') {
					if (!nativeBin) {
						if (ws.readyState === ws.OPEN) {
							try {
								ws.send(JSON.stringify({type: 'reconfig_unsupported'}))
							} catch {}
						}
						return
					}
					if (clean.bitrate !== undefined) curBitrate = clean.bitrate
					if (clean.quality !== undefined) curQuality = clean.quality
					if (clean.codec !== undefined) curCodec = clean.codec
					bp = backpressureBudgets(curBitrate)
					enqueueControlLine(`R ${curBitrate} ${curQuality} ${curCodec}\n`)
					if (ws.readyState === ws.OPEN) {
						try {
							ws.send(JSON.stringify({type: 'reconfig_applied', bitrate: curBitrate, quality: curQuality, codec: curCodec}))
						} catch {}
					}
					return
				}
				if (clean.type === 'unlock_check') {
					// Read-only lock-state refresh probes
					for (const ms of [300, 900, 1800, 3000]) {
						const t = setTimeout(() => {
							if (cleaned) return
							const hadViewer = activeStreams.size > 0
							const seq = ++lockProbeSeq
							isSessionLocked()
								.then((locked) => applyLockState(locked, {hadViewer: hadViewer || activeStreams.size > 0, seq}))
								.catch(() => {})
						}, ms)
						t.unref?.()
					}
					return
				}
				if (clean.type === 'keyframe' && nativeBin) {
					enqueueControlLine('F\n')
					return
				}
				const line = `${JSON.stringify(clean)}\n`
				if (clean.type === 'pointer_move') {
					enqueueMoveLine(line)
				} else if (clean.type === 'pointer_button') {
					enqueueButtonLine(line, clean.down)
				} else {
					enqueueControlLine(line)
				}
			})

			const onChildEnd = () => {
				childExited = true
				if (killTimer) {
					clearTimeout(killTimer)
					killTimer = null
				}
			}
			child.on('exit', () => {
				onChildEnd()
				stopAudio()
				activeStreams.delete(entry)
				ensureRectSyncTimer()
				if (ws.readyState === ws.OPEN) {
					if (stderrBuf.trim()) ws.send(JSON.stringify({type: 'error', error: stderrBuf.trim().slice(0, 300)}))
					ws.close(1000)
				}
			})
			child.on('close', onChildEnd)
			child.on('error', () => {
				onChildEnd()
				cleanup()
				if (ws.readyState === ws.OPEN) ws.close(1011, 'Streamer failed to start')
			})
			ws.on('close', cleanup)
			ws.on('error', cleanup)
		} finally {
			pendingStreams = Math.max(0, pendingStreams - 1)
			ws.off?.('close', onEarlyClose)
			ws.off?.('error', onEarlyClose)
			ws.off?.('message', onEarlyMessage)
		}
	}

	return {
		attachStream,
		notifyUnlocked,
		windows,
		close() {
			if (disconnectLockRetryTimer) clearTimeout(disconnectLockRetryTimer)
			disconnectLockRetryTimer = null
			if (rectSyncTimer) clearInterval(rectSyncTimer)
			rectSyncTimer = null
			for (const e of [...activeStreams]) {
				try {
					e.child.kill('SIGTERM')
				} catch {}
				try {
					e.ws.close(1001)
				} catch {}
			}
			activeStreams.clear()
		},
		procedures: {
			'hyprland.status': {kind: 'query', run: status},
			'hyprland.windows': {kind: 'query', run: windows},
			'hyprland.dispatch': {kind: 'mutation', run: dispatch},
		},
	}
}
