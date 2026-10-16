import { invoke } from '@tauri-apps/api/core'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

export async function checkApplicationUpdate() {
  const proxy = await invoke<string | null>('update_proxy')
  // The Tauri update resource retains this proxy for downloadAndInstall too.
  return check({ timeout: 30_000, ...(proxy ? { proxy } : {}) })
}

export function installApplicationUpdate(update: Update, onEvent: (event: DownloadEvent) => void) {
  // Checking small metadata must not impose its short timeout on a full installer.
  return update.downloadAndInstall(onEvent, { timeout: 15 * 60_000, restartAfterInstall: true })
}
