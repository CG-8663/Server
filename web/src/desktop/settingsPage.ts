export const SETTINGS_PAGE_STORAGE_KEY = 'omarchy-server:settings-page'

export function settingsPayloadFor(page: string, nonce: number): {page: string; pageNonce: number} {
	return {page, pageNonce: nonce}
}

// Settings reads the storage key only as the first state value, so a new key remounts it on that page.
export function settingsRemountKey(payload?: {page?: string; pageNonce?: number} | null): string {
	return `${payload?.page ?? ''}:${payload?.pageNonce ?? ''}`
}

export function rememberSettingsPage(storage: {setItem: (key: string, value: string) => void}, page: string): void {
	storage.setItem(SETTINGS_PAGE_STORAGE_KEY, page)
}
