import {randomBytes} from 'node:crypto'

import {createConversations} from './assistant/conversations.mjs'
import {createKeyStore} from './assistant/keys.mjs'
import {createLoop, publicAction} from './assistant/loop.mjs'
import {writeTool} from './assistant/tools.mjs'
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

function stripSecrets(value) {
	if (Array.isArray(value)) return value.map(stripSecrets)
	if (!value || typeof value !== 'object') return value
	const out = {}
	for (const [k, v] of Object.entries(value)) {
		if (k === 'password' || k === 'apiKey' || k === 'credentials' || k === 'defaultPassword') continue
		out[k] = stripSecrets(v)
	}
	return out
}

function hide(text, secret) {
	const s = String(text ?? '')
	if (!secret) return s
	return s.split(secret).join('')
}

function toolText(result, secret) {
	const clean = result && typeof result === 'object' ? stripSecrets(result) : result
	const text = typeof clean === 'string' ? clean : JSON.stringify(clean ?? null)
	return hide(text, secret)
}

function ownerMessage(toolName) {
	if (toolName === 'system_restart') return 'Only the server’s owner can restart the server'
	if (toolName === 'system_shutdown') return 'Only the server’s owner can shut down the server'
	if (toolName === 'omarchy_installPlugin') return 'Only the server’s owner can install Omarchy plugins'
	if (toolName === 'omarchy_removePlugin') return 'Only the server’s owner can remove Omarchy plugins'
	if (String(toolName ?? '').startsWith('swarm_')) return 'Only the server’s owner can manage the local swarm'
	return 'Only the server’s owner can change the desktop’s theme'
}

export function createAssistant({dataDir, accounts, now, runProcedure, fetchImpl}) {
	const keys = createKeyStore({dataDir, now})
	const conversations = createConversations({dataDir, now})
	const stamp = () => (now ? now() : Date.now())
	const actor = (auth) => {
		const u = accounts.getUser(auth?.userId)
		if (!u) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return {userId: u.userId, role: u.role}
	}
	const userIdOf = (auth) => {
		if (!auth?.userId) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return auth.userId
	}
	const {runTurn, runTurnContinue} = createLoop({keys, conversations, runProcedure, fetchImpl, now})
	const inflight = new Set()
	const claim = (id) => {
		if (inflight.has(id)) throw new RpcError('CONFLICT', 'That step was already handled')
		inflight.add(id)
	}
	const actionId = (input) => {
		const id = String(input?.actionId ?? '').trim()
		if (!id) throw new RpcError('BAD_REQUEST', 'Missing action')
		return id
	}
	const appendOutcome = (who, action, content) => {
		if (!action.toolCallId) return null
		return conversations.append(who.userId, action.conversationId, {
			role: 'tool',
			toolCallId: action.toolCallId,
			name: action.toolName,
			content: String(content ?? ''),
			at: stamp(),
		})
	}
	async function approve(input, {auth}) {
		const who = actor(auth)
		const id = actionId(input)
		claim(id)
		try {
			const {action} = await conversations.getAction(who.userId, id)
			if (action.status !== 'pending') throw new RpcError('CONFLICT', 'That step was already handled')
			const spec = writeTool(action.toolName)
			if ((action.ownerOnly || spec?.ownerOnly) && who.role !== 'owner') {
				const error = ownerMessage(action.toolName)
				await conversations.saveAction(who.userId, {...action, status: 'error', error, resolvedAt: stamp()})
				throw new RpcError('FORBIDDEN', error)
			}
			const running = {...action, status: 'running'}
			await conversations.saveAction(who.userId, running)
			const path = action.rpc?.path || spec?.rpc
			// Generated here, passed only into the RPC. The card and the model never see it.
			const secret = action.toolName === 'machines_create' || path === 'machines.create' ? randomBytes(12).toString('base64url') : ''
			const rpcInput = {...(action.rpc?.input && typeof action.rpc.input === 'object' && !Array.isArray(action.rpc.input) ? action.rpc.input : {})}
			delete rpcInput.password
			if (secret) rpcInput.password = secret
			let result
			try {
				if (!runProcedure || !path) throw new RpcError('PRECONDITION_FAILED', 'That step is not available')
				result = await runProcedure(path, rpcInput, who)
			} catch (e) {
				const error = hide(e?.message || 'That step failed', secret)
				await conversations.saveAction(who.userId, {...running, status: 'error', error, resolvedAt: stamp()})
				await appendOutcome(who, action, error)
				if (e instanceof RpcError) throw e
				throw new RpcError('BAD_GATEWAY', error)
			}
			const done = {...running, status: 'done', resolvedAt: stamp()}
			delete done.error
			await conversations.saveAction(who.userId, done)
			await appendOutcome(who, action, toolText(result, secret))
			return publicAction(done)
		} finally {
			inflight.delete(id)
		}
	}
	async function reject(input, {auth}) {
		const who = actor(auth)
		const id = actionId(input)
		claim(id)
		try {
			const {action} = await conversations.getAction(who.userId, id)
			if (action.status !== 'pending') throw new RpcError('CONFLICT', 'That step was already handled')
			const rejected = {...action, status: 'rejected', resolvedAt: stamp()}
			await conversations.saveAction(who.userId, rejected)
			await appendOutcome(who, action, 'user rejected this step')
			return publicAction(rejected)
		} finally {
			inflight.delete(id)
		}
	}
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
			const turn = body.continue === true ? runTurnContinue : runTurn
			await turn({
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
		runTurnContinue,
		handleStream,
		procedures: {
			'assistant.keys': {kind: 'query', run: (_i, {auth}) => keys.listPublic(auth.userId)},
			'assistant.addKey': {kind: 'mutation', run: (input, {auth}) => keys.add(auth.userId, input)},
			'assistant.updateKey': {kind: 'mutation', run: (input, {auth}) => keys.update(actor(auth), input)},
			'assistant.removeKey': {kind: 'mutation', run: (input, {auth}) => keys.remove(actor(auth), String(input?.id ?? ''))},
			'assistant.conversations': {kind: 'query', run: (_i, {auth}) => conversations.list(userIdOf(auth))},
			'assistant.getConversation': {kind: 'query', run: (input, {auth}) => conversations.get(userIdOf(auth), String(input?.id ?? ''))},
			'assistant.deleteConversation': {kind: 'mutation', run: (input, {auth}) => conversations.remove(userIdOf(auth), String(input?.id ?? ''))},
			'assistant.approve': {kind: 'mutation', run: (input, ctx) => approve(input, ctx)},
			'assistant.reject': {kind: 'mutation', run: (input, ctx) => reject(input, ctx)},
		},
	}
}
