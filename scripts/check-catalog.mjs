// Checks that every image and checksum link in the machine catalog still answers, without
// downloading the images (HEAD, or a 1-byte ranged GET for servers that refuse HEAD).
// Exit code 1 with a readable list when any link is broken. Used by .github/workflows/catalog.yml.
import {readFile} from 'node:fs/promises'

const catalog = JSON.parse(await readFile(new URL('../omarchyd/machine-catalog.json', import.meta.url), 'utf8'))
const links = []
for (const img of catalog.images ?? []) {
	if (img.url) links.push({id: img.id, what: 'image', url: img.url})
	if (img.checksums?.url) links.push({id: img.id, what: 'checksums', url: img.checksums.url})
}

async function answers(url) {
	const opts = {redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: {'user-agent': 'omarchy-server-catalog-check'}}
	try {
		let r = await fetch(url, {...opts, method: 'HEAD'})
		if (r.status === 405 || r.status === 403 || r.status === 501) {
			r = await fetch(url, {...opts, headers: {...opts.headers, range: 'bytes=0-0'}})
			await r.body?.cancel()
		}
		return {ok: r.ok || r.status === 206, status: r.status}
	} catch (e) {
		return {ok: false, status: e.cause?.code ?? e.name}
	}
}

const results = await Promise.all(links.map(async (l) => ({...l, ...(await answers(l.url))})))
const broken = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.status}\t${r.id} (${r.what})\t${r.url}`)
if (broken.length) {
	console.error(`\n${broken.length} of ${results.length} catalog links don’t answer:`)
	for (const r of broken) console.error(`- ${r.id} ${r.what}: ${r.url} (${r.status})`)
	process.exit(1)
}
console.log(`\nAll ${results.length} catalog links answer.`)
