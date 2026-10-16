import { expect, it } from 'vitest'
// @ts-expect-error build script intentionally has no production TypeScript dependency
import { publicChannel } from '../scripts/update-channel.mjs'
const manifest = { version: '1.10.1', platforms: { 'windows-x86_64': { signature: 'signed', url: 'https://api.github.com/assets/private' } } }
it('uses the public immutable asset URL without altering the signature', () => {
  const result = publicChannel(manifest, '1.10.1', '359073395/yt')
  expect(result.platforms['windows-x86_64']).toEqual({ signature: 'signed', url: 'https://github.com/359073395/yt/releases/download/video-parser-desktop-v1.10.1/Paoliang-YingLian_1.10.1_x64-setup.exe' })
  expect(manifest.platforms['windows-x86_64'].url).toContain('api.github.com')
})
it('rejects incorrect versions, missing signatures and incompatible platforms', () => {
  expect(() => publicChannel(manifest, '1.10.2', '359073395/yt')).toThrow()
  expect(() => publicChannel({ ...manifest, platforms: {} }, '1.10.1', '359073395/yt')).toThrow()
  expect(() => publicChannel({ ...manifest, platforms: { 'windows-x86_64': { signature: '' } } }, '1.10.1', '359073395/yt')).toThrow()
})
