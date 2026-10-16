import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// Never treat file size or an old filename as proof of the requested release.
// Download/verify beside the destination; a failed transfer leaves the old file intact.
export async function downloadVerified(url, destination, expectedHash, fetchImpl = fetch) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Missing pinned SHA-256')
  if (existsSync(destination) && await sha256(destination) === expectedHash) return 'cached'
  const partial = `${destination}.${randomUUID()}.part`
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow', headers: { 'User-Agent': 'yinglian-desktop-build' },
      signal: AbortSignal.timeout(10 * 60_000),
    })
    if (!response.ok || !response.body) throw new Error(`Runtime download HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }))
    if (await sha256(partial) !== expectedHash) throw new Error('Runtime SHA-256 mismatch; old file preserved')
    await rename(partial, destination)
    return 'downloaded'
  } finally {
    await rm(partial, { force: true })
  }
}
