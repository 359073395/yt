import { describe, it, expect } from 'vitest'
import { mergeDeliveries, recordingActive, type Delivery } from './automation'
import { restoreLibrary } from './library'
const delivery: Delivery = { id: 'receipt', subscription_id: 'source', url: 'https://www.tiktok.com/@test/video/123', title: 'video', category: '美妆', note: '订阅：测试', auto_download: true, created: 1234 }
describe('subscription delivery journal', () => {
  it('repeated polling and replay do not add duplicate videos', () => {
    const items = mergeDeliveries([], [delivery, delivery], '1080')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ automationId: 'receipt', autoDownload: true, selected: false, category: '美妆', created: 1234000 })
    expect(mergeDeliveries(items, [delivery], '720')).toBe(items)
  })
  it('receipt survives restart so a delayed native acknowledgment is idempotent', () => {
    const items = mergeDeliveries([], [delivery], '1080')
    const journal = restoreLibrary(JSON.parse(JSON.stringify({ version: 1, items, tasks: [], categories: [] })))
    expect(mergeDeliveries(journal.items, [delivery], '720')).toBe(journal.items)
  })
  it('keeps categories and opt-out separate across subscriptions', () => {
    const items = mergeDeliveries([], [delivery, { ...delivery, id: 'second', category: '家居', auto_download: false }], 'best')
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ category: '家居', autoDownload: false, quality: 'best' })
  })
  it('only live stages are stoppable; no fake complete progress bar', () => {
    expect(recordingActive('resolving')).toBe(true)
    expect(recordingActive('recording')).toBe(true)
    expect(recordingActive('stopping')).toBe(true)
    for (const status of ['completed', 'failed', 'cancelled', 'partial', 'interrupted']) expect(recordingActive(status)).toBe(false)
  })
})
