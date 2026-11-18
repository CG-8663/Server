const tool = (name, rpc, description, properties = {}, ownerOnly = false) => ({
	name,
	rpc,
	description,
	parameters: {type: 'object', properties},
	ownerOnly,
})

const mutation = (name, rpc, description, properties = {}, ownerOnly = false) => ({...tool(name, rpc, description, properties, ownerOnly), kind: 'mutation'})

export const READ_TOOLS = [
	tool('system_diskUsage', 'system.diskUsage', 'Disk used and free on this server'),
	tool('system_cpuUsage', 'system.cpuUsage', 'CPU used on this server'),
	tool('system_memoryUsage', 'system.memoryUsage', 'Memory used on this server'),
	tool('system_gpuUsage', 'system.gpuUsage', 'GPU used on this server'),
	tool('system_cpuTemperature', 'system.cpuTemperature', 'CPU temperature on this server'),
	tool('system_uptime', 'system.uptime', 'How long this server has been up'),
	tool('system_device', 'system.device', 'This server’s device and OS'),
	tool('system_getHostname', 'system.getHostname', 'This server’s hostname'),
	tool('system_getIpAddresses', 'system.getIpAddresses', 'This server’s IP addresses'),
	tool('apps_list', 'apps.list', 'Apps installed on this server'),
	tool('appStore_app', 'appStore.app', 'One app from the store', {appId: {type: 'string', description: 'App id'}}),
	tool('appStore_search', 'appStore.registry', 'Search the app store', {
		q: {type: 'string', description: 'Search text'},
		category: {type: 'string'},
		limit: {type: 'integer', description: 'Max results, 1–24'},
	}),
	tool('machines_list', 'machines.list', 'Virtual machines on this server'),
	tool('machines_details', 'machines.details', 'One virtual machine', {id: {type: 'string', description: 'Machine id'}}),
	tool('machines_osImages', 'machines.osImages', 'Operating system images available for a new machine'),
	tool('machines_capabilities', 'machines.capabilities', 'What this server can give a virtual machine'),
	tool('swarm_list', 'swarm.list', 'Computers in the Local swarm', {}, true),
	tool('omarchy_plugins', 'omarchy.plugins', 'Omarchy plugins that can be installed', {
		q: {type: 'string'},
		limit: {type: 'integer'},
	}),
	tool('omarchy_listBackgrounds', 'omarchy.backgrounds', 'List this machine’s wallpaper and background images, grouped by Omarchy theme. Use this when they ask which wallpapers exist.', {
		theme: {type: 'string', description: 'Theme slug; omit for every theme'},
	}),
	tool('notifications_get', 'notifications.get', 'Notifications waiting on this server'),
]

export const WRITE_TOOLS = [
	mutation('apps_install', 'apps.install', 'Install an app', {appId: {type: 'string'}}),
	mutation('apps_start', 'apps.start', 'Start an app', {appId: {type: 'string'}}),
	mutation('apps_stop', 'apps.stop', 'Stop an app', {appId: {type: 'string'}}),
	mutation('apps_restart', 'apps.restart', 'Restart an app', {appId: {type: 'string'}}),
	mutation('apps_uninstall', 'apps.uninstall', 'Uninstall an app', {appId: {type: 'string'}}),
	mutation('apps_update', 'apps.update', 'Update an app', {appId: {type: 'string'}}),
	mutation('machines_create', 'machines.create', 'Create a virtual machine', {
		name: {type: 'string'},
		osId: {type: 'string'},
		cores: {type: 'integer'},
		memoryGb: {type: 'integer'},
		diskSizeGb: {type: 'integer'},
		username: {type: 'string'},
	}),
	mutation('machines_start', 'machines.start', 'Start a virtual machine', {id: {type: 'string'}}),
	mutation('machines_stop', 'machines.stop', 'Stop a virtual machine', {id: {type: 'string'}}),
	mutation('machines_restart', 'machines.restart', 'Restart a virtual machine', {id: {type: 'string'}}),
	mutation('machines_uninstall', 'machines.uninstall', 'Remove a virtual machine', {id: {type: 'string'}}),
	mutation('machines_updateSettings', 'machines.updateSettings', 'Change a virtual machine’s port forwards', {
		id: {type: 'string'},
		portForwards: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: {type: 'string'},
					protocol: {type: 'string', enum: ['tcp', 'udp']},
					hostPort: {type: 'integer'},
					guestPort: {type: 'integer'},
				},
			},
		},
	}),
	mutation('swarm_action', 'swarm.action', 'Install a plugin, set a theme, or reboot a swarm computer', {
		id: {type: 'string'},
		name: {type: 'string', enum: ['plugin-install', 'plugin-remove', 'theme-set', 'reboot']},
		pluginId: {type: 'string'},
		theme: {type: 'string'},
	}, true),
	mutation('swarm_rename', 'swarm.rename', 'Rename a swarm computer', {id: {type: 'string'}, name: {type: 'string'}}, true),
	mutation('omarchy_setTheme', 'omarchy.setTheme', 'Set this machine’s Omarchy theme colours. After this, propose omarchy_setBackground so they can pick a wallpaper.', {slug: {type: 'string'}}, true),
	mutation('omarchy_setBackground', 'omarchy.setBackground', 'Change this machine’s desktop wallpaper and the web app background. Use this whenever they ask to change the wallpaper, background, backdrop, or picture. Pass the theme slug (for example nord). The person picks the image on the Approve card.', {
		theme: {type: 'string', description: 'Theme slug whose pictures to show'},
		id: {type: 'string', description: 'Background id to pre-select (16 hex characters)'},
	}, true),
	mutation('omarchy_installPlugin', 'omarchy.installPlugin', 'Install an Omarchy plugin', {id: {type: 'string'}}, true),
	mutation('omarchy_removePlugin', 'omarchy.removePlugin', 'Remove an Omarchy plugin', {id: {type: 'string'}}, true),
	mutation('system_restart', 'system.restart', 'Restart this server', {}, true),
	mutation('system_shutdown', 'system.shutdown', 'Shut down this server', {}, true),
]

const readByName = new Map(READ_TOOLS.map((t) => [t.name, t]))
const writeByName = new Map(WRITE_TOOLS.map((t) => [t.name, t]))

export function toolsFor(role) {
	const owner = role === 'owner'
	return [...READ_TOOLS, ...WRITE_TOOLS].filter((t) => owner || !t.ownerOnly)
}

export function openAiTools(role) {
	return toolsFor(role).map((t) => ({
		type: 'function',
		function: {name: t.name, description: t.description, parameters: t.parameters},
	}))
}

export function filterAppStore(registry, input = {}) {
	const raw = Math.floor(Number(input?.limit))
	const limit = Math.min(24, Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : 12))
	const q = String(input?.q ?? '').trim().toLowerCase()
	const category = String(input?.category ?? '').trim().toLowerCase()
	const apps = []
	for (const store of Array.isArray(registry) ? registry : []) {
		for (const a of store?.apps ?? []) apps.push(a)
	}
	return apps.filter((a) => {
		if (category && String(a?.category ?? '').toLowerCase() !== category) return false
		if (!q) return true
		return `${a?.id ?? ''} ${a?.name ?? ''} ${a?.tagline ?? ''}`.toLowerCase().includes(q)
	}).slice(0, limit).map((a) => ({
		id: a?.id,
		name: a?.name,
		tagline: a?.tagline,
		category: a?.category,
		version: a?.version,
	}))
}

export function lookupTool(name) {
	return readByName.get(name) ?? null
}

export function writeTool(name) {
	return writeByName.get(name) ?? null
}

export function isWriteTool(name) {
	return writeByName.has(name)
}
