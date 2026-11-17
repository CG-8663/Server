import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {useQuery} from '@tanstack/react-query'

import {query, type AssistantKey} from '../api'
import {streamAssistant, type AssistantChatMessage, type AssistantConversation, type AssistantConversationSummary} from '../assistant'
import {useUser} from '../data'
import {Icon} from '../icons'
import {haptic, usePortalRoot} from '../ui'

type Bubble = {id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean}

const toBubbles = (messages: AssistantChatMessage[]): Bubble[] => {
	const out: Bubble[] = []
	messages.forEach((m, i) => {
		if (m.role === 'user') out.push({id: `u-${m.at}-${i}`, role: 'user', content: m.content})
		else if (m.role === 'assistant' && m.content) out.push({id: `a-${m.at}-${i}`, role: 'assistant', content: m.content})
	})
	return out
}

const prettyTool = (name: string) => name.replaceAll('_', ' ')

export function Assistant({onClose, onSettings}: {onClose?: () => void; onSettings: () => void}) {
	const portalRoot = usePortalRoot()
	const screenRef = useRef<HTMLDivElement>(null)
	const threadRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const stick = useRef(true)
	const acRef = useRef<AbortController | null>(null)
	const alive = useRef(true)
	const conversationIdRef = useRef<string | undefined>(undefined)
	const seq = useRef(0)
	const focused = useRef(false)
	const user = useUser()
	const member = user.data?.role === 'member'
	const keys = useQuery({queryKey: ['assistant.keys', undefined], queryFn: () => query<AssistantKey[]>('assistant.keys'), retry: false, staleTime: 15_000})
	const hasKeys = (keys.data?.length ?? 0) > 0
	const convs = useQuery({
		queryKey: ['assistant.conversations', undefined],
		queryFn: () => query<AssistantConversationSummary[]>('assistant.conversations'),
		enabled: hasKeys,
		retry: false,
		staleTime: 0,
	})
	const lastId = convs.data?.[0]?.id
	const thread = useQuery({
		queryKey: ['assistant.getConversation', lastId ? {id: lastId} : undefined],
		queryFn: () => query<AssistantConversation>('assistant.getConversation', {id: lastId}),
		enabled: hasKeys && !!lastId,
		retry: false,
		staleTime: 0,
	})
	const [bubbles, setBubbles] = useState<Bubble[] | null>(null)
	const [draft, setDraft] = useState('')
	const [activity, setActivity] = useState<string | null>(null)
	const [turnError, setTurnError] = useState<string | null>(null)

	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
			acRef.current?.abort()
		}
	}, [])

	useEffect(() => {
		if (!onClose) return
		const vv = window.visualViewport
		const el = screenRef.current
		if (!vv || !el) return
		const apply = () => {
			el.style.top = `${vv.offsetTop}px`
			el.style.height = `${vv.height}px`
			el.classList.toggle('kbd-open', window.innerHeight - vv.height > 120)
		}
		apply()
		vv.addEventListener('resize', apply)
		vv.addEventListener('scroll', apply)
		return () => {
			vv.removeEventListener('resize', apply)
			vv.removeEventListener('scroll', apply)
		}
	}, [onClose])

	useEffect(() => {
		if (!onClose) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	useEffect(() => {
		if (bubbles !== null || !keys.isSuccess || !hasKeys) return
		if (convs.isError) {
			setBubbles([])
			setTurnError((convs.error as Error).message)
			return
		}
		if (!convs.isSuccess) return
		if (!convs.data.length) {
			setBubbles([])
			return
		}
		if (thread.isError) {
			setBubbles([])
			setTurnError((thread.error as Error).message)
			return
		}
		if (!thread.isSuccess) return
		conversationIdRef.current = thread.data.id
		setBubbles(toBubbles(thread.data.messages ?? []))
	}, [bubbles, keys.isSuccess, hasKeys, convs.isError, convs.isSuccess, convs.data, convs.error, thread.isError, thread.isSuccess, thread.data, thread.error])

	useEffect(() => {
		const el = threadRef.current
		if (el && stick.current) el.scrollTop = el.scrollHeight
	}, [bubbles, activity, turnError])

	useEffect(() => {
		if (onClose || !bubbles || focused.current) return
		focused.current = true
		inputRef.current?.focus()
	}, [bubbles, onClose])

	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`
	}

	const send = async () => {
		const text = draft.trim()
		if (!text || bubbles === null) return
		const previous = acRef.current
		previous?.abort()
		let conversationId = conversationIdRef.current
		// The id arrives on `done`. A second send before that stays on the thread just created.
		if (previous && !conversationId) {
			const list = await query<AssistantConversationSummary[]>('assistant.conversations').catch(() => null)
			const found = list?.[0]?.id
			if (found) {
				conversationId = found
				conversationIdRef.current = found
			}
		}
		if (!alive.current) return
		const ac = new AbortController()
		acRef.current = ac
		const id = ++seq.current
		const aid = `live-${id}`
		setDraft('')
		if (inputRef.current) inputRef.current.style.height = 'auto'
		setTurnError(null)
		setActivity(null)
		stick.current = true
		setBubbles((bs) => [...(bs ?? []), {id: `user-${id}`, role: 'user', content: text}, {id: aid, role: 'assistant', content: '', streaming: true}])
		let aborted = false
		let failed = false
		try {
			await streamAssistant({...(conversationId ? {conversationId} : {}), message: text}, (e) => {
				if (!alive.current || ac.signal.aborted) return
				if (e.event === 'text') {
					setActivity(null)
					setBubbles((bs) => bs?.map((b) => (b.id === aid ? {...b, content: b.content + e.data.text} : b)) ?? bs)
				} else if (e.event === 'tool') {
					const name = prettyTool(e.data.name)
					setActivity(e.data.state === 'error' ? `Couldn’t check ${name}` : `Checked ${name}`)
				} else if (e.event === 'done') {
					conversationIdRef.current = e.data.conversationId
				} else if (e.event === 'error') {
					failed = true
					setTurnError(e.data.message)
				}
			}, ac.signal)
		} catch (err) {
			aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError')
			if (!aborted) {
				failed = true
				setTurnError(err instanceof Error ? err.message : 'The assistant did not answer')
			}
		} finally {
			if (!alive.current) return
			setBubbles((bs) => {
				if (!bs) return bs
				return bs.flatMap((b) => {
					if (b.id !== aid) return [b]
					if (!b.content && (aborted || failed)) return []
					return [{...b, streaming: false}]
				})
			})
			if (acRef.current === ac) setActivity(null)
		}
	}

	const loading = keys.isLoading || (hasKeys && bubbles === null && !keys.isError)
	const column = (
		<div className="assistant glass" role="dialog" aria-modal={onClose ? true : undefined} aria-label="Assistant">
			{onClose && (
				<header className="assistant-head">
					<button type="button" className="round-btn" aria-label="Back" onClick={() => (haptic(6), onClose())}>
						<Icon name="back" size={20} />
					</button>
					<b>Assistant</b>
				</header>
			)}
			{keys.isError && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{(keys.error as Error).message}
				</div>
			)}
			{loading && (
				<div className="assistant-thread">
					<span className="spinner" aria-label="Loading" />
				</div>
			)}
			{keys.isSuccess && !hasKeys && (
				<div className="assistant-thread">
					<div className="empty">
						<span className="big">
							<Icon name="sparkle" size={30} />
						</span>
						<b>Add a provider and API key to talk to the assistant.</b>
						{member && <span>Ask the owner to share a key, or add your own.</span>}
						<button type="button" className="btn primary small" onClick={() => (haptic(6), onSettings())}>
							Settings → Assistant
						</button>
					</div>
				</div>
			)}
			{hasKeys && bubbles && (
				<>
					<div
						className="assistant-thread"
						ref={threadRef}
						onScroll={(e) => {
							const el = e.currentTarget
							stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
						}}
					>
						{bubbles.length === 0 && !turnError && (
							<div className="empty">
								<span className="big">
									<Icon name="sparkle" size={30} />
								</span>
								<b>Ask about this server</b>
								<span>Usage, apps, machines, and the Local swarm.</span>
							</div>
						)}
						{bubbles.map((b) => (
							<div key={b.id} className={`bubble ${b.role}${b.streaming ? ' live' : ''}`}>
								{b.content}
								{b.streaming && <span className="cursor" aria-hidden="true" />}
							</div>
						))}
						{activity && <p className="assistant-activity">{activity}</p>}
						{turnError && (
							<div className="error" role="alert">
								<Icon name="alert" size={18} />
								{turnError}
							</div>
						)}
					</div>
					<form
						className="composer"
						onSubmit={(e) => {
							e.preventDefault()
							void send()
						}}
					>
						<textarea
							ref={inputRef}
							rows={1}
							value={draft}
							placeholder="Message"
							aria-label="Message"
							enterKeyHint="send"
							onChange={(e) => {
								setDraft(e.target.value)
								fit(e.target)
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault()
									void send()
								}
							}}
						/>
						<button type="submit" className="btn primary small" disabled={!draft.trim()}>
							Send
						</button>
					</form>
				</>
			)}
		</div>
	)
	if (!onClose) return column
	return createPortal(
		<div ref={screenRef} className="assistant-screen">
			{column}
		</div>,
		portalRoot,
	)
}
