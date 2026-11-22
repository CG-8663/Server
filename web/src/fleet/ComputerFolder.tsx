import {useQuery} from '@tanstack/react-query'
import type {CSSProperties} from 'react'

import {query} from '../api'
import {Icon} from '../icons'
import {bytes, haptic} from '../ui'

type Entry = {name: string; size: number; mtime: number | null; dir: boolean}

// A joined computer's home folder. Listing uses the connector. This is not the server file browser.
export function ComputerFolder({id, rel, onOpen}: {id: string; rel: string; onOpen: (rel: string) => void}) {
	const listing = useQuery({
		queryKey: ['swarm.files.list', id, rel],
		queryFn: () => query<{path: string; entries: Entry[]; truncated?: boolean}>('swarm.files.list', {id, path: rel}),
	})
	const entries = listing.data?.entries ?? []
	if (listing.isLoading) return <div className="skeleton" style={{height: 160, borderRadius: 20}} />
	if (listing.error) {
		return (
			<div className="error" role="alert">
				<Icon name="alert" size={18} />
				{(listing.error as Error).message}
			</div>
		)
	}
	return (
		<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
			{entries.length === 0 && (
				<div className="row static">
					<span className="main">
						<b>Empty folder</b>
					</span>
				</div>
			)}
			{entries.map((entry) => {
				const next = rel ? `${rel}/${entry.name}` : entry.name
				if (!entry.dir) {
					return (
						<div key={entry.name} className="row static">
							<span className="row-ico" style={{'--c': 'var(--muted)'} as CSSProperties}>
								<Icon name="logfile" size={18} />
							</span>
							<span className="main">
								<b>{entry.name}</b>
								<span>{bytes(entry.size)}</span>
							</span>
						</div>
					)
				}
				return (
					<button key={entry.name} type="button" className="row" onClick={() => (haptic(5), onOpen(next))}>
						<span className="row-ico" style={{'--c': 'var(--blue)'} as CSSProperties}>
							<Icon name="folder" size={18} />
						</span>
						<span className="main">
							<b>{entry.name}</b>
							<span>Folder</span>
						</span>
						<Icon name="chevron" size={18} className="chev" />
					</button>
				)
			})}
			{listing.data?.truncated && <p className="muted" style={{fontSize: 13, margin: '8px 14px'}}>This list is the first part of the folder.</p>}
		</div>
	)
}
