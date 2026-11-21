export type BackupSchedule = {frequency: 'off' | 'daily' | 'weekly'; hour: number; weekday: number}

export function sameFolders(a: readonly string[], b: readonly string[]): boolean {
	const setA = new Set(a)
	const setB = new Set(b)
	if (setA.size !== setB.size) return false
	for (const item of setA) if (!setB.has(item)) return false
	return true
}

export function computerSheetChanged(
	picked: readonly string[],
	savedFolders: readonly string[],
	schedule: BackupSchedule,
	savedSchedule: BackupSchedule,
): boolean {
	return (
		!sameFolders(picked, savedFolders) ||
		schedule.frequency !== savedSchedule.frequency ||
		schedule.hour !== savedSchedule.hour ||
		schedule.weekday !== savedSchedule.weekday
	)
}
