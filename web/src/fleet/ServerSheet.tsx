import {lazy, Suspense, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {query, type Machine} from '../api'
import {useAction} from '../data'
import {Icon} from '../icons'
import {MachineActions} from './machineActions'
import {MachineShell, MachineTabs} from './MachineTabs'
import {PinButton} from './PinButton'
import {ServerRings, useServerGaugeMetrics} from './serverGauges'
import {SheetGroup} from './sheetGroup'
import {themeAction} from '../theme/themeAction'
import {ThemePicker} from '../theme/ThemePicker'
import {Row, SheetHeader, bytes, duration, haptic} from '../ui'
import {openStore} from './openStore'
import {SERVER_FLEET_ID} from './list'
import {StoragePanel} from '../screens/Storage'
import {BackupsPage} from '../backups'
import {ServerLogs, ServerNetwork} from '../screens/machineHost'

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
	bare,
}: {
	name: string
	owner: boolean
	vms: Machine[]
	onClose: () => void
	onDesktop: () => void
	onTerminal?: () => void
	onOpenVm: (id: string) => void
	onCreateVm: () => void
	/** Desktop Machines window: the page sits in the split, not over the screen. */
	bare?: boolean
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
	const currentTheme = installed.find((t) => t.current)?.name ?? ''
	const [tab, setTab] = useState('files')
	const [more, setMore] = useState<'storage' | 'backups' | null>(null)
	if (more === 'storage') return <StoragePanel bare={bare} target="host" onClose={() => setMore(null)} />
	if (more === 'backups') return <BackupsPage onBack={() => setMore(null)} />
	const tabs = [
		{
			id: 'files',
			label: 'Files',
			body: (
				<Suspense fallback={<div className="skeleton" style={{height: 180, borderRadius: 16}} />}>
					<MachineFiles scope={{kind: 'server' as const}} windowId="machine:server" />
				</Suspense>
			),
		},
		{
			id: 'apps',
			label: 'Apps',
			body: <Row icon="store" color="var(--accent)" label="App Store" sub={`Installs on ${name}`} onClick={() => (haptic(6), onClose(), openStore({id: SERVER_FLEET_ID, kind: 'server', name}))} />,
		},
		...(owner
			? [
					{id: 'storage', label: 'Storage', body: <Row icon="disk" color="var(--teal)" label="Storage" sub="Drives, pools, and drive sleep" onClick={() => (haptic(6), setMore('storage'))} />},
					{id: 'backups', label: 'Backups', body: <Row icon="history" color="var(--green)" label="Backups" sub="Apps, settings, and this server’s machines" onClick={() => (haptic(6), setMore('backups'))} />},
				]
			: []),
		{
			id: 'machines',
			label: 'Virtual machines',
			body: (
				<>
					{vms.length === 0 ? <p className="quiet">No virtual machines on {name}.</p> : vms.map((vm) => <Row key={vm.id} icon="machine" label={vm.name} sub="Virtual machine" onClick={() => (haptic(6), onOpenVm(vm.id))} />)}
					<button type="button" className="btn small" style={{margin: '8px 12px 12px'}} onClick={() => (haptic(6), onCreateVm())}>
						<Icon name="plus" size={15} /> Create VM
					</button>
				</>
			),
		},
		...(owner
			? [
					{id: 'network', label: 'Network', body: <ServerNetwork />},
					{id: 'logs', label: 'Logs', body: <ServerLogs />},
					{
						id: 'manage',
						label: 'Manage',
						body: (
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
						),
					},
				]
			: []),
	]
	return (
		<MachineShell bare={bare} label={name} onClose={onClose}>
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
			<SheetGroup title="Now">
				<Row icon="disk" color="var(--teal)" label={disk?.mount ?? 'Disk'} sub={disk ? `${bytes(disk.used, 1)} of ${bytes(disk.total, 0)}` : undefined} trailing={diskPct != null ? <b>{diskPct}%</b> : undefined} />
				{temp != null && <Row icon="thermo" color="#ef5350" label="Temperature" trailing={<b>{Math.round(temp)}°C</b>} />}
				{uptime !== undefined && <Row icon="clock" color="#8e8e93" label="Up for" trailing={<b>{duration(uptime)}</b>} />}
			</SheetGroup>
			<MachineTabs label={`${name} sections`} tabs={tabs} tab={tab} onTab={setTab} />
		</MachineShell>
	)
}
