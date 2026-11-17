// Tooltip on the version tag: how long this omarchyd has been up, and which git revision it is.
export function formatRunningSince(
	startedAt?: number,
	{now = Date.now(), revision, locale, timeZone}: {now?: number; revision?: string; locale?: string; timeZone?: string} = {},
): string {
	const parts: string[] = []
	if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
		const s = Math.max(0, (now - startedAt) / 1000)
		let duration: string
		if (s < 60) duration = 'less than a minute'
		else if (s < 3600) {
			const n = Math.max(1, Math.round(s / 60))
			duration = n === 1 ? '1 minute' : `${n} minutes`
		} else if (s < 86400) {
			const n = Math.max(1, Math.round(s / 3600))
			duration = n === 1 ? '1 hour' : `${n} hours`
		} else {
			const n = Math.max(1, Math.round(s / 86400))
			duration = n === 1 ? '1 day' : `${n} days`
		}
		const when = new Intl.DateTimeFormat(locale, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			...(timeZone ? {timeZone} : {}),
		}).format(new Date(startedAt))
		parts.push(`Running ${duration} (since ${when})`)
	}
	if (revision) parts.push(`Revision ${revision}`)
	return parts.length ? `${parts.join('. ')}.` : ''
}
