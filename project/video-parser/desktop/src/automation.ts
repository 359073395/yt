import { platformName } from './core'
import type { PendingItem } from './library'

export interface Subscription {
  id: string; name: string; url: string; category: string; interval_minutes: number
  limit: number; include_existing: boolean; auto_download: boolean; enabled: boolean
  initialized: boolean; last_checked: number; next_check: number; detail: string; checking: boolean
}
export interface Delivery {
  id: string; subscription_id: string; url: string; title: string; category: string
  note: string; auto_download: boolean; created: number
}
export interface Recording {
  id: string; url: string; name: string; category: string; output_dir: string
  status: string; detail: string; created: number; elapsed: number; bytes: number
}
export interface AutomationSnapshot {
  subscriptions: Subscription[]; deliveries: Delivery[]; recordings: Recording[]; error: string
}
export const emptyAutomation: AutomationSnapshot = { subscriptions: [], deliveries: [], recordings: [], error: '' }
export const recordingActive = (status: string) => ['resolving', 'recording', 'stopping'].includes(status)
export function mergeDeliveries(items: PendingItem[], deliveries: Delivery[], quality: string, dismissed: string[] = []): PendingItem[] {
  const known = new Set([...dismissed, ...items.map(item => item.automationId).filter(Boolean)])
  const additions = deliveries.filter(delivery => {
    if (known.has(delivery.id)) return false
    known.add(delivery.id); return true
  }).map(delivery => ({
    id: `subscription-${delivery.id}`, automationId: delivery.id, autoDownload: delivery.auto_download,
    url: delivery.url, title: delivery.title, platform: platformName(delivery.url), uploader: '',
    category: delivery.category, note: delivery.note, created: delivery.created * 1000,
    quality, loading: false, selected: false,
  }))
  return additions.length ? [...additions, ...items] : items
}
