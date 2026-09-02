import { env, pipeline } from '@huggingface/transformers'

env.allowLocalModels = true
env.allowRemoteModels = false
env.useBrowserCache = false

let translatorPromise: Promise<any> | null = null

function getTranslator(requestId: string, modelBaseUrl: string) {
  env.localModelPath = `${modelBaseUrl.replace(/\/$/, '')}/`
  translatorPromise ??= (pipeline as any)('translation', 'Xenova/m2m100_418M', {
    dtype: 'q8',
    device: 'wasm',
    local_files_only: true,
    progress_callback: (progress: Record<string, unknown>) => {
      self.postMessage({ requestId, type: 'model-progress', progress })
    },
  })
  return translatorPromise
}

self.addEventListener('message', async (event: MessageEvent) => {
  const { requestId, action, texts = [], source = 'en', modelBaseUrl } = event.data as {
    requestId: string
    action: 'preload' | 'translate'
    texts?: string[]
    source?: string
    modelBaseUrl: string
  }
  try {
    if (!modelBaseUrl) throw new Error('本地模型服务尚未启动')
    const translator = await getTranslator(requestId, modelBaseUrl)
    self.postMessage({ requestId, type: 'ready' })
    if (action === 'preload') {
      self.postMessage({ requestId, type: 'complete', translations: [] })
      return
    }

    const translations: string[] = []
    // M2M100's quantized ONNX decoder is reliable one sentence at a time;
    // batched decoding can mix token histories and produce repeated text.
    const batchSize = 1
    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize)
      const output = await translator(batch, {
        src_lang: source,
        tgt_lang: 'zh',
        max_new_tokens: 96,
        num_beams: 4,
        repetition_penalty: 1.2,
        no_repeat_ngram_size: 3,
        early_stopping: true,
      })
      const items = Array.isArray(output) ? output : [output]
      for (const item of items as Array<{ translation_text?: string }>) {
        translations.push(item.translation_text?.replaceAll('<unk>', '').replace(/\s+/g, ' ').trim() || '')
      }
      self.postMessage({
        requestId,
        type: 'translate-progress',
        percent: Math.min(100, Math.round(((index + batch.length) / texts.length) * 100)),
      })
    }
    self.postMessage({ requestId, type: 'complete', translations })
  } catch (error) {
    translatorPromise = null
    self.postMessage({ requestId, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})
