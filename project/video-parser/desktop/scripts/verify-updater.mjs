// Independent, dependency-free QA check of Tauri's base64-wrapped Minisign file.
// Format: https://jedisct1.github.io/minisign/#signature-format
import { readFileSync } from 'node:fs'
import { createHash, createPublicKey, verify } from 'node:crypto'

const [installer, signatureFile] = process.argv.slice(2)
if (!installer || !signatureFile) throw new Error('Usage: node scripts/verify-updater.mjs installer.exe installer.exe.sig')
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const publicLines = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/)
const signatureLines = Buffer.from(readFileSync(signatureFile, 'utf8').trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
const key = Buffer.from(publicLines[1] || '', 'base64')
const signature = Buffer.from(signatureLines[1] || '', 'base64')
if (key.length !== 42 || signature.length !== 74 || key.subarray(0, 2).toString() !== 'Ed') throw new Error('Invalid Minisign envelope')
if (!key.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error('Updater public key does not match the signing key')
if (signature.subarray(0, 2).toString() !== 'ED') throw new Error('Require hashed Minisign signature')
if (!signatureLines[2]?.startsWith('trusted comment: ')) throw new Error('Missing trusted comment')
const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
const data = readFileSync(installer)
const digest = createHash('blake2b512').update(data).digest()
if (!verify(null, digest, publicKey, signature.subarray(10))) throw new Error('Installer signature INVALID')
const comment = Buffer.from(signatureLines[2].slice('trusted comment: '.length))
if (!verify(null, Buffer.concat([signature.subarray(10), comment]), publicKey, Buffer.from(signatureLines[3] || '', 'base64'))) throw new Error('Trusted comment signature INVALID')
// Negative control: the same signature must reject changed content.
digest[0] ^= 1
if (verify(null, digest, publicKey, signature.subarray(10))) throw new Error('Negative signature control failed')
console.log(JSON.stringify({ verified: true, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), alteredContentRejected: true }))
