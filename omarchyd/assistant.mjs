import {createKeyStore} from './assistant/keys.mjs'
import {RpcError} from './rpc.mjs'

export function createAssistant({dataDir, accounts, now}) {
	const keys = createKeyStore({dataDir, now})
	const actor = (auth) => {
		const u = accounts.getUser(auth.userId)
		if (!u) throw new RpcError('UNAUTHORIZED', 'Invalid token')
		return {userId: u.userId, role: u.role}
	}
	return {
		keys,
		procedures: {
			'assistant.keys': {kind: 'query', run: (_i, {auth}) => keys.listPublic(auth.userId)},
			'assistant.addKey': {kind: 'mutation', run: (input, {auth}) => keys.add(auth.userId, input)},
			'assistant.updateKey': {kind: 'mutation', run: (input, {auth}) => keys.update(actor(auth), input)},
			'assistant.removeKey': {kind: 'mutation', run: (input, {auth}) => keys.remove(actor(auth), String(input?.id ?? ''))},
		},
	}
}
