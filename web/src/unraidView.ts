export type UnraidItemStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export type UnraidItem = {
	kind: 'share' | 'container' | 'vm'
	key: string
	name: string
	size: number | null
	status: UnraidItemStatus
	step?: string
	progress?: number
	error?: string
	note?: string
	path?: string
	machineId?: string
	machineName?: string
}

export type UnraidJob = {
	id: string
	host: string
	startedAt: number
	endedAt: number | null
	destination: string
	items: UnraidItem[]
	cancelled?: boolean
	stopped?: string
}

export function itemStatusForView(item: Pick<UnraidItem, 'status'>, jobRunning: boolean): UnraidItemStatus {
	if (jobRunning) return item.status
	if (item.status === 'running') return 'failed'
	if (item.status === 'waiting') return 'skipped'
	return item.status
}

export function jobSummary(job: Pick<UnraidJob, 'host' | 'endedAt' | 'items' | 'cancelled' | 'stopped'>, connected: boolean) {
	const running = !job.endedAt
	const done = job.items.filter((i) => i.status === 'done').length
	const failed = job.items.filter((i) => itemStatusForView(i, running) === 'failed').length
	const incomplete = !running && (failed > 0 || !!job.stopped || !!job.cancelled || done < job.items.length)
	const heading = running
		? `Moving from ${job.host}… ${done} of ${job.items.length}`
		: incomplete
			? job.items.length
				? `${done} of ${job.items.length} came over`
				: 'Move stopped'
			: 'Everything came over'
	return {
		running,
		done,
		failed,
		incomplete,
		heading,
		canRetry: incomplete && connected,
	}
}

export function isKeyChangedError(message: string | null): boolean {
	return Boolean(message && /key changed/i.test(message))
}

export function retryActionState(scanning: boolean) {
	return {
		disabled: scanning,
		label: scanning ? 'Looking…' : 'Try the rest again',
		showSpinner: scanning,
	}
}
