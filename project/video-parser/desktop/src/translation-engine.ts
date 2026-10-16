import { AutoModelForSeq2SeqLM, M2M100Tokenizer, env, TranslationPipeline } from '@huggingface/transformers'

export async function createLocalTranslator(modelBaseUrl: string, progress: (value: unknown) => void) {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  env.localModelPath = `${modelBaseUrl.replace(/\/$/, '')}/`
  const id = 'Xenova/m2m100_418M'
  const options = { local_files_only: true, progress_callback: progress }
  // v4's generic pipeline discovers tokenizer files via model metadata. Existing
  // offline v3 model folders have no Hub listing, so load these public components
  // explicitly. This keeps the user's original q8 files and never contacts the Hub.
  const base = new URL(env.localModelPath)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('翻译模型必须来自本机模型服务')
  const readJson = async (name: string) => {
    const response = await fetch(new URL(`${id}/${name}`, base))
    if (!response.ok) throw new Error(`本地翻译模型文件不可用：${name} (${response.status})`)
    return response.json()
  }
  // AutoTokenizer uses the same Hub metadata detection in v4. The documented
  // tokenizer constructor accepts the two existing local JSON files directly.
  const [tokenizerData, tokenizerConfig] = await Promise.all([readJson('tokenizer.json'), readJson('tokenizer_config.json')])
  const tokenizer = new M2M100Tokenizer(tokenizerData, tokenizerConfig)
  const model = await AutoModelForSeq2SeqLM.from_pretrained(id, { ...options, dtype: 'q8', device: 'wasm' })
  return new TranslationPipeline({ task: 'translation', model, tokenizer })
}
