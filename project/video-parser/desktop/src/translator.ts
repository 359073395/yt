import { invoke } from '@tauri-apps/api/core'

type ProgressHandler = (percent: number, message: string) => void
type Pending = { resolve: (value: string[]) => void; reject: (reason: Error) => void; progress?: ProgressHandler }

let worker: Worker | null = null
const pending = new Map<string, Pending>()
let workerQueue: Promise<unknown> = Promise.resolve()
let generation = 0

function stopWorker(message: string) {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) request.reject(new Error(message))
  pending.clear()
}

function normalizeModelProgress(payload: Record<string, unknown>) {
  const raw = Number(payload.progress ?? 0)
  if (Number.isFinite(raw) && raw > 0) return Math.max(0, Math.min(100, raw))
  return payload.status === 'ready' || payload.status === 'done' ? 100 : 0
}

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./translation-worker.ts', import.meta.url), { type: 'module' })
  worker.onerror = () => stopWorker('本地翻译引擎异常，已有视频保留，请重试或切换 AI 接口')
  worker.onmessageerror = () => stopWorker('本地翻译返回数据损坏，请重试')
  worker.onmessage = (event: MessageEvent) => {
    const { requestId, type } = event.data as { requestId: string; type: string }
    const request = pending.get(requestId)
    if (!request) return
    if (type === 'model-progress') {
      request.progress?.(normalizeModelProgress(event.data.progress ?? {}), '正在准备中文翻译模型')
    } else if (type === 'ready') {
      request.progress?.(100, '中文翻译模型已载入')
    } else if (type === 'translate-progress') {
      request.progress?.(Number(event.data.percent ?? 0), '正在翻译为中文')
    } else if (type === 'complete') {
      pending.delete(requestId)
      request.resolve(event.data.translations ?? [])
    } else if (type === 'error') {
      pending.delete(requestId)
      request.reject(new Error(event.data.message || '中文翻译失败'))
    }
  }
  return worker
}

function requestWorker(action: 'preload' | 'translate', texts: string[], source: string, modelBaseUrl: string, progress?: ProgressHandler, signal?: AbortSignal) {
  const requestedGeneration = generation
  // One model instance, one inference at a time, including Feishu tasks and preload.
  const result = workerQueue.catch(() => undefined).then(() => {
    if (signal?.aborted || requestedGeneration !== generation) throw new Error('翻译已取消')
    return new Promise<string[]>((resolve, reject) => {
      const requestId = crypto.randomUUID()
      let idleTimer: ReturnType<typeof setTimeout>
      const expire = () => stopWorker('本地翻译长时间未响应，已有文件保留，可重试或切换 AI 接口')
      const restartIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(expire, 5 * 60_000) }
      const totalTimer = setTimeout(expire, 30 * 60_000)
      const abort = () => stopWorker('翻译已取消')
      const cleanup = () => { clearTimeout(idleTimer); clearTimeout(totalTimer); signal?.removeEventListener('abort', abort); pending.delete(requestId) }
      pending.set(requestId, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
        progress: (percent, message) => { restartIdle(); progress?.(percent, message) },
      })
      signal?.addEventListener('abort', abort, { once: true })
      restartIdle()
      try { getWorker().postMessage({ requestId, action, texts, source, modelBaseUrl }) }
      catch (error) { cleanup(); reject(error) }
    })
  })
  workerQueue = result
  return result
}

export function preloadTranslationModel(modelBaseUrl: string, progress?: ProgressHandler) {
  return requestWorker('preload', [], 'en', modelBaseUrl, progress).then(() => undefined)
}

export function translateToChinese(texts: string[], source: string, modelBaseUrl: string, progress?: ProgressHandler, signal?: AbortSignal) {
  return requestWorker('translate', texts, source, modelBaseUrl, progress, signal)
}

export async function translateWithAi(texts: string[], source: string, progress?: ProgressHandler, signal?: AbortSignal) {
  const translations: string[] = []
  const batchSize = 12
  for (let index = 0; index < texts.length; index += batchSize) {
    if (signal?.aborted) throw new Error('翻译已取消');
    const chunk = texts.slice(index, index + batchSize)
    const translated = await invoke<string[]>('translate_with_ai', {
      request: { texts: chunk, source_language: source },
    })
    if (signal?.aborted) throw new Error('翻译已取消');
    if (!Array.isArray(translated) || translated.length !== chunk.length || translated.some(text => typeof text !== 'string' || !text.trim())) throw new Error('AI 接口返回的译文缺失或为空')
    translations.push(...translated)
    progress?.(Math.round((translations.length / texts.length) * 100), 'AI 接口正在翻译为中文')
  }
  return translations
}

export function clearTranslationModel() {
  generation += 1
  stopWorker('翻译任务已取消')
}

export function cancelTranslation() {
  clearTranslationModel()
}

export function toTranslationLanguage(language: string) {
  const normalized = language.toLowerCase().split('-')[0]
  return {
    zh: 'zh',
    en: 'en',
    id: 'id',
    ja: 'ja',
    ko: 'ko',
    es: 'es',
    fr: 'fr',
    de: 'de',
    pt: 'pt',
    ru: 'ru',
    ar: 'ar',
    th: 'th',
    vi: 'vi',
    ms: 'ms',
  }[normalized] ?? null
}
