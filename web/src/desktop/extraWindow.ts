// A second terminal shares one shell (keyed by user and app, not by window), so it is focused.
// Files has no such share, so New window still opens another Files window.
export function extraWindowAction(kind: string, alreadyOpen: boolean): 'focus' | 'open' {
	if (kind === 'terminal' && alreadyOpen) return 'focus'
	return 'open'
}
