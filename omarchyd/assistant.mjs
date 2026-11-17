import {createConversations} from './assistant/conversations.mjs'
import {createKeyStore} from './assistant/keys.mjs'
import {createLoop} from './assistant/loop.mjs'
import {RpcError} from './rpc.mjs'

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
	return {
		keys,
		conversations,
		runTurn,
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
