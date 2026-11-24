// Pure state transitions for Hyprland stream codec confirmation and live-reconfig rollback.

export function parseActualCodec(encoderStr) {
	const s = String(encoderStr || 'h264').toLowerCase()
	if (s.startsWith('hevc444')) return 'hevc444'
	if (s.startsWith('hevc10')) return 'hevc10'
	if (s.startsWith('hevc')) return 'hevc'
	return 'h264'
}

export function isStreamCodec(v) {
	return v === 'h264' || v === 'hevc' || v === 'hevc10' || v === 'hevc444'
}

export function createStreamControlState({tier, chroma444Pref, effective444, codec}) {
	return {
		handshakeTier: tier,
		handshakeEffective444: Boolean(effective444),
		appliedTier: tier,
		applied444Pref: Boolean(chroma444Pref),
		appliedCodec: codec,
	}
}

export function shouldReplayHandshakeReconfig(state, {tier, chroma444Pref, supportsHevc444}) {
	const latestEffective444 = Boolean(supportsHevc444 && chroma444Pref)
	return tier !== state.handshakeTier || latestEffective444 !== state.handshakeEffective444
}

export function applyMetaToStreamControl(state, encoderStr) {
	const actualCodec = parseActualCodec(encoderStr)
	return {
		state: {
			...state,
			appliedCodec: actualCodec,
		},
		actualCodec,
	}
}

export function applyReconfigAppliedToStreamControl(state, {codec, tier, chroma444Pref}) {
	const nextCodec = isStreamCodec(codec) ? codec : state.appliedCodec
	return {
		state: {
			...state,
			appliedTier: tier,
			applied444Pref: Boolean(chroma444Pref),
			appliedCodec: nextCodec,
		},
		confirmedCodec: isStreamCodec(codec) ? codec : null,
	}
}

export function applyReconfigUnsupportedToStreamControl(state) {
	return {
		tier: state.appliedTier,
		chroma444Pref: state.applied444Pref,
		codec: state.appliedCodec,
	}
}
