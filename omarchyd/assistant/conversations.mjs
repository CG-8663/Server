import {mkdir, readFile, readdir, rm} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {writeAtomic} from '../atomic.mjs'
import {RpcError} from '../rpc.mjs'

const clipTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Chat'
const ID = () => 'c_' + randomBytes(6).toString('hex')
const AID = () => 'a_' + randomBytes(6).toString('hex')

export function createConversations({dataDir, now = () => Date.now()}) {
	const dir = join(dataDir, 'assistant', 'conversations')
	const loaded = mkdir(dir, {recursive: true, mode: 0o700})
	const path = (id) => join(dir, `${id}.json`)
	const read = async (id) => JSON.parse(await readFile(path(id), 'utf8'))
	const write = (row) => writeAtomic(path(row.id), JSON.stringify(row, null, '\t'), {mode: 0o600})
	const owned = async (userId, id) => {
		await loaded
		let row
		try {
			row = await read(id)
		} catch {
			throw new RpcError('NOT_FOUND', 'That chat isn’t here')
		}
		if (row.userId !== userId) throw new RpcError('NOT_FOUND', 'That chat isn’t here')
		return row
	}

	return {
		async list(userId) {
			await loaded
			const ids = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))
			const rows = []
			for (const n of ids) {
				const row = await read(n.slice(0, -5)).catch(() => null)
				if (row?.userId === userId) rows.push({id: row.id, title: row.title, updatedAt: row.updatedAt})
			}
			return rows.sort((a, b) => b.updatedAt - a.updatedAt)
		},
		async get(userId, id) {
			return owned(userId, id)
		},
		async create(userId, {keyId, title} = {}) {
			await loaded
			const t = now()
			const row = {id: ID(), userId, keyId: keyId ?? null, title: clipTitle(title), createdAt: t, updatedAt: t, messages: [], actions: []}
			await write(row)
			return row
		},
		async append(userId, id, message) {
			const row = await owned(userId, id)
			row.messages.push(message)
			row.updatedAt = now()
			await write(row)
			return row
		},
		async setKey(userId, id, keyId) {
			const row = await owned(userId, id)
			row.keyId = keyId
			row.updatedAt = now()
			await write(row)
			return row
		},
		async putAction(userId, id, action) {
			const row = await owned(userId, id)
			const a = {id: action.id ?? AID(), conversationId: id, userId, status: 'pending', ...action, createdAt: now()}
			row.actions.push(a)
			row.messages.push({role: 'action', actionId: a.id, at: a.createdAt})
			row.updatedAt = now()
			await write(row)
			return a
		},
		async getAction(userId, actionId) {
			await loaded
			for (const n of await readdir(dir).catch(() => [])) {
				if (!n.endsWith('.json')) continue
				const row = await read(n.slice(0, -5)).catch(() => null)
				if (row?.userId !== userId) continue
				const a = row.actions?.find((x) => x.id === actionId)
				if (a) return {row, action: a}
			}
			throw new RpcError('NOT_FOUND', 'That step isn’t here')
		},
		async saveAction(userId, action) {
			const {row} = await this.getAction(userId, action.id)
			row.actions = row.actions.map((x) => (x.id === action.id ? action : x))
			row.updatedAt = now()
			await write(row)
			return action
		},
		async remove(userId, id) {
			await owned(userId, id)
			await rm(path(id), {force: true})
			return true
		},
	}
}
