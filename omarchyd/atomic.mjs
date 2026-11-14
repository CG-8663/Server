// Writing a state file safely: whole-file replace (write a temporary file, then rename it over the
// old one), one write at a time per file. Two saves at the same moment used to share one temporary
// name, so the second rename failed (ENOENT) and that change was lost.
import {randomBytes} from 'node:crypto'
import {rename, rm, writeFile} from 'node:fs/promises'

const queues = new Map()

// `content` may be a function, so what's written is the state as it is when the write runs.
export function writeAtomic(file, content, {mode = 0o600} = {}) {
	const prev = queues.get(file) ?? Promise.resolve()
	const next = prev.then(async () => {
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
		try {
			await writeFile(tmp, typeof content === 'function' ? content() : content, {mode})
			await rename(tmp, file)
		} catch (error) {
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	})
	const settled = next.catch(() => {})
	queues.set(file, settled)
	settled.then(() => queues.get(file) === settled && queues.delete(file))
	return next
}
