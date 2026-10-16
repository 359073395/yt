import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadVerified } from './runtime-download.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yinglian-runtime-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'engine.exe') }
}
test('same-size stale binary is replaced, then hash-matching cache is reused', async t => {
  const { path } = await fixture(t)
  await writeFile(path, 'old engine')
  let calls = 0
  const fetch = async () => { calls++; return new Response('new engine') }
  assert.equal(await downloadVerified('https://example.com/engine', path, digest('new engine'), fetch), 'downloaded')
  assert.equal(await readFile(path, 'utf8'), 'new engine')
  assert.equal(await downloadVerified('https://example.com/engine', path, digest('new engine'), fetch), 'cached')
  assert.equal(calls, 1)
})
test('tampered download preserves existing engine and removes only partial', async t => {
  const { path, root } = await fixture(t)
  await writeFile(path, 'working')
  await assert.rejects(downloadVerified('https://example.com/engine', path, digest('expected'), async () => new Response('corrupt')), /SHA-256 mismatch/)
  assert.equal(await readFile(path, 'utf8'), 'working')
  assert.deepEqual(await readdir(root), ['engine.exe'])
})
test('failed request does not replace old engine', async t => {
  const { path } = await fixture(t)
  await writeFile(path, 'working')
  await assert.rejects(downloadVerified('https://example.com/engine', path, digest('expected'), async () => new Response('', { status: 503 })), /HTTP 503/)
  assert.equal(await readFile(path, 'utf8'), 'working')
})
test('missing hash is rejected before accessing network', async t => {
  const { path } = await fixture(t)
  await assert.rejects(downloadVerified('https://example.com/engine', path, '', () => { throw new Error('network called') }), /pinned SHA-256/)
})
