import {createConversations} from './assistant/conversations.mjs'
import {createKeyStore} from './assistant/keys.mjs'
import {createLoop} from './assistant/loop.mjs'
import {RpcError} from './rpc.mjs'

async function readJson(req, limit) {
	let size = 0
	const chunks = []
	for await (const c of req) {
		size += c.length
		if (size > limit) throw new RpcError('BAD_REQUEST', 'Request too large')
		chunks.push(c)
	}
	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw) return {}
	try {
		const body = JSON.parse(raw)
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('not an object')
		return body
	} catch (error) {
		if (error instanceof RpcError) throw error
		throw new RpcError('BAD_REQUEST', 'Invalid JSON')
	}
}

export function createAssistant({dataDir, accounts, now, runProcedure, fetchImpl}) {
	const keys = createKeyStore({dataDir, now})
	const conversations = createConversations({dataDir, now})
	const actor = (auth) => {
		const u = accounts.getUser(auth.userId)
		if (!u) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return {userId: u.userId, role: u.role}
	}
	const userIdOf = (auth) => {
		if (!auth?.userId) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return auth.userId
	}
	const {runTurn} = createLoop({keys, conversations, runProcedure, fetchImpl, now})
	// IncomingMessage 'close' fires when the body is consumed, so that would cancel every turn.
	// The socket closes only when the client hangs up.
	async function handleStream(req, res, auth) {
		const who = actor(auth)
		const ac = new AbortController()
		const onSocketClose = () => ac.abort()
		req.socket?.on('close', onSocketClose)
		res.on('close', () => {
			if (!res.writableEnded) ac.abort()
		})
		try {
			const body = await readJson(req, 100_000)
			if (ac.signal.aborted) return
			req.socket?.setNoDelay(true)
			res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store'})
			const emit = ({event, data}) => {
				if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
			}
			await runTurn({
				userId: who.userId,
				role: who.role,
				message: body.message,
				conversationId: body.conversationId ? String(body.conversationId) : undefined,
				keyId: body.keyId ? String(body.keyId) : undefined,
				signal: ac.signal,
				emit,
			})
		} finally {
			req.socket?.off('close', onSocketClose)
			if (res.headersSent && !res.writableEnded && !res.destroyed) res.end()
		}
	}
	return {
		keys,
		conversations,
		runTurn,
		handleStream,
		procedures: {
			'assistant.keys': {kind: 'query', run: (_i, {auth}) => keys.listPublic(auth.userId)},
			'assistant.addKey': {kind: 'mutation', run: (input, {auth}) => keys.add(auth.userId, input)},
			'assistant.updateKey': {kind: 'mutation', run: (input, {auth}) => keys.update(actor(auth), input)},
			'assistant.removeKey': {kind: 'mutation', run: (input, {auth}) => keys.remove(actor(auth), String(input?.id ?? ''))},
			'assistant.conversations': {kind: 'query', run: (_i, {auth}) => conversations.list(userIdOf(auth))},
			'assistant.getConversation': {kind: 'query', run: (input, {auth}) => conversations.get(userIdOf(auth), String(input?.id ?? ''))},
			'assistant.deleteConversation': {kind: 'mutation', run: (input, {auth}) => conversations.remove(userIdOf(auth), String(input?.id ?? ''))},
		},
	}
}
