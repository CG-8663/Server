// Writing a state file safely: whole-file replace (write a temporary file, then rename it over the
// old one), one write at a time per file. Two saves at the same moment used to share one temporary
// name, so the second rename failed (ENOENT) and that change was lost.
import {randomBytes} from 'node:crypto'
import {rename, rm, writeFile} from 'node:fs/promises'

const queues = new Map()

function enqueue(file, run) {
	const prev = queues.get(file) ?? Promise.resolve()
	const next = prev.then(run)
	const settled = next.catch(() => {})
	queues.set(file, settled)
	settled.then(() => queues.get(file) === settled && queues.delete(file))
	return next
}

// `content` may be a function, so what's written is the state as it is when the write runs.
// `null` / `undefined` skips the write (a store closed by factory reset must not recreate the file).
export function writeAtomic(file, content, {mode = 0o600} = {}) {
	return enqueue(file, async () => {
		const data = typeof content === 'function' ? content() : content
		if (data == null) return
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
		try {
			await writeFile(tmp, data, {mode})
			await rename(tmp, file)
		} catch (error) {
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	})
}

// Delete on the same per-file queue as writeAtomic, so it runs after a write already queued.
export function removeAtomic(file) {
	return enqueue(file, () => rm(file, {force: true}))
}
