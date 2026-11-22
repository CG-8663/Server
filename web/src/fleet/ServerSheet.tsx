import {lazy, Suspense, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {mutate, query, type Machine} from '../api'
import {useAction} from '../data'
import {Icon} from '../icons'
import {MachineActions} from './machineActions'
import {PinButton} from './PinButton'
import {ServerRings, useServerGaugeMetrics} from './serverGauges'
import {SheetGroup} from './sheetGroup'
import {themeAction} from '../theme/themeAction'
import {ThemePicker} from '../theme/ThemePicker'
import {Row, Sheet, SheetHeader, bytes, duration, haptic, useConfirm, useToast} from '../ui'
import {openStore} from './openStore'
import {SERVER_FLEET_ID} from './list'
import {StoragePage} from '../screens/Storage'
import {BackupsPage} from '../backups'

const MachineFiles = lazy(() => import('../screens/Files').then((m) => ({default: m.Files})))

export function ServerSheet({
	name,
	owner,
	vms,
	onClose,
	onDesktop,
	onTerminal,
	onOpenVm,
	onCreateVm,
}: {
	name: string
	owner: boolean
	vms: Machine[]
	onClose: () => void
	onDesktop: () => void
	onTerminal?: () => void
	onOpenVm: (id: string) => void
	onCreateVm: () => void
}) {
	const {metrics, temp, uptime} = useServerGaugeMetrics()
	const disk = metrics.disks?.[0]
	const diskPct = disk && disk.total > 0 ? Math.round((100 * disk.used) / disk.total) : null
	const themes = useQuery({
		queryKey: ['omarchy.themes'],
		queryFn: () => query<{installed: {slug: string; name: string; current: boolean}[]}>('omarchy.themes'),
		enabled: owner,
	})
	const installed = themes.data?.installed ?? []
	const action = useAction()
	const confirm = useConfirm()
	const toast = useToast()
	const currentTheme = installed.find((t) => t.current)?.name ?? ''
	const [more, setMore] = useState<'storage' | 'backups' | null>(null)
	if (more === 'storage') return <StoragePage onBack={() => setMore(null)} target="host" />
	if (more === 'backups') return <BackupsPage onBack={() => setMore(null)} />
	return (
		<Sheet open onClose={onClose} label={name} tall>
			<SheetHeader
				icon={
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)'}}>
						<Icon name="server" size={32} />
					</span>
				}
				title={name}
				subtitle="Computer · entrypoint · online"
				onClose={onClose}
			/>
			<div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 8}}>
				<PinButton pin={{kind: 'machine', id: SERVER_FLEET_ID, computer: ''}} name={name} />
			</div>
			<MachineActions terminal={!!onTerminal} desktop={owner} onTerminal={() => onTerminal?.()} onDesktop={onDesktop} />
			<ServerRings />
			<SheetGroup title="Disks">
				<Row
					icon="disk"
					color="var(--teal)"
					label={disk?.mount ?? 'Disk'}
					sub={disk ? `${bytes(disk.total - disk.used, 0)} free` : undefined}
					trailing={diskPct != null ? <b>{diskPct}%</b> : undefined}
				/>
				{owner && <Row icon="disk" color="var(--teal)" label="Storage" sub="Drives, pools, and drive sleep" onClick={() => (haptic(6), setMore('storage'))} />}
				{owner && <Row icon="history" color="var(--green)" label="Backups" sub="Apps, settings, and this server’s machines" onClick={() => (haptic(6), setMore('backups'))} />}
			</SheetGroup>
			<SheetGroup title="Now">
				{temp != null && <Row icon="thermo" color="#ef5350" label="Temperature" trailing={<b>{Math.round(temp)}°C</b>} />}
				{uptime !== undefined && <Row icon="clock" color="#8e8e93" label="Up for" trailing={<b>{duration(uptime)}</b>} />}
				{temp == null && uptime === undefined && <p className="quiet">No live readings yet.</p>}
			</SheetGroup>
			<div className="section-head" style={{margin: '20px 4px 8px'}}>
				<h2 style={{fontSize: 16}}>Files</h2>
			</div>
			<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
				<MachineFiles scope={{kind: 'server'}} windowId="machine:server" />
			</Suspense>
			<SheetGroup title="Virtual machines">
				{vms.length === 0 ? (
					<p className="quiet">No virtual machines on {name}.</p>
				) : (
					vms.map((vm) => (
						<Row key={vm.id} icon="machine" label={vm.name} sub="Virtual machine" onClick={() => (haptic(6), onOpenVm(vm.id))} />
					))
				)}
				<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), onCreateVm())}>
					<Icon name="plus" size={15} /> Create VM
				</button>
			</SheetGroup>
			<SheetGroup title="Apps">
				<Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${name}`} onClick={() => (haptic(6), onClose(), openStore({id: SERVER_FLEET_ID, kind: 'server', name}))} />
			</SheetGroup>
			{owner && (
				<SheetGroup title="Manage">
					<Row
						icon="update"
						color="#2fbf71"
						label="Update"
						sub="Downloads the update, then restarts"
						onClick={async () => {
							if (!(await confirm({title: `Update ${name}?`, body: 'The update downloads, then this server restarts. Your apps and machines stop briefly. Keep the server powered on.', confirm: 'Update', icon: 'update'}))) return
							toast('Updating…')
							mutate('system.update').catch(() => {})
						}}
					/>
					<Row
						icon="palette"
						color="#a855f7"
						label="Theme"
						trailing={
							<ThemePicker
								themes={installed.map((t) => t.name)}
								theme={currentTheme}
								disabled={action.isPending || !installed.length}
								onPick={(picked) => {
									const slug = installed.find((t) => t.name === picked)?.slug
									if (!slug) return
									const call = themeAction({kind: 'server', slug})
									if ('path' in call) action.mutate({path: call.path, input: call.input, done: `Setting ${picked} on ${name}…`})
								}}
							/>
						}
					/>
					<Row
						icon="power"
						color="#ef5350"
						label="Restart"
						onClick={async () => {
							if (!(await confirm({title: `Restart ${name}?`, body: 'Anything open on it closes. The server comes back on its own.', confirm: 'Restart', icon: 'power'}))) return
							action.mutate({path: 'system.restart', done: `Restarting ${name}…`})
						}}
					/>
				</SheetGroup>
			)}
		</Sheet>
	)
}
