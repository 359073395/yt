import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MediaCard } from './MediaCard'
import { categoryDirectory, filterRecords, normalizeCategory, restoreLibrary, visibleStages, removeLibraryRecords, activeStatuses, type LibraryRecord } from './library'
import { mergeDeliveries } from './automation'

const record: LibraryRecord = { source: 'manual', item: { id: '1', url: 'https://example.com/video', title: '印尼口播', platform: 'TikTok', uploader: 'creator', selected: false, quality: '1080', loading: false, category: '美妆/口播', note: '学习开头', created: 1 }, task: { id: 'task', queueItemId: '1', url: '', title: '印尼口播', platform: 'TikTok', status: 'completed', percent: 100, message: '完成', outputDir: 'qa' } }
describe('library workbench', () => {
  it.each(['../secret', 'C:\\data', 'a/../b', 'CON', 'a/LPT1.txt', 'a.', 'a?b'])('rejects unsafe categories %s', value => expect(() => normalizeCategory(value)).toThrow())
  it('keeps nested folder labels and the path visible', () => {
    expect(categoryDirectory('E:\\素材', '美妆/口播')).toBe('E:\\素材\\美妆\\口播')
    expect(normalizeCategory('')).toBe('待分类')
  })
  it('recovers interrupted jobs without redownloading saved videos', () => {
    const state = restoreLibrary({ version: 1, items: [record.item], tasks: [{ ...record.task, status: 'translating' }], categories: [] })
    expect(state.tasks[0].status).toBe('partial')
    expect(state.tasks[0].outputDir).toBe('qa')
    expect(state.tasks[0].message).toContain('已保存文件保留')
  })
  it('does not overwrite unsupported or corrupt journals with an empty one', () => {
    expect(() => restoreLibrary({ version: 2 })).toThrow()
    expect(() => restoreLibrary({ version: 1 })).toThrow()
    expect(() => restoreLibrary({ version: 1, items: [{ ...record.item, category: '../outside' }], tasks: [], categories: [] })).toThrow()
    expect(() => restoreLibrary({ version: 1, items: [record.item], tasks: [], categories: [123] })).toThrow()
  })
  it('filters nested categories, notes, status and task/library views', () => {
    expect(filterRecords([record], '美妆', '开头', 'completed', 'library')).toHaveLength(1)
    expect(filterRecords([record], '家居', '', 'all', 'library')).toHaveLength(0)
    expect(filterRecords([record], '*', '', 'active', 'library')).toHaveLength(0)
    expect(filterRecords([record], '*', '', 'all', 'tasks')).toHaveLength(0)
  })
  it('never leaves a completed 100% bar or duplicates the status', () => {
    expect(visibleStages(record.task).progress).toBeUndefined()
    const noop = () => undefined
    const html = renderToStaticMarkup(<MediaCard record={record} onSelect={noop} onEdit={noop} onOpen={noop} onCopy={noop} onCancel={noop} onRetry={noop} onRemove={noop} />)
    expect(html).not.toContain('<progress')
    expect(html).toContain('打开文件夹')
    expect(html).toContain('复制文案')
    expect(html.match(/所选内容已完成/g)).toHaveLength(1)
  })
  it('shows translation progress separately from an already saved video', () => {
    const stages = visibleStages({ ...record.task!, status: 'translating', percent: 40 })
    expect(stages.video).toBe('已有文件已保存')
    expect(stages.text).toBe('文案翻译 40%')
    expect(stages.progress).toBe(40)
  })
  it('removes only selected idle records and their tasks, keeping categories and output objects untouched', () => {
    const other = { ...record.item, id: 'keep' }
    const original = { version: 1 as const, items: [record.item, other], tasks: [record.task!], categories: ['美妆'] }
    const next = removeLibraryRecords(original, ['1'])
    expect(next.items).toEqual([other])
    expect(next.tasks).toEqual([])
    expect(next.categories).toEqual(['美妆'])
    expect(original.items).toHaveLength(2)
    expect(original.tasks[0].outputDir).toBe('qa')
    expect(restoreLibrary(JSON.parse(JSON.stringify(next))).items).toEqual([other])
  })
  it.each(activeStatuses)('rejects deletion during %s', status => {
    expect(() => removeLibraryRecords({ version: 1, items: [record.item], tasks: [{ ...record.task!, status }], categories: [] }, ['1'])).toThrow('正在处理中')
  })
  it('rejects removal of a preview still being parsed', () => {
    expect(() => removeLibraryRecords({ version: 1, items: [{ ...record.item, loading: true }], tasks: [], categories: [] }, ['1'])).toThrow()
  })
  it('does not resurrect deleted subscription receipts after stale polling or restart', () => {
    const next = removeLibraryRecords({ version: 1, items: [{ ...record.item, automationId: 'delivery-1' }], tasks: [record.task!], categories: [] }, ['1'])
    const restored = restoreLibrary(JSON.parse(JSON.stringify(next)))
    const delivery = { id: 'delivery-1', subscription_id: 'sub', url: record.item.url, title: record.item.title, category: '美妆', note: '', auto_download: true, created: 1 }
    expect(mergeDeliveries(restored.items, [delivery], '1080', restored.dismissedDeliveries)).toEqual([])
    expect(mergeDeliveries(restored.items, [{ ...delivery, id: 'new-video' }], '1080', restored.dismissedDeliveries)).toHaveLength(1)
  })
  it.each(['manual', 'feishu'] as const)('provides record-only deletion for %s with processing protection', source => {
    const noop = () => undefined
    const props = { onSelect: noop, onEdit: noop, onOpen: noop, onCopy: noop, onCancel: noop, onRetry: noop, onRemove: noop }
    const html = renderToStaticMarkup(<MediaCard record={{ ...record, source }} {...props} />)
    expect(html).toContain('只删除记录，保留本地文件')
    expect(html).toContain('删除记录')
    const active = renderToStaticMarkup(<MediaCard record={{ ...record, source, task: { ...record.task!, status: 'translating' } }} {...props} />)
    expect(active).toMatch(/<button disabled="" title="任务正在处理中，结束后可删除记录"/)
  })
})
