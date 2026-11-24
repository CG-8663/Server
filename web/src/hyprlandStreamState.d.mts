export type StreamCodec = 'hevc444' | 'hevc' | 'hevc10' | 'h264'

export type StreamControlState<TTier extends string> = {
	handshakeTier: TTier
	handshakeEffective444: boolean
	appliedTier: TTier
	applied444Pref: boolean
	appliedCodec: StreamCodec
}

export function parseActualCodec(encoderStr: unknown): StreamCodec
export function isStreamCodec(v: unknown): v is StreamCodec
export function createStreamControlState<TTier extends string>(opts: {
	tier: TTier
	chroma444Pref: boolean
	effective444: boolean
	codec: StreamCodec
}): StreamControlState<TTier>
export function shouldReplayHandshakeReconfig<TTier extends string>(
	state: StreamControlState<TTier>,
	opts: {tier: TTier; chroma444Pref: boolean; supportsHevc444: boolean},
): boolean
export function applyMetaToStreamControl<TTier extends string>(
	state: StreamControlState<TTier>,
	encoderStr: unknown,
): {state: StreamControlState<TTier>; actualCodec: StreamCodec}
export function applyReconfigAppliedToStreamControl<TTier extends string>(
	state: StreamControlState<TTier>,
	opts: {codec: unknown; tier: TTier; chroma444Pref: boolean},
): {state: StreamControlState<TTier>; confirmedCodec: StreamCodec | null}
export function applyReconfigUnsupportedToStreamControl<TTier extends string>(
	state: StreamControlState<TTier>,
): {tier: TTier; chroma444Pref: boolean; codec: StreamCodec}
