import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react'

export type LaunchItem = {key: string; label: string; icon: (size: number) => ReactNode}

export function Launcher({onClose, onOpen, items}: {onClose: () => void; onOpen: (key: string) => void; items: LaunchItem[]}) {
	const [q, setQ] = useState('')
	const [sel, setSel] = useState(0)
	const input = useRef<HTMLInputElement>(null)
	const rows = useMemo(() => items.filter((r) => !q || r.label.toLowerCase().includes(q.toLowerCase())), [items, q])
	const pick = (key: string) => {
		onOpen(key)
		onClose()
	}
	useEffect(() => {
		input.current?.focus()
	}, [])
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				setSel((s) => Math.min(rows.length - 1, s + 1))
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault()
				setSel((s) => Math.max(0, s - 1))
			}
			if (e.key === 'Enter' && rows[sel]) {
				e.preventDefault()
				pick(rows[sel].key)
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	})
	return (
		<div className="hypr-overlay" onClick={onClose}>
			<div className="hypr-launcher" role="dialog" aria-label="Launcher" onClick={(e) => e.stopPropagation()}>
				<input ref={input} value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} placeholder="Open…" aria-label="Filter" />
				<ul>
					{rows.map((r, i) => (
						<li key={r.key}>
							<button className={i === sel ? 'on' : ''} onClick={() => pick(r.key)} onMouseEnter={() => setSel(i)}>
								<span className="hypr-launch-ico">{r.icon(22)}</span>
								{r.label}
							</button>
						</li>
					))}
					{!rows.length && <li className="muted">Nothing matches</li>}
				</ul>
			</div>
		</div>
	)
}
