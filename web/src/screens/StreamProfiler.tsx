// Stream Profiler & per-device RAIL streaming profiles (Settings › Remote Apps).
import {useEffect, useMemo, useState, type CSSProperties, type FormEvent} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {Card, Field, Group, Segmented, useConfirm, useToast} from '../ui'

export type StreamCodec = 'hevc' | 'hevc10' | 'h264'

export type StreamProfile = {
	id: string
	name: string
	deviceHint: string
	codec: StreamCodec
	fps: number
	bitrate: number
	quality: number
	compression: number
	measuredFps?: number
	measuredP95Ms?: number
	measuredRttMs?: number
	measuredMbps?: number
	encoder?: string
	score?: number
	testedAt?: number
	autoSelected?: boolean
}

export type StreamProfilesResponse = {
	profiles: StreamProfile[]
	activeByDevice: Record<string, string>
	defaultProfileId: string | null
	vaapi?: boolean
	nativeEngine?: boolean
}

export type ProfileBenchResult = {
	label: string
	codec: StreamCodec
	fps: number
	bitrate: number
	quality: number
	compression: number
	ok: boolean
	frames: number
	p50Ms: number
	p95Ms: number
	mbps: number
	keyKb: number
	encoder: string | null
	score: number
}

const DEVICE_ID_KEY = 'omarchy-server:rail-device-id'

export function describeThisDevice(): {name: string; hint: string; slug: string} {
	if (typeof navigator === 'undefined') return {name: 'Browser', hint: '', slug: 'browser'}
	const ua = navigator.userAgent || ''
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
	const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Desktop'
	const dpr = typeof window !== 'undefined' ? Math.round((window.devicePixelRatio || 1) * 10) / 10 : 1
	const res = typeof screen !== 'undefined' ? `${screen.width}×${screen.height}${dpr > 1 ? ` @${dpr}x` : ''}` : ''
	return {
		name: `${os} · ${browser}`,
		hint: [browser, os, res].filter(Boolean).join(' · '),
		slug: `${os}-${browser}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
	}
}

export function getRailDeviceId(): string {
	try {
		const existing = localStorage.getItem(DEVICE_ID_KEY)
		if (existing && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(existing)) return existing
		const info = describeThisDevice()
		const rand = Math.random().toString(36).slice(2, 8)
		const id = `${info.slug}-${rand}`.slice(0, 48)
		localStorage.setItem(DEVICE_ID_KEY, id)
		return id
	} catch {
		return 'default-browser'
	}
}

export async function probeClientCodecs(): Promise<StreamCodec[]> {
	const out: StreamCodec[] = []
	const VD = (globalThis as {VideoDecoder?: typeof VideoDecoder}).VideoDecoder
	if (typeof VD?.isConfigSupported !== 'function') return out
	const tests: [StreamCodec, string][] = [
		['hevc', 'hev1.1.6.L153.B0'],
		['hevc10', 'hev1.2.4.L153.B0'],
		['h264', 'avc1.640033'],
	]
	await Promise.all(
		tests.map(async ([id, codec]) => {
			try {
				const res = await VD.isConfigSupported({
					codec,
					codedWidth: 1920,
					codedHeight: 1080,
					hardwareAcceleration: 'prefer-hardware',
					optimizeForLatency: true,
				})
				if (res?.supported) out.push(id)
			} catch {}
		}),
	)
	return out
}

export async function measureServerRtt(): Promise<number> {
	const samples: number[] = []
	for (let i = 0; i < 4; i++) {
		const t0 = performance.now()
		try {
			await fetch('/api/health', {cache: 'no-store'})
			const dt = performance.now() - t0
			if (i > 0) samples.push(dt) // skip first TLS/connection warm-up
		} catch {}
	}
	if (!samples.length) return 20
	samples.sort((a, b) => a - b)
	return Math.max(1, Math.round(samples[Math.floor(samples.length / 2)]))
}

const CODEC_LABELS: Record<StreamCodec, string> = {
	hevc: 'HEVC 8-bit',
	hevc10: 'HEVC 10-bit',
	h264: 'H.264 High',
}

export function StreamProfilerPage({onBack}: {onBack: () => void}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const deviceId = useMemo(() => getRailDeviceId(), [])
	const deviceInfo = useMemo(() => describeThisDevice(), [])

	const [clientCodecs, setClientCodecs] = useState<StreamCodec[]>([])
	const [liveRtt, setLiveRtt] = useState<number | null>(null)
	const [benchResults, setBenchResults] = useState<ProfileBenchResult[] | null>(null)
	const [editing, setEditing] = useState<StreamProfile | null>(null)

	useEffect(() => {
		probeClientCodecs().then(setClientCodecs).catch(() => setClientCodecs([]))
		measureServerRtt().then(setLiveRtt).catch(() => {})
	}, [])

	const profilesQ = useQuery({
		queryKey: ['hyprland.profiles'],
		queryFn: () => query<StreamProfilesResponse>('hyprland.profiles'),
		staleTime: 10_000,
	})

	const activeId = profilesQ.data?.activeByDevice?.[deviceId] ?? profilesQ.data?.defaultProfileId ?? null
	const activeProfile = (profilesQ.data?.profiles ?? []).find((p) => p.id === activeId) ?? null

	const runProfiler = useMutation({
		mutationFn: async () => {
			const [codecs, rttMs] = await Promise.all([probeClientCodecs(), measureServerRtt()])
			setClientCodecs(codecs)
			setLiveRtt(rttMs)
			if (!codecs.length) {
				throw new Error('This browser reported no supported WebCodecs video decoders.')
			}
			return mutate<{winner: StreamProfile | null; results: ProfileBenchResult[]; rttMs: number}>('hyprland.profileRun', {
				deviceId,
				deviceName: deviceInfo.name,
				deviceHint: deviceInfo.hint,
				clientCodecs: codecs,
				clientRttMs: rttMs,
				saveAsActive: true,
			})
		},
		onSuccess: (res) => {
			setBenchResults(res.results)
			qc.invalidateQueries({queryKey: ['hyprland.profiles']})
			if (res.winner) {
				toast(`Selected ${CODEC_LABELS[res.winner.codec]} (${Math.round(res.winner.bitrate / 1000)} Mbps, score ${res.winner.score ?? 0}/100)`)
			} else {
				toast('No stream preset passed GPU benchmarking; existing profile kept', true)
			}
		},
		onError: (e: Error) => toast(e.message, true),
	})

	const saveProfile = useMutation({
		mutationFn: (input: {profile: Partial<StreamProfile>; deviceId?: string; activate?: boolean; setDefault?: boolean}) =>
			mutate('hyprland.profileSave', input),
		onSuccess: () => {
			qc.invalidateQueries({queryKey: ['hyprland.profiles']})
			setEditing(null)
			toast('Stream profile saved')
		},
		onError: (e: Error) => toast(e.message, true),
	})

	const deleteProfile = useMutation({
		mutationFn: (id: string) => mutate('hyprland.profileDelete', {id}),
		onSuccess: () => {
			qc.invalidateQueries({queryKey: ['hyprland.profiles']})
			toast('Profile removed')
		},
		onError: (e: Error) => toast(e.message, true),
	})

	const startNewProfile = () => {
		const isLan = liveRtt !== null && liveRtt < 12
		const base = activeProfile ?? {
			codec: (clientCodecs[0] ?? 'hevc') as StreamCodec,
			fps: 60,
			bitrate: liveRtt && liveRtt >= 45 ? 16000 : isLan ? 48000 : 24000,
			quality: isLan ? 16 : 20,
			compression: 7,
		}
		setEditing({
			id: `custom-${Date.now().toString(36)}`,
			name: `${deviceInfo.name} ${isLan ? 'LAN' : 'Custom'}`,
			deviceHint: deviceInfo.hint,
			codec: base.codec,
			fps: base.fps,
			bitrate: base.bitrate,
			quality: base.quality,
			compression: base.compression,
			autoSelected: false,
		})
	}

	const onSaveEdit = (e: FormEvent) => {
		e.preventDefault()
		if (!editing) return
		saveProfile.mutate({profile: editing, deviceId, activate: true})
	}

	const linkKind = liveRtt === null ? 'Measuring…' : liveRtt < 15 ? `${liveRtt} ms · LAN` : liveRtt < 45 ? `${liveRtt} ms · Remote` : `${liveRtt} ms · WAN`

	return (
		<div className="stagger">
			<div className="page-head" style={{margin: '6px 0 14px'}}>
				<button className="round-btn" aria-label="Back" onClick={onBack}>
					<Icon name="back" size={20} />
				</button>
				<h1 className="title">Remote Apps (RAIL)</h1>
			</div>

			<Card>
				<div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12}}>
					<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
						<Icon name="gpu" size={20} />
					</span>
					<div style={{flex: 1, minWidth: 0}}>
						<b style={{display: 'block', fontSize: 15}}>{deviceInfo.name}</b>
						<span className="muted" style={{fontSize: 12}}>
							{deviceInfo.hint} · Link: {linkKind}
						</span>
					</div>
				</div>
				<div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14}}>
					{clientCodecs.map((c) => (
						<span
							key={c}
							style={{
								fontSize: 11.5,
								padding: '3px 9px',
								borderRadius: 999,
								background: 'rgba(255,255,255,0.07)',
								border: '1px solid rgba(255,255,255,0.1)',
							}}
						>
							{CODEC_LABELS[c]} HW decode
						</span>
					))}
					{activeProfile && (
						<span
							style={{
								fontSize: 11.5,
								padding: '3px 9px',
								borderRadius: 999,
								background: 'rgba(59,130,246,0.18)',
								border: '1px solid rgba(59,130,246,0.4)',
							}}
						>
							Active: {activeProfile.name}
						</span>
					)}
				</div>
				<div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
					<button
						type="button"
						className="btn primary"
						disabled={runProfiler.isPending}
						onClick={() => runProfiler.mutate()}
					>
						{runProfiler.isPending && <span className="spinner" />}
						{runProfiler.isPending ? 'Benchmarking GPU & network…' : 'Run stream profiler'}
					</button>
					<button type="button" className="btn" onClick={startNewProfile}>
						New profile
					</button>
				</div>
				<p className="muted" style={{fontSize: 12, margin: '10px 0 0'}}>
					Benchmarks every hardware codec supported by this browser live on the server GPU, scores FPS, frame pacing, sharpness, and your network RTT, then saves the winning profile for this device.
				</p>
			</Card>

			{benchResults && benchResults.length > 0 && (
				<Group title="Latest profiler results" footer="Highest score wins and is automatically assigned to this device.">
					{benchResults.map((r, idx) => (
						<div className="row static" key={`${r.label}-${idx}`} style={{minHeight: 58}}>
							<span className="row-ico" style={{'--c': idx === 0 ? 'var(--green)' : '#8e8e93'} as CSSProperties}>
								<Icon name={idx === 0 ? 'check' : 'gpu'} size={18} />
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>
									{r.label} {idx === 0 ? '· Selected' : ''}
								</b>
								<span>
									{r.ok
										? `${r.fps} fps · p95 ${r.p95Ms} ms · ${Math.round(r.bitrate / 1000)} Mbps · keyframe ${r.keyKb} KB`
										: 'Not supported on this GPU'}
								</span>
							</span>
							<span style={{fontWeight: 600, fontSize: 13, opacity: idx === 0 ? 1 : 0.72}}>{r.score}/100</span>
						</div>
					))}
				</Group>
			)}

			{editing && (
				<Card>
					<form onSubmit={onSaveEdit} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
						<b style={{fontSize: 15}}>Configure profile</b>
						<Field label="Profile name">
							<input
								className="input"
								value={editing.name}
								onChange={(e) => setEditing({...editing, name: e.target.value})}
								placeholder="e.g. Mac Studio WAN"
								required
							/>
						</Field>
						<Field label="Video codec">
							<Segmented
								label="Video codec"
								value={editing.codec}
								onChange={(v) => setEditing({...editing, codec: v as StreamCodec})}
								options={[
									{id: 'hevc', label: 'HEVC 8-bit'},
									{id: 'hevc10', label: 'HEVC 10-bit'},
									{id: 'h264', label: 'H.264 High'},
								]}
							/>
						</Field>
						<Field label="Target frame rate">
							<Segmented
								label="Target frame rate"
								value={String(editing.fps)}
								onChange={(v) => setEditing({...editing, fps: Number(v)})}
								options={[
									{id: '60', label: '60 FPS'},
									{id: '30', label: '30 FPS'},
								]}
							/>
						</Field>
						<Field label="Quick bitrate preset">
							<div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
								{[
									{label: 'WAN (16 Mbps)', bitrate: 16000, quality: 21, compression: 7},
									{label: 'Balanced (24 Mbps)', bitrate: 24000, quality: 20, compression: 7},
									{label: 'High LAN (48 Mbps)', bitrate: 48000, quality: 16, compression: 7},
									{label: 'Ultra LAN (100 Mbps)', bitrate: 100000, quality: 12, compression: 7},
								].map((p) => (
									<button
										key={p.label}
										type="button"
										className="btn small"
										onClick={() => setEditing({...editing, bitrate: p.bitrate, quality: p.quality, compression: p.compression})}
									>
										{p.label}
									</button>
								))}
							</div>
						</Field>
						<Field label={`Target bitrate (${Math.round(editing.bitrate / 1000)} Mbps)`}>
							<input
								type="range"
								min={8000}
								max={120000}
								step={4000}
								value={Math.min(120000, editing.bitrate)}
								onChange={(e) => setEditing({...editing, bitrate: Number(e.target.value)})}
								style={{width: '100%'}}
							/>
						</Field>
						<Field label={`QVBR Sharpness (QP ${editing.quality}, lower is sharper; 12-14 = near-lossless LAN)`}>
							<input
								type="range"
								min={10}
								max={28}
								step={1}
								value={editing.quality}
								onChange={(e) => setEditing({...editing, quality: Number(e.target.value)})}
								style={{width: '100%'}}
							/>
						</Field>
						<Field label={`GPU Encoder Preset (TU${editing.compression}, higher is faster)`}>
							<input
								type="range"
								min={4}
								max={7}
								step={1}
								value={editing.compression}
								onChange={(e) => setEditing({...editing, compression: Number(e.target.value)})}
								style={{width: '100%'}}
							/>
						</Field>
						<div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
							<button type="button" className="btn" onClick={() => setEditing(null)}>
								Cancel
							</button>
							<button type="submit" className="btn primary" disabled={saveProfile.isPending}>
								Save &amp; activate
							</button>
						</div>
					</form>
				</Card>
			)}

			<Group title="Saved device profiles" footer="Each browser/device automatically uses its assigned profile when opening Linux apps.">
				{(profilesQ.data?.profiles ?? []).length === 0 && !profilesQ.isLoading && (
					<div className="row static">
						<span className="main">
							<b>No saved profiles yet</b>
							<span>Run the stream profiler above to automatically benchmark and save the best preset for this device.</span>
						</span>
					</div>
				)}
				{(profilesQ.data?.profiles ?? []).map((p) => {
					const isActive = p.id === activeId
					return (
						<div className="row static" key={p.id} style={{minHeight: 66}}>
							<span className="row-ico" style={{'--c': isActive ? 'var(--green)' : 'var(--blue)'} as CSSProperties}>
								<Icon name={isActive ? 'check' : 'gpu'} size={18} />
							</span>
							<span className="main">
								<b style={{fontWeight: 550}}>{p.name}</b>
								<span>
									{CODEC_LABELS[p.codec]} · {p.fps} fps · {Math.round(p.bitrate / 1000)} Mbps · QP {p.quality} · TU{p.compression}
									{p.measuredFps ? ` · tested ${p.measuredFps} fps` : ''}
									{p.measuredRttMs ? ` (${p.measuredRttMs} ms RTT)` : ''}
								</span>
							</span>
							<div style={{display: 'flex', gap: 6, flexShrink: 0}}>
								{!isActive && (
									<button
										type="button"
										className="btn get"
										onClick={() => saveProfile.mutate({profile: p, deviceId, activate: true})}
									>
										Use
									</button>
								)}
								<button type="button" className="btn get" onClick={() => setEditing(p)}>
									Edit
								</button>
								<button
									type="button"
									className="btn get"
									style={{color: 'var(--red)'}}
									onClick={async () => {
										const ok = await confirm({
											title: `Delete “${p.name}”?`,
											body: 'Devices using this profile will fall back to automatic codec selection.',
											confirm: 'Delete',
											danger: true,
										})
										if (ok) deleteProfile.mutate(p.id)
									}}
								>
									Delete
								</button>
							</div>
						</div>
					)
				})}
			</Group>
		</div>
	)
}
