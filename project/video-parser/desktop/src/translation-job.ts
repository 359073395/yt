import { invoke } from '@tauri-apps/api/core'
import type { DownloadResult, TaskStatus, TranslationProvider } from './core'
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
  if (!result.transcript_available || !result.segments.length) return partial('没有获得可翻译的语音或字幕，双语文案未生成')
  const language = toTranslationLanguage(result.source_language)
  if (!language && options.provider === 'local') return partial('本地翻译不支持或未识别原文语言，请选择来源语言或使用 AI 接口')
  try {
    progress(0, '正在翻译为中文')
    if (options.provider === 'local' && language !== 'zh') await options.ready
    const texts = result.segments.map(segment => segment.text)
    const translated = language === 'zh' ? texts : options.provider === 'api'
      ? await translateWithAi(texts, language || result.source_language || 'auto', progress)
      : await translateToChinese(texts, language!, options.modelBaseUrl, progress)
    await invoke('save_translation', { request: { output_dir: result.output_dir, segments: result.segments, translations: translated } })
    return done(`${saved}；双语文案已保存${language === 'zh' ? '（原文已是中文，不重复翻译）' : ''}`)
  } catch (error) {
    return partial(`中文翻译失败：${String(error)}`)
  }
}
