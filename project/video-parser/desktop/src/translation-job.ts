import { invoke } from '@tauri-apps/api/core'
import type { DownloadResult, TaskStatus, TranslationInput, TranslationProvider } from './core'
import { toTranslationLanguage, translateToChinese, translateWithAi } from './translator'

// A download is not a successful translation until the translated files are saved.
export async function finishTranslation(
  result: DownloadResult,
  options: { target: 'none' | 'zh'; provider: TranslationProvider; modelBaseUrl: string; ready: Promise<void> | null },
  progress: (percent: number, message: string) => void,
): Promise<{ status: TaskStatus; message: string }> {
  const saved = result.warning || '所选内容已保存'
  const done = (message: string) => ({ status: result.warning ? 'partial' as const : 'completed' as const, message })
  const partial = (detail: string) => ({ status: 'partial' as const, message: `${saved}；${detail}` })
  if (options.target !== 'zh') return done(saved)
  if (!result.transcript_available) return partial('没有生成可翻译的字幕，中文翻译未完成')
  const language = toTranslationLanguage(result.source_language)
  if (language === 'zh') return done(`${saved}；语音文案已经是中文，无需翻译`)
  if (!language && options.provider === 'local') return partial('本地翻译不支持或未识别原文语言，请选择来源语言或使用 AI 接口')
  try {
    progress(0, '正在翻译为中文')
    if (options.provider === 'local') await options.ready
    const input = await invoke<TranslationInput>('translation_input', {
      request: { output_dir: result.output_dir, source_language: result.source_language },
    })
    if (!input.segments.length) throw new Error('字幕内容为空')
    const texts = input.segments.map(segment => segment.text)
    const translated = options.provider === 'api'
      ? await translateWithAi(texts, language || result.source_language || 'auto', progress)
      : await translateToChinese(texts, language!, options.modelBaseUrl, progress)
    await invoke('save_translation', { request: { output_dir: result.output_dir, segments: input.segments, translations: translated } })
    const hasTiming = input.segments.every(segment => segment.start && segment.end)
    return done(`${saved}；${hasTiming ? '中文文案、中文字幕和双语字幕已保存' : '中文翻译和双语文案已保存（原文没有时间轴）'}`)
  } catch (error) {
    return partial(`中文翻译失败：${String(error)}`)
  }
}
