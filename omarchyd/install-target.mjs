// apps.install still runs on this server. A target of "server", or no target, is that install.
// Any other id is refused until that computer or guest can actually host the app.

export function refuseForeignInstall(target) {
	if (target == null || target === '' || target === 'server') return null
	return 'That computer can’t take this install yet. Choose this server, or open the App Store from a machine that can host apps.'
}
