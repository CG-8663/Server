import type {SwarmMetrics} from './gauges'

// The Linux connector (connector/agent.py) is the guest connector. Windows, macOS, and Home Assistant
// cannot run it. An unknown guest is offered the install command, and the command says Linux only.
export function linuxConnectorOs(osId = ''): boolean {
	const id = osId.toLowerCase()
	return !/win|macos|osx|darwin|haos|home-?assistant/.test(id)
}

export function isGuestAgent(agent: {guestOf?: string}): boolean {
	return typeof agent.guestOf === 'string' && /^[a-f0-9]{8}$/.test(agent.guestOf)
}

/** The connector installed on this virtual machine. An online one wins over an older install. */
export function guestAgent<T extends {guestOf?: string; online: boolean; enrolledAt: number}>(agents: readonly T[], machineId: string): T | undefined {
	const linked = agents.filter((agent) => agent.guestOf === machineId && isGuestAgent(agent))
	return linked.find((agent) => agent.online) ?? [...linked].sort((a, b) => b.enrolledAt - a.enrolledAt)[0]
}

/** Host CPU and memory for a running guest. In-guest disk use is not in this sample. */
export function hostGuestMetrics(last: {cpu: number; memMb: number} | null | undefined, memoryMb: number, vcpus: number): SwarmMetrics | null {
	if (!last || !Number.isFinite(last.cpu)) return null
	const total = memoryMb > 0 ? memoryMb * 1024 * 1024 : 0
	const used = Number.isFinite(last.memMb) ? Math.max(0, last.memMb) * 1024 * 1024 : 0
	return {
		cpu: last.cpu,
		cores: vcpus > 0 ? vcpus : undefined,
		mem: total > 0 ? {total, used} : null,
	}
}
