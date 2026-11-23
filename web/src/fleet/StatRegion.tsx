// The stats region. A tap cycles the account's saved view. Home's aggregate gauges do not use this.
import {createContext, useContext, useState, type ReactNode} from 'react'

import {Icon} from '../icons'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {Ring, StatChip, haptic, levelColor, type Prefs} from '../ui'
import {STAT_VIEW_NAME, gaugeCaption, nextStatView, readingFace, statReadings, statViewOf, type StatReading, type StatView} from './statView'

type StatViewApi = {view: StatView; cycle: () => void}

const StatViewContext = createContext<StatViewApi | null>(null)

export function StatViewProvider({prefs, setPrefs, children}: {prefs: Prefs; setPrefs: (next: Prefs | ((current: Prefs) => Prefs)) => void; children: ReactNode}) {
	const view = statViewOf(prefs.statView)
	const [note, setNote] = useState('')
	const cycle = () => {
		haptic(8)
		let name = ''
		setPrefs((current) => {
			const next = nextStatView(statViewOf(current.statView))
			name = STAT_VIEW_NAME[next]
			return {...current, statView: next}
		})
		setNote(name ? `Stats shown as ${name}` : '')
	}
	return (
		<StatViewContext.Provider value={{view, cycle}}>
			{children}
			<div className="sr-only" role="status" aria-live="polite">
				{note}
			</div>
		</StatViewContext.Provider>
	)
}

export function useStatView(): StatViewApi {
	const api = useContext(StatViewContext)
	if (!api) throw new Error('StatViewProvider missing')
	return api
}

export function LiveStats({metrics, temp = null, diskSizeGb = null}: {metrics: SwarmMetrics | null | undefined; temp?: number | null; diskSizeGb?: number | null}) {
	return <StatRegion readings={statReadings({gauges: swarmGaugeItems(metrics), temp, diskSizeGb})} />
}

function ValueFace({text}: {text: string}) {
	const size = 84
	const stroke = 8
	const r = (size - stroke) / 2
	return (
		<div className="ring" style={{width: size, height: size, color: 'var(--fg)'}}>
			<svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
				<circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
			</svg>
			<div className="center">
				<span className={text.length > 4 ? 'pct compact' : 'pct'}>{text}</span>
			</div>
		</div>
	)
}

/** One button for the whole region. Its name is the readings, so each machine stays distinct. */
export function StatRegion({readings}: {readings: readonly StatReading[]}) {
	const {view, cycle} = useStatView()
	if (!readings.length) return null
	const summary = `${readings.map((r) => `${r.label} ${r.text}`).join(', ')}. Shown as ${STAT_VIEW_NAME[view]}.`
	return (
		<button
			type="button"
			className={`stat-region stat-${view}`}
			onClick={(e) => {
				e.stopPropagation()
				cycle()
			}}
		>
			<span className="sr-only">{summary}</span>
			{view === 'line' && (
				<span className="specs" aria-hidden="true">
					{readings.map((r) => (
						<StatChip key={r.id} icon={r.icon} label={r.label}>
							{r.text}
						</StatChip>
					))}
				</span>
			)}
			{view === 'blocks' && (
				<span className="mm-squares" aria-hidden="true">
					{readings.map((r) => (
						<span className="mm-square" key={r.id}>
							<Icon name={r.icon} size={16} />
							<b>{r.text}</b>
							<span>{r.label}</span>
						</span>
					))}
				</span>
			)}
			{view === 'gauges' && (
				<span className="glass gauges" data-n={readings.length} aria-hidden="true">
					{readings.map((r) => {
						const caption = gaugeCaption(r)
						return (
							<span className="gauge" key={r.id}>
								{readingFace(r) === 'arc' && r.percent != null ? (
									<Ring value={r.percent} color={r.color ?? levelColor(r.percent)} label={`${r.label} ${r.text}`}>
										<span className="pct">
											{Math.round(r.percent)}
											<small>%</small>
										</span>
									</Ring>
								) : (
									<ValueFace text={r.text} />
								)}
								<span className="k">{r.label}</span>
								{caption ? <span className="sub">{caption}</span> : null}
							</span>
						)
					})}
				</span>
			)}
		</button>
	)
}
