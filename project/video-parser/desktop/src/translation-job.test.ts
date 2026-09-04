import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { finishTranslation } from './translation-job'
import type { DownloadResult, TranslationInput } from './core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const mockedInvoke = vi.mocked(invoke)
const result: DownloadResult = { output_dir: 'qa', title: 'clip', platform: 'YouTube', transcript_available: true, source_language: 'en' }
const options = { target: 'zh' as const, provider: 'api' as const, modelBaseUrl: '', ready: null }
const input: TranslationInput = { source_language: 'en', segments: [{ index: 1, start: '00:00:00,000', end: '00:00:02,000', text: 'Hello' }] }

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async command => {
    if (command === 'translation_input') return input
    if (command === 'translate_with_ai') return ['你好']
    return undefined
  })
})

it('runs subtitle input → real translator wrapper → file save before success', async () => {
  const outcome = await finishTranslation(result, options, vi.fn())
  expect(outcome.status).toBe('completed')
  expect(mockedInvoke.mock.calls.map(call => call[0])).toEqual(['translation_input', 'translate_with_ai', 'save_translation'])
  expect(mockedInvoke).toHaveBeenLastCalledWith('save_translation', { request: { output_dir: 'qa', segments: input.segments, translations: ['你好'] } })
})

it.each(['translation_input', 'translate_with_ai', 'save_translation'])('never reports success when %s fails', async stage => {
  mockedInvoke.mockImplementation(async command => {
    if (command === stage) throw new Error('QA failure')
    return command === 'translation_input' ? input : ['你好']
  })
  const outcome = await finishTranslation(result, options, vi.fn())
  expect(outcome.status).toBe('partial')
  expect(outcome.message).toContain('中文翻译失败')
  if (stage !== 'save_translation') expect(mockedInvoke.mock.calls.some(call => call[0] === 'save_translation')).toBe(false)
})

it('does not call API without a transcript or when translation is off', async () => {
  expect((await finishTranslation({ ...result, transcript_available: false }, options, vi.fn())).status).toBe('partial')
  expect((await finishTranslation(result, { ...options, target: 'none' }, vi.fn())).status).toBe('completed')
  expect(mockedInvoke).not.toHaveBeenCalled()
})

it('lets the AI interface translate an unknown language instead of silently skipping', async () => {
  expect((await finishTranslation({ ...result, source_language: 'unknown' }, options, vi.fn())).status).toBe('completed')
  expect(mockedInvoke).toHaveBeenCalledWith('translate_with_ai', { request: { texts: ['Hello'], source_language: 'unknown' } })
})

it('rejects incomplete API batches without writing files', async () => {
  mockedInvoke.mockImplementation(async command => command === 'translation_input' ? input : [])
  expect((await finishTranslation(result, options, vi.fn())).status).toBe('partial')
  expect(mockedInvoke.mock.calls.some(call => call[0] === 'save_translation')).toBe(false)
})

it('preserves segment order across multiple API batches', async () => {
  const segments = Array.from({ length: 25 }, (_, index) => ({ ...input.segments[0], index: index + 1, text: `line ${index}` }))
  mockedInvoke.mockImplementation(async (command, args) => {
    if (command === 'translation_input') return { ...input, segments }
    if (command === 'translate_with_ai') return (args as { request: { texts: string[] } }).request.texts.map(text => `译文 ${text}`)
  })
  expect((await finishTranslation(result, options, vi.fn())).status).toBe('completed')
  expect(mockedInvoke.mock.calls.filter(call => call[0] === 'translate_with_ai')).toHaveLength(3)
  expect(mockedInvoke).toHaveBeenLastCalledWith('save_translation', { request: { output_dir: 'qa', segments, translations: segments.map(segment => `译文 ${segment.text}`) } })
})
