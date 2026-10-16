import { afterEach, expect, it, vi } from 'vitest'
import { AutoModelForSeq2SeqLM, M2M100Tokenizer, env, TranslationPipeline } from '@huggingface/transformers'
import { createLocalTranslator } from './translation-engine'

vi.mock('@huggingface/transformers', () => ({
  env: {}, M2M100Tokenizer: vi.fn(class { kind = 'tokenizer' }),
  AutoModelForSeq2SeqLM: { from_pretrained: vi.fn().mockResolvedValue({ kind: 'model' }) },
  TranslationPipeline: vi.fn(class { constructor(public config: unknown) {} }),
}))
afterEach(() => vi.unstubAllGlobals())
it('loads the existing tokenizer explicitly and never requires remote model metadata', async () => {
  const progress = vi.fn()
  const fetchLocal = vi.fn(async (url: URL) => new Response(JSON.stringify({ file: url.pathname.split('/').at(-1) })))
  vi.stubGlobal('fetch', fetchLocal)
  await createLocalTranslator('http://127.0.0.1:4321/', progress)
  expect(env.allowRemoteModels).toBe(false)
  expect(env.allowLocalModels).toBe(true)
  expect(env.localModelPath).toBe('http://127.0.0.1:4321/')
  expect(fetchLocal).toHaveBeenCalledTimes(2)
  expect(fetchLocal.mock.calls.every(([url]) => url.origin === 'http://127.0.0.1:4321')).toBe(true)
  expect(M2M100Tokenizer).toHaveBeenCalledWith({ file: 'tokenizer.json' }, { file: 'tokenizer_config.json' })
  expect(AutoModelForSeq2SeqLM.from_pretrained).toHaveBeenCalledWith('Xenova/m2m100_418M', { local_files_only: true, progress_callback: progress, dtype: 'q8', device: 'wasm' })
  expect(TranslationPipeline).toHaveBeenCalledWith({ task: 'translation', tokenizer: { kind: 'tokenizer' }, model: { kind: 'model' } })
})
it('rejects remote model hosts and missing local model files', async () => {
  await expect(createLocalTranslator('https://example.com/', vi.fn())).rejects.toThrow('本机模型')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  await expect(createLocalTranslator('http://127.0.0.1:4321/', vi.fn())).rejects.toThrow('模型文件不可用')
})
