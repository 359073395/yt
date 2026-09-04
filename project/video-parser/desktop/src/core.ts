export type InputMode = 'single' | 'batch' | 'profile'
export type TranscriptMode = 'none' | 'auto' | 'native' | 'ai'
export type TaskStatus = 'queued' | 'scanning' | 'downloading' | 'transcribing' | 'completed' | 'partial' | 'failed' | 'cancelled'

export interface RuntimeInfo {
  version: string
  default_download_dir: string
  yt_dlp_available: boolean
  ffmpeg_available: boolean
  whisper_available: boolean
  models: ModelInfo[]
  selected_model: string
  model_dir: string
  model_server_url: string
  translation_model_installed: boolean
  translation_model_size_bytes: number
  login_profile_available: boolean
}

export interface ModelInfo {
  id: string
  name: string
  size_bytes: number
  installed: boolean
  recommended: boolean
}

export interface DownloadOptions {
  download_dir: string
  quality: string
  include_video: boolean
  include_thumbnail: boolean
  include_description: boolean
  transcript_mode: TranscriptMode
  language: string
  model_id: string
  translation_target?: string | null
}

export interface DownloadRequest {
  job_id: string
  url: string
  options: DownloadOptions
}

export interface DownloadResult {
  output_dir: string
  title: string
  platform: string
  transcript_available: boolean
  source_language: string
  warning?: string | null
}

export interface TranslationSegment {
  index: number
  start: string
  end: string
  text: string
}

export interface TranslationInput {
  source_language: string
  segments: TranslationSegment[]
}

export interface ProfileItem {
  url: string
  title: string
  id: string
}

export interface MediaPreview {
  url: string
  title: string
  platform: string
  uploader: string
  thumbnail?: string | null
  duration?: number | null
  size_bytes?: number | null
  error?: string | null
}

export interface ProgressEvent {
  job_id: string
  phase: TaskStatus
  percent: number
  message: string
}

export interface DownloadTask {
  id: string
  queueItemId: string
  url: string
  title: string
  platform: string
  status: TaskStatus
  percent: number
  message: string
  outputDir?: string
  sourceLanguage?: string
}

export interface ModelProgress {
  model_id: string
  percent: number
  downloaded: number
  total: number
  message: string
}

export type TranslationProvider = 'local' | 'api'

export interface AiTranslationSettings {
  base_url: string
  model: string
  api_key_saved: boolean
}

const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、；：）】}]+/giu

export function extractSharedUrls(value: string): string[] {
  const unique = new Set<string>()
  for (const match of value.match(URL_PATTERN) ?? []) {
    try {
      const url = new URL(match.replace(/[),.;!?]+$/g, ''))
      if (url.protocol === 'http:' || url.protocol === 'https:') unique.add(url.toString())
    } catch {
      // Ignore malformed fragments from copied share text.
    }
  }
  return [...unique]
}

export function platformName(value: string): string {
  try {
    const host = new URL(value).hostname.toLowerCase()
    if (host.includes('douyin.com')) return '抖音'
    if (host.includes('tiktok.com')) return 'TikTok'
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'YouTube'
    if (host.includes('bilibili.com') || host.includes('b23.tv')) return '哔哩哔哩'
    if (host.includes('instagram.com')) return 'Instagram'
    if (host.includes('facebook.com') || host.includes('fb.watch')) return 'Facebook'
    if (host.includes('twitter.com') || host.includes('x.com')) return 'X / Twitter'
  } catch {
    return '自动识别'
  }
  return '自动识别'
}

export function statusLabel(status: TaskStatus): string {
  return {
    queued: '排队中',
    scanning: '扫描中',
    downloading: '下载中',
    transcribing: '生成文案',
    completed: '已完成',
    partial: '未全部完成',
    failed: '失败',
    cancelled: '已取消',
  }[status]
}
