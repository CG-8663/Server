import type {IconName} from './icons'

export function osLook(osId = ''): {icon: IconName; bg: string; name: string} {
	const id = osId.toLowerCase()
	if (id.includes('ubuntu')) return {icon: 'ubuntu', bg: 'linear-gradient(140deg,#f2703c,#c7381d)', name: 'Ubuntu'}
	if (id.includes('debian')) return {icon: 'debian', bg: 'linear-gradient(140deg,#d70a53,#8a0636)', name: 'Debian'}
	if (id.includes('omarchy')) return {icon: 'terminal', bg: 'linear-gradient(140deg,#2b2b2b,#0b0b0b)', name: 'Omarchy'}
	if (id.includes('fedora')) return {icon: 'server', bg: 'linear-gradient(140deg,#3c6eb4,#294172)', name: 'Fedora'}
	if (id.includes('alpine')) return {icon: 'server', bg: 'linear-gradient(140deg,#0d597f,#073449)', name: 'Alpine'}
	if (id.includes('arch')) return {icon: 'server', bg: 'linear-gradient(140deg,#1793d1,#0b5a85)', name: 'Arch Linux'}
	if (id.includes('win')) return {icon: 'windows', bg: 'linear-gradient(140deg,#2b9af3,#0058b0)', name: 'Windows'}
	if (id.includes('mac')) return {icon: 'macos', bg: 'linear-gradient(140deg,#8e8e93,#3a3a3c)', name: 'macOS'}
	return {icon: 'server', bg: 'linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #000))', name: osId || 'Linux'}
}
