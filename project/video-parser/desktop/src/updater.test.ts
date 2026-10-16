import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { checkApplicationUpdate, installApplicationUpdate } from './updater'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
it('checks and retains the configured local proxy for updater download', async () => {
  vi.mocked(invoke).mockResolvedValue('http://127.0.0.1:10808')
  vi.mocked(check).mockResolvedValue(null)
  await expect(checkApplicationUpdate()).resolves.toBeNull()
  expect(invoke).toHaveBeenCalledWith('update_proxy')
  expect(check).toHaveBeenCalledWith({ timeout: 30_000, proxy: 'http://127.0.0.1:10808' })
})
it('does not invent a proxy when the configured route is direct', async () => {
  vi.mocked(invoke).mockResolvedValue(null)
  await checkApplicationUpdate()
  expect(check).toHaveBeenCalledWith({ timeout: 30_000 })
})
it('does not silently change route when proxy configuration fails', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('proxy configuration failed'))
  await expect(checkApplicationUpdate()).rejects.toThrow('proxy configuration failed')
  expect(check).not.toHaveBeenCalled()
})
it('gives the installer a separate long timeout without losing progress or restart', async () => {
  const onEvent = vi.fn()
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
  await installApplicationUpdate({ downloadAndInstall } as unknown as Update, onEvent)
  expect(downloadAndInstall).toHaveBeenCalledWith(onEvent, { timeout: 900_000, restartAfterInstall: true })
})
