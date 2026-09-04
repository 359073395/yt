import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { finishTranslation } from './translation-job'
import type { DownloadResult } from './core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const mockedInvoke = vi.mocked(invoke)
const result: DownloadResult = { output_dir: 'qa', title: 'clip', platform: 'YouTube', transcript_available: true, source_language: 'en', segments: [{ index: 1, start: '00:00:00,000', end: '00:00:02,000', text: 'Hello' }] }
const options = { target: 'zh' as const, provider: 'api' as const, modelBaseUrl: '', ready: null }

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async command => {
    if (command === 'translate_with_ai') return ['你好']
    return undefined
  })
})

it('uses in-memory transcript → translator wrapper → bilingual file save before success', async () => {
  const outcome = await finishTranslation(result, options, vi.fn())
  expect(outcome.status).toBe('completed')
  expect(mockedInvoke.mock.calls.map(call => call[0])).toEqual(['translate_with_ai', 'save_translation'])
  expect(mockedInvoke).toHaveBeenLastCalledWith('save_translation', { request: { output_dir: 'qa', segments: result.segments, translations: ['你好'] } })
  expect(outcome.message).toContain('双语文案已保存')
  expect(outcome.message).not.toContain('双语字幕')
})

it.each(['translate_with_ai', 'save_translation'])('never reports success when %s fails', async stage => {
  mockedInvoke.mockImplementation(async command => {
    if (command === stage) throw new Error('QA failure')
    return ['你好']
  })
  const outcome = await finishTranslation(result, options, vi.fn())
  expect(outcome.status).toBe('partial')
  expect(outcome.message).toContain('中文翻译失败')
  if (stage !== 'save_translation') expect(mockedInvoke.mock.calls.some(call => call[0] === 'save_translation')).toBe(false)
})

it('does not call API without a transcript or when translation is off', async () => {
  expect((await finishTranslation({ ...result, transcript_available: false }, options, vi.fn())).status).toBe('partial')
  expect((await finishTranslation({ ...result, segments: [] }, options, vi.fn())).status).toBe('partial')
  expect((await finishTranslation(result, { ...options, target: 'none' }, vi.fn())).status).toBe('completed')
  expect(mockedInvoke).not.toHaveBeenCalled()
})

it('lets the AI interface translate an unknown language instead of silently skipping', async () => {
  expect((await finishTranslation({ ...result, source_language: 'unknown' }, options, vi.fn())).status).toBe('completed')
  expect(mockedInvoke).toHaveBeenCalledWith('translate_with_ai', { request: { texts: ['Hello'], source_language: 'unknown' } })
})

it('rejects incomplete API batches without writing files', async () => {
  mockedInvoke.mockResolvedValue([])
  expect((await finishTranslation(result, options, vi.fn())).status).toBe('partial')
  expect(mockedInvoke.mock.calls.some(call => call[0] === 'save_translation')).toBe(false)
})

it('preserves segment order across multiple API batches', async () => {
  const segments = Array.from({ length: 25 }, (_, index) => ({ ...result.segments[0], index: index + 1, text: `line ${index}` }))
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === 'translate_with_ai') return (args as { request: { texts: string[] } }).request.texts.map(text => `译文 ${text}`)
  })
  expect((await finishTranslation({ ...result, segments }, options, vi.fn())).status).toBe('completed')
  expect(mockedInvoke.mock.calls.filter(call => call[0] === 'translate_with_ai')).toHaveLength(3)
  expect(mockedInvoke).toHaveBeenLastCalledWith('save_translation', { request: { output_dir: 'qa', segments, translations: segments.map(segment => `译文 ${segment.text}`) } })
})

it('saves Chinese speech without an unnecessary translation API call', async () => {
  const chinese = { ...result, source_language: 'zh', segments: [{ ...result.segments[0], text: '你好' }] }
  expect((await finishTranslation(chinese, options, vi.fn())).status).toBe('completed')
  expect(mockedInvoke.mock.calls.map(call => call[0])).toEqual(['save_translation'])
  expect(mockedInvoke).toHaveBeenCalledWith('save_translation', { request: { output_dir: 'qa', segments: chinese.segments, translations: ['你好'] } })
})
