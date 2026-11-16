// Every server call the web page makes must be on the web server's allowlist (server/app.mjs
// ALLOWED), with the same kind, or the page gets an error instead of an answer. (0.9.19 shipped a
// button whose call was missing.)
import assert from 'node:assert/strict'
import {readFile, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {test} from 'node:test'

import {ALLOWED} from '../server/app.mjs'

async function sources(dir) {
	const out = []
	for (const e of await readdir(dir, {withFileTypes: true})) {
		const p = join(dir, e.name)
		if (e.isDirectory()) out.push(...(await sources(p)))
		else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
	}
	return out
}

test('every procedure the web page calls is allowed, as the right kind', async () => {
	const used = new Map() // path -> Set(kind)
	const add = (path, kind) => used.set(path, (used.get(path) ?? new Set()).add(kind))
	for (const file of await sources(new URL('../web/src', import.meta.url).pathname)) {
		const text = await readFile(file, 'utf8')
		for (const m of text.matchAll(/\bquery(?:<[^>()]*>)?\(\s*['"]([a-zA-Z]+\.[a-zA-Z.]+)['"]/g)) add(m[1], 'query')
		for (const m of text.matchAll(/\bmutate(?:<[^>()]*>)?\(\s*['"]([a-zA-Z]+\.[a-zA-Z.]+)['"]/g)) add(m[1], 'mutation')
		// useAction / run.mutate({path: 'x.y', …}) calls are mutations.
		for (const m of text.matchAll(/\bpath:\s*['"]([a-zA-Z]+\.[a-zA-Z.]+)['"]/g)) add(m[1], 'mutation')
		for (const m of text.matchAll(/\bact\(\s*['"]([a-zA-Z]+\.[a-zA-Z.]+)['"]/g)) add(m[1], 'mutation')
	}
	assert.ok(used.size > 50, `found ${used.size} calls`)
	const problems = []
	for (const [path, kinds] of used) {
		for (const kind of kinds) if (ALLOWED[path] !== kind) problems.push(`${path} (${kind}) → allowed as ${ALLOWED[path] ?? 'nothing'}`)
	}
	assert.deepEqual(problems, [])
})
