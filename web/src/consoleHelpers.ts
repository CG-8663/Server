export type DisconnectAction = 'ignore' | 'superseded' | 'reconnect'

// Decide what the console should do when noVNC fires a disconnect event.
export function consoleDisconnectAction({disposed, superseded}: {disposed: boolean; superseded: boolean; clean?: boolean}): DisconnectAction {
	if (disposed) return 'ignore'
	if (superseded) return 'superseded'
	return 'reconnect'
}
