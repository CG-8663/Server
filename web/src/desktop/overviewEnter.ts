// Enter in the windows overview must not open the first app while the grid is hidden.
export function overviewEnterOpensApp(key: string, showApps: boolean, count: number): boolean {
	return key === 'Enter' && showApps && count > 0
}
