import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const config = json('../src-tauri/tauri.conf.json')
it('keeps the existing user data identity, executable and signing trust', () => {
  expect(config.identifier).toBe('org.yinglian.desktop.preview')
  expect(config.mainBinaryName).toBe('paoliang-preview')
  expect(config.plugins.updater.pubkey).toBe('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI1NjJDOTAxMTg3NTJFRDYKUldUV0xuVVlBY2xpdFR4Y0dLTDdkTkpSUWVkOUkraEUzZEpvVWREdzAzSFpoYTZ0L1dId1pUY1oK')
  expect(config.plugins.updater.endpoints).toEqual(['https://github.com/359073395/yt/releases/latest/download/paoliang-latest.json'])
  expect(config.bundle.createUpdaterArtifacts).toBe(true)
  expect(config.bundle.windows.nsis.installMode).toBe('currentUser')
})
it('keeps the version synchronized in frontend, native code and installer', () => {
  const version = json('../package.json').version
  expect(config.version).toBe(version)
  expect(config.app.windows[0].title).toContain(version)
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  expect(cargo.match(/^version = "([^"]+)"/m)?.[1]).toBe(version)
})
