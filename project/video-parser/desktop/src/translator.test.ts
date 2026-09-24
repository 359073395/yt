import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearTranslationModel, preloadTranslationModel, translateToChinese } from './translator'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onmessageerror?: () => void
  calls: { requestId: string; action: string }[] = []
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
  postMessage(value: { requestId: string; action: string }) { this.calls.push(value) }
  complete(translations: string[] = []) { this.onmessage?.({ data: { requestId: this.calls.at(-1)!.requestId, type: 'complete', translations } }) }
}
const tick = () => vi.waitFor(() => expect(FakeWorker.instances.at(-1)?.calls.length).toBeGreaterThan(0))
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker) })
afterEach(() => { clearTranslationModel(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('serializes preload and translation without starting duplicate inference', async () => {
  const preload = preloadTranslationModel('http://127.0.0.1/model')
  const translated = translateToChinese(['Hello'], 'en', 'http://127.0.0.1/model')
  await tick()
  const worker = FakeWorker.instances[0]
  expect(worker.calls.map(x => x.action)).toEqual(['preload'])
  worker.complete()
  await preload
  await vi.waitFor(() => expect(worker.calls).toHaveLength(2))
  worker.complete(['你好'])
  expect(await translated).toEqual(['你好'])
})

it('rejects a crashed worker and lets the next task create a fresh worker', async () => {
  const request = translateToChinese(['Hello'], 'en', 'http://127.0.0.1/model')
  const rejected = expect(request).rejects.toThrow('引擎异常')
  await tick()
  FakeWorker.instances[0].onerror?.()
  await rejected
  const retry = translateToChinese(['Hello'], 'en', 'http://127.0.0.1/model')
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
  FakeWorker.instances[1].complete(['你好'])
  expect(await retry).toEqual(['你好'])
})

it('cancels only the active task, then resumes the next queued task', async () => {
  const controller = new AbortController()
  const first = translateToChinese(['A'], 'en', 'local', undefined, controller.signal)
  const rejected = expect(first).rejects.toThrow('取消')
  const second = translateToChinese(['B'], 'en', 'local')
  await tick()
  controller.abort()
  await rejected
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
  FakeWorker.instances[1].complete(['乙'])
  expect(await second).toEqual(['乙'])
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

it('model reset cancels queued tasks before they load stale model files', async () => {
  const first = preloadTranslationModel('local')
  const second = translateToChinese(['Hello'], 'en', 'local')
  const firstError = expect(first).rejects.toThrow('取消')
  const secondError = expect(second).rejects.toThrow('取消')
  await tick()
  clearTranslationModel()
  await firstError
  await secondError
  expect(FakeWorker.instances).toHaveLength(1)
})

it('ends a stalled translation rather than leaving a permanent progress state', async () => {
  vi.useFakeTimers()
  const request = translateToChinese(['Hello'], 'en', 'local')
  const rejected = expect(request).rejects.toThrow('长时间未响应')
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
  await rejected
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
})
