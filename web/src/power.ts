import {mutate} from './api'

type Confirm = (o: {title: string; body: string; confirm: string; danger?: boolean; icon?: 'restart' | 'power' | 'alert'}) => Promise<boolean>
const OFF = /^BOOT_START_OFF: ?/

/** Restart or shut down the server. If it wouldn't come back by itself after this (it starts at
 * boot only once that's on), the server says so first and the person decides. */
export async function serverPower(kind: 'restart' | 'shutdown', confirm: Confirm, toast: (m: string, error?: boolean) => void) {
	const ok = await confirm({
		title: kind === 'restart' ? 'Restart your server?' : 'Shut down your server?',
		body:
			kind === 'restart'
				? 'All apps and machines stop, then come back once this server has restarted. This takes a few minutes.'
				: 'All apps and machines stop. You’ll need to turn the server back on yourself (for a VM, from its host).',
		confirm: kind === 'restart' ? 'Restart' : 'Shut down',
		danger: true,
		icon: kind === 'restart' ? 'restart' : 'power',
	})
	if (!ok) return
	const done = () => toast(kind === 'restart' ? 'Your server is restarting' : 'Your server is shutting down')
	try {
		await mutate(`system.${kind}`)
		return done()
	} catch (e) {
		const message = (e as Error).message ?? ''
		if (!OFF.test(message)) return toast(message, true)
		const anyway = await confirm({
			title: 'It won’t come back by itself',
			body: `${message.replace(OFF, '')} Until then, someone has to sign in at the server after it starts.`,
			confirm: kind === 'restart' ? 'Restart anyway' : 'Shut down anyway',
			danger: true,
			icon: 'alert',
		})
		if (!anyway) return
		try {
			await mutate(`system.${kind}`, {evenIfNoBootStart: true})
			done()
		} catch (err) {
			toast((err as Error).message, true)
		}
	}
}
