type ProgressHandler = (percent: number, message: string) => void
type Pending = { resolve: (value: string[]) => void; reject: (reason: Error) => void; progress?: ProgressHandler }

let worker: Worker | null = null
const pending = new Map<string, Pending>()

function normalizeModelProgress(payload: Record<string, unknown>) {
  const raw = Number(payload.progress ?? 0)
  if (Number.isFinite(raw) && raw > 0) return Math.max(0, Math.min(100, raw))
  return payload.status === 'ready' || payload.status === 'done' ? 100 : 0
}

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./translation-worker.ts', import.meta.url), { type: 'module' })
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

function requestWorker(action: 'preload' | 'translate', texts: string[], source: string, modelBaseUrl: string, progress?: ProgressHandler) {
  return new Promise<string[]>((resolve, reject) => {
    const requestId = crypto.randomUUID()
    pending.set(requestId, { resolve, reject, progress })
    getWorker().postMessage({ requestId, action, texts, source, modelBaseUrl })
  })
}

export function preloadTranslationModel(modelBaseUrl: string, progress?: ProgressHandler) {
  return requestWorker('preload', [], 'en', modelBaseUrl, progress).then(() => undefined)
}

export function translateToChinese(texts: string[], source: string, modelBaseUrl: string, progress?: ProgressHandler) {
  return requestWorker('translate', texts, source, modelBaseUrl, progress)
}

export function clearTranslationModel() {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) request.reject(new Error('翻译任务已取消'))
  pending.clear()
}

export function cancelTranslation() {
  worker?.terminate()
  worker = null
  for (const request of pending.values()) request.reject(new Error('翻译任务已取消'))
  pending.clear()
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
