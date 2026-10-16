import { invoke } from '@tauri-apps/api/core'
import { check } from '@tauri-apps/plugin-updater'

export async function checkApplicationUpdate() {
  const proxy = await invoke<string | null>('update_proxy')
  // The Tauri update resource retains this proxy for downloadAndInstall too.
  return check({ timeout: 30_000, ...(proxy ? { proxy } : {}) })
}
