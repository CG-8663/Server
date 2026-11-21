import {errorText} from './queryNotice.ts'

export function storageDrivesView(q: {isLoading: boolean; error: unknown; data: {length: number} | undefined}): {loading: boolean; error: string | null; showList: boolean} {
	if (q.isLoading && q.data == null) return {loading: true, error: null, showList: false}
	if (q.error && !(q.data && q.data.length)) return {loading: false, error: errorText(q.error), showList: false}
	return {loading: false, error: null, showList: true}
}

// A failed status query has no helperAvailable flag. The "tools aren't set up" card
// is only for a real false, so the error itself has to be shown.
export function storageStatusMessage(q: {error: unknown; data: unknown}): string | null {
	if (q.data != null || !q.error) return null
	return errorText(q.error)
}
