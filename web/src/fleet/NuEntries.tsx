import {Icon, type IconName} from '../icons'

export type NuItem = {
	key: string
	name: string
	size?: string
	modified?: string
	icon: IconName
	onOpen?: () => void
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
					const label = <span className="nu-label">{item.name}</span>
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
						<span className="nu-name">{item.name}</span>
						<span className="nu-size">{item.size || '—'}</span>
						<span className="nu-mod">{item.modified || ''}</span>
					</>
				)
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
