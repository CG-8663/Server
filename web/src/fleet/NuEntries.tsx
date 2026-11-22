import type {KeyboardEvent, ReactNode} from 'react'

import {Icon, type IconName} from '../icons'

export type NuItem = {
	key: string
	name: string
	size?: string
	modified?: string
	icon: IconName
	onOpen?: () => void
	favorite?: boolean
	onFavorite?: () => void
}

function favoriteButton(item: NuItem): ReactNode {
	if (!item.onFavorite) return null
	return (
		<button
			type="button"
			className="nu-fav"
			aria-pressed={!!item.favorite}
			aria-label={item.favorite ? `Unfavorite ${item.name}` : `Favorite ${item.name}`}
			onClick={(e) => {
				e.stopPropagation()
				item.onFavorite?.()
			}}
		>
			<Icon name={item.favorite ? 'star-filled' : 'star'} size={16} />
		</button>
	)
}

function onKey(item: NuItem, e: KeyboardEvent) {
	if (!item.onOpen) return
	if (e.key !== 'Enter' && e.key !== ' ') return
	e.preventDefault()
	item.onOpen()
}

// List and icon view shared by the Files manager. A row without onOpen is a file, not a button.
export function NuEntries({items, grid}: {items: NuItem[]; grid: boolean}) {
	if (grid) {
		return (
			<div className="nu-grid">
				{items.map((item) => {
					const glyph = (
						<span className={`nu-glyph${item.onOpen ? '' : ' file'}`}>
							<Icon name={item.icon} size={28} />
						</span>
					)
					const label = (
						<span className="nu-label">
							<span className="nu-name-text">{item.name}</span>
							{favoriteButton(item)}
						</span>
					)
					if (item.onFavorite) {
						return (
							<div key={item.key} className="nu-cell" role={item.onOpen ? 'button' : undefined} tabIndex={item.onOpen ? 0 : undefined} onClick={item.onOpen} onKeyDown={(e) => onKey(item, e)}>
								{glyph}
								{label}
							</div>
						)
					}
					return item.onOpen ? (
						<button key={item.key} type="button" className="nu-cell" onClick={item.onOpen}>
							{glyph}
							{label}
						</button>
					) : (
						<div key={item.key} className="nu-cell">
							{glyph}
							{label}
						</div>
					)
				})}
			</div>
		)
	}
	return (
		<div>
			<div className="nu-head" aria-hidden="true">
				<span />
				<span>Name</span>
				<span className="nu-size">Size</span>
				<span className="nu-mod">Modified</span>
			</div>
			{items.map((item) => {
				const inner = (
					<>
						<span className={`nu-glyph${item.onOpen ? '' : ' file'}`}>
							<Icon name={item.icon} size={18} />
						</span>
						<span className="nu-name">
							<span className="nu-name-text">{item.name}</span>
							{favoriteButton(item)}
						</span>
						<span className="nu-size">{item.size || '—'}</span>
						<span className="nu-mod">{item.modified || ''}</span>
					</>
				)
				if (item.onFavorite) {
					return (
						<div key={item.key} className="nu-row" role={item.onOpen ? 'button' : undefined} tabIndex={item.onOpen ? 0 : undefined} onClick={item.onOpen} onKeyDown={(e) => onKey(item, e)}>
							{inner}
						</div>
					)
				}
				return item.onOpen ? (
					<button key={item.key} type="button" className="nu-row" onClick={item.onOpen}>
						{inner}
					</button>
				) : (
					<div key={item.key} className="nu-row">
						{inner}
					</div>
				)
			})}
		</div>
	)
}
