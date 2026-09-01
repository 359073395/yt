import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Captions,
  Copy,
  Download,
  FileVideo,
  Gauge,
  History,
  Link2,
  Loader2,
  Music2,
  FileText,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react'
import './styles.css'

type JobStatus =
  | 'queued'
  | 'parsing'
  | 'downloading'
  | 'merging'
  | 'transcribing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

type Job = {
  job_id: string
  url: string
  status: JobStatus
  title?: string | null
  platform?: string | null
  thumbnail?: string | null
  thumbnail_proxy_url?: string | null
  thumbnail_download_url?: string | null
  duration?: number | null
  size_bytes?: number | null
  downloaded_bytes: number
  total_bytes?: number | null
  progress: number
  speed?: number | null
  eta?: number | null
  media_type: 'video' | 'audio' | 'transcript'
  format_id: string
  audio_format: string
  subtitle_language?: string | null
  transcript_mode: 'none' | 'native' | 'ai' | 'auto'
  transcript_format: 'txt' | 'srt' | 'vtt'
  transcript_language?: string | null
  include_description: boolean
  include_thumbnail: boolean
  filename?: string | null
  download_url?: string | null
  error?: string | null
  created_at: number
  updated_at: number
  expires_at?: number | null
  can_cancel: boolean
  can_retry: boolean
}

type FormatOption = {
  format_id: string
  label: string
  ext?: string | null
  resolution?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  filesize?: number | null
  has_video: boolean
  has_audio: boolean
}

type SubtitleOption = {
  language: string
  label: string
  automatic: boolean
  ext?: string | null
  download_url?: string | null
}

type ParsedMedia = {
  url: string
  title: string
  extractor?: string | null
  platform?: string | null
  thumbnail?: string | null
  thumbnail_proxy_url?: string | null
  thumbnail_download_url?: string | null
  duration?: number | null
  uploader?: string | null
  description?: string | null
  formats: FormatOption[]
  subtitles: SubtitleOption[]
  subtitle_note?: string | null
  ai_transcription_available: boolean
}

type BatchJobCreateResponse = {
  jobs: { url: string; job_id: string }[]
  quota: Quota
}

type BatchRun = {
  label: string
  jobIds: string[]
  mode: 'batch' | 'profile'
}

type CollectionItem = {
  url: string
  title: string
  thumbnail?: string | null
  thumbnail_proxy_url?: string | null
  duration?: number | null
  uploader?: string | null
}

type CollectionInspectResponse = {
  source_url: string
  title: string
  extractor?: string | null
  total_count?: number | null
  items: CollectionItem[]
  truncated: boolean
}

type Quota = {
  limit: number | null
  used: number
  remaining: number | null
  unlimited: boolean
}

type BrowserSessionResponse = {
  token: string
  quota: Quota
}

const statusText: Record<JobStatus, string> = {
  queued: '排队中',
  parsing: '解析中',
  downloading: '下载中',
  merging: '合并中',
  transcribing: 'AI 转写中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
}

const statusOrder: JobStatus[] = ['queued', 'parsing', 'downloading', 'transcribing', 'merging', 'completed']

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return '未知'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function extractSharedUrls(value: string): string[] {
  const candidates = [
    ...Array.from(value.matchAll(/https?:\/\/[^\s<>"'，。！？；：、【】（）《》\u200b-\u200d\ufeff]+/gi), (match) => match[0]),
    ...Array.from(value.matchAll(/(?:www\.|v\.)?douyin\.com\/[^\s<>"'，。！？；：、【】（）《》\u200b-\u200d\ufeff]+/gi), (match) => `https://${match[0]}`),
  ]
  return Array.from(new Set(candidates.map((candidate) => candidate.replace(/[)\]}>.,!;]+$/g, ''))))
}

function extractSharedUrl(value: string): string | null {
  return extractSharedUrls(value)[0] || null
}

function formatDuration(value?: number | null) {
  if (!value) return '未知'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatDate(value?: number | null) {
  if (!value) return '永久'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value * 1000))
}

function isActiveStep(jobStatus: JobStatus, step: JobStatus) {
  if (jobStatus === 'failed' || jobStatus === 'cancelled' || jobStatus === 'expired') return false
  return statusOrder.indexOf(step) <= statusOrder.indexOf(jobStatus)
}

async function readError(response: Response) {
  const body = await response.json().catch(() => null)
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item
        const field = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== 'body').join('.') : ''
        const message = item?.msg || item?.message || JSON.stringify(item)
        return field ? `${field}: ${message}` : message
      })
      .join('；')
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return '请求失败'
}

function App() {
  const [inputMode, setInputMode] = React.useState<'single' | 'batch' | 'profile'>('single')
  const [url, setUrl] = React.useState('')
  const [batchText, setBatchText] = React.useState('')
  const [collectionUrl, setCollectionUrl] = React.useState('')
  const [collectionLimit, setCollectionLimit] = React.useState(500)
  const [collection, setCollection] = React.useState<CollectionInspectResponse | null>(null)
  const [batchMediaType, setBatchMediaType] = React.useState<'video' | 'audio' | 'transcript'>('video')
  const [batchFormatId, setBatchFormatId] = React.useState('best')
  const [batchAudioFormat, setBatchAudioFormat] = React.useState('mp3')
  const [batchTranscriptMode, setBatchTranscriptMode] = React.useState<'none' | 'native' | 'ai' | 'auto'>('none')
  const [batchTranscriptFormat, setBatchTranscriptFormat] = React.useState<'txt' | 'srt' | 'vtt'>('txt')
  const [batchIncludeDescription, setBatchIncludeDescription] = React.useState(false)
  const [batchIncludeThumbnail, setBatchIncludeThumbnail] = React.useState(false)
  const [parsed, setParsed] = React.useState<ParsedMedia | null>(null)
  const [mediaType, setMediaType] = React.useState<'video' | 'audio' | 'transcript'>('video')
  const [formatId, setFormatId] = React.useState('best')
  const [audioFormat, setAudioFormat] = React.useState('mp3')
  const [subtitle, setSubtitle] = React.useState('')
  const [transcriptMode, setTranscriptMode] = React.useState<'none' | 'native' | 'ai' | 'auto'>('none')
  const [transcriptFormat, setTranscriptFormat] = React.useState<'txt' | 'srt' | 'vtt'>('txt')
  const [transcriptLanguage, setTranscriptLanguage] = React.useState('auto')
  const [includeDescription, setIncludeDescription] = React.useState(false)
  const [includeThumbnail, setIncludeThumbnail] = React.useState(false)
  const [history, setHistory] = React.useState<Job[]>([])
  const [job, setJob] = React.useState<Job | null>(null)
  const [isParsing, setIsParsing] = React.useState(false)
  const [isCreating, setIsCreating] = React.useState(false)
  const [isCollectionParsing, setIsCollectionParsing] = React.useState(false)
  const [isBatchCreating, setIsBatchCreating] = React.useState(false)
  const [batchRun, setBatchRun] = React.useState<BatchRun | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [clientToken, setClientToken] = React.useState('')
  const [sessionReady, setSessionReady] = React.useState(false)
  const batchUrls = React.useMemo(() => extractSharedUrls(batchText), [batchText])
  const batchProgress = React.useMemo(() => {
    if (!batchRun) return null
    const tracked = history.filter((item) => batchRun.jobIds.includes(item.job_id))
    const completed = tracked.filter((item) => item.status === 'completed').length
    const skipped = tracked.filter((item) => item.status === 'failed' && item.error?.includes('已跳过')).length
    const failed = tracked.filter((item) => item.status === 'failed' && !item.error?.includes('已跳过')).length
    const cancelled = tracked.filter((item) => item.status === 'cancelled' || item.status === 'expired').length
    const finished = completed + skipped + failed + cancelled
    return {
      completed,
      skipped,
      failed: failed + cancelled,
      finished,
      total: batchRun.jobIds.length,
      percent: batchRun.jobIds.length ? (finished / batchRun.jobIds.length) * 100 : 0,
    }
  }, [batchRun, history])

  async function apiFetch(path: string, options: RequestInit = {}, authToken = clientToken) {
    const headers = new Headers(options.headers)
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
    return fetch(path, { ...options, headers })
  }

  async function initializeBrowserSession() {
    const savedToken = window.localStorage.getItem('video-parser-browser-token') || ''
    try {
      const response = await apiFetch('/api/browser-session', { method: 'POST' }, savedToken)
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as BrowserSessionResponse
      window.localStorage.setItem('video-parser-browser-token', body.token)
      setClientToken(body.token)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '浏览器私有会话初始化失败，请刷新页面。')
    } finally {
      setSessionReady(true)
    }
  }

  async function refreshHistory(authToken = clientToken) {
    try {
      const response = await apiFetch('/api/jobs', {}, authToken)
      if (response.ok) {
        const items = (await response.json()) as Job[]
        setHistory(items)
        setJob((current) => current ? items.find((item) => item.job_id === current.job_id) || current : current)
        return items
      }
    } catch {
      // History is supplementary; the active task keeps streaming independently.
    }
    return []
  }

  React.useEffect(() => {
    void initializeBrowserSession()
  }, [])

  React.useEffect(() => {
    if (!clientToken) return
    void refreshHistory(clientToken)
  }, [clientToken])

  const hasActiveHistory = history.some((item) => ['queued', 'parsing', 'downloading', 'transcribing', 'merging'].includes(item.status))
  React.useEffect(() => {
    if (!hasActiveHistory) return
    const timer = window.setInterval(() => void refreshHistory(), 2000)
    return () => window.clearInterval(timer)
  }, [hasActiveHistory, clientToken])

  async function parseUrl(event: React.FormEvent) {
    event.preventDefault()
    const value = extractSharedUrl(url)
    setMessage(null)
    if (!value) {
      setMessage('没有从分享文案中找到有效的视频链接。')
      return
    }
    setUrl(value)
    setIsParsing(true)
    setParsed(null)
    try {
      const response = await apiFetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as ParsedMedia
      setParsed(body)
      setFormatId(body.formats[0]?.format_id || 'best')
      setMediaType('video')
      setSubtitle('')
      setTranscriptMode('none')
      setIncludeDescription(false)
      setIncludeThumbnail(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '解析失败')
    } finally {
      setIsParsing(false)
    }
  }

  async function scanCollection(event: React.FormEvent) {
    event.preventDefault()
    setMessage(null)
    setCollection(null)
    const value = extractSharedUrl(collectionUrl)
    if (!value) {
      setMessage('没有从分享文案中找到有效的主页、频道或播放列表链接。')
      return
    }
    setCollectionUrl(value)
    setIsCollectionParsing(true)
    try {
      const response = await apiFetch('/api/collections/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: value,
          max_items: collectionLimit,
        }),
      })
      if (!response.ok) throw new Error(await readError(response))
      setCollection((await response.json()) as CollectionInspectResponse)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '主页扫描失败')
    } finally {
      setIsCollectionParsing(false)
    }
  }

  async function submitBatchJobs(urls: string[], successMessage: (count: number) => string, mode: 'batch' | 'profile') {
    setMessage(null)
    setIsBatchCreating(true)
    try {
      const response = await apiFetch('/api/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls,
          media_type: batchMediaType,
          format_id: batchFormatId,
          audio_format: batchAudioFormat,
          transcript_mode: batchMediaType === 'transcript' ? (batchTranscriptMode === 'none' ? 'auto' : batchTranscriptMode) : batchTranscriptMode,
          transcript_format: batchTranscriptFormat,
          transcript_language: null,
          include_description: batchIncludeDescription,
          include_thumbnail: batchIncludeThumbnail,
        }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as BatchJobCreateResponse
      const confirmation = successMessage(body.jobs.length)
      setBatchRun({ label: confirmation, jobIds: body.jobs.map((item) => item.job_id), mode })
      const items = await refreshHistory()
      const first = items.find((item) => item.job_id === body.jobs[0]?.job_id) || items[0]
      if (first) setJob(first)
      setMessage(confirmation)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量任务创建失败')
    } finally {
      setIsBatchCreating(false)
    }
  }

  async function createLinkBatch(event: React.FormEvent) {
    event.preventDefault()
    if (!batchUrls.length) {
      setMessage('没有找到可下载的视频链接；每行可粘贴一条链接或整段中文分享文案。')
      return
    }
    if (batchUrls.length > 50) {
      setMessage(`识别到 ${batchUrls.length} 条链接，单次最多提交 50 条。`)
      return
    }
    await submitBatchJobs(batchUrls, (count) => `已将 ${count} 条作品链接加入下载队列，可来自不同平台或不同博主。`, 'batch')
  }

  async function createProfileBatch() {
    const urls = collection?.items.map((item) => item.url) || []
    if (!urls.length) {
      setMessage('请先扫描一个包含公开视频的博主主页。')
      return
    }
    await submitBatchJobs(urls, (count) => `已从“${collection?.title || '该主页'}”将 ${count} 个视频全部加入下载队列。`, 'profile')
  }

  function renderBatchOptions() {
    return (
      <>
        <div className="batch-options">
          <label><span>统一下载类型</span><select value={batchMediaType} onChange={(event) => { const next = event.target.value as 'video' | 'audio' | 'transcript'; setBatchMediaType(next); if (next === 'transcript' && batchTranscriptMode === 'none') setBatchTranscriptMode('auto'); if (next !== 'transcript' && batchMediaType === 'transcript') setBatchTranscriptMode('none') }}><option value="video">视频</option><option value="audio">仅音频</option><option value="transcript">仅字幕 / 口播文案</option></select></label>
          {batchMediaType === 'video' && <label><span>统一画质上限</span><select value={batchFormatId} onChange={(event) => setBatchFormatId(event.target.value)}><option value="best">自动最佳画质</option><option value="max-2160">最高 4K / 2160p</option><option value="max-1440">最高 2K / 1440p</option><option value="max-1080">最高 1080p</option><option value="max-720">最高 720p</option><option value="max-480">最高 480p</option><option value="max-360">最高 360p</option></select></label>}
          {batchMediaType === 'audio' && <label><span>统一音频格式</span><select value={batchAudioFormat} onChange={(event) => setBatchAudioFormat(event.target.value)}><option value="mp3">MP3</option><option value="m4a">M4A</option><option value="opus">OPUS</option><option value="flac">FLAC</option><option value="wav">WAV</option></select></label>}
          {batchMediaType !== 'transcript' && <label><span>随每个文件生成文案</span><select value={batchTranscriptMode} onChange={(event) => setBatchTranscriptMode(event.target.value as 'none' | 'native' | 'ai' | 'auto')}><option value="none">不生成</option><option value="auto">自动 · 原生字幕优先，AI 兜底</option><option value="native">仅平台原生字幕</option><option value="ai">AI 识别视频语音</option></select></label>}
          {batchMediaType === 'transcript' && <label><span>提取方式</span><select value={batchTranscriptMode === 'none' ? 'auto' : batchTranscriptMode} onChange={(event) => setBatchTranscriptMode(event.target.value as 'native' | 'ai' | 'auto')}><option value="auto">自动 · 原生字幕优先，AI 兜底</option><option value="native">仅平台原生字幕</option><option value="ai">AI 识别视频语音</option></select></label>}
          {(batchMediaType === 'transcript' || batchTranscriptMode !== 'none') && <label><span>文案格式</span><select value={batchTranscriptFormat} onChange={(event) => setBatchTranscriptFormat(event.target.value as 'txt' | 'srt' | 'vtt')}><option value="txt">TXT · 纯文字</option><option value="srt">SRT · 带时间轴</option><option value="vtt">VTT · 网页字幕</option></select></label>}
        </div>
        <div className="bundle-options">
          <label><input type="checkbox" checked={batchIncludeDescription} onChange={(event) => setBatchIncludeDescription(event.target.checked)} />附带作品标题、描述与话题文案</label>
          <label><input type="checkbox" checked={batchIncludeThumbnail} onChange={(event) => setBatchIncludeThumbnail(event.target.checked)} />附带原始封面</label>
        </div>
      </>
    )
  }

  async function createJob() {
    if (!parsed) return
    setMessage(null)
    setIsCreating(true)
    const selected = parsed.formats.find((item) => item.format_id === formatId)
    try {
      const response = await apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: parsed.url,
          media_type: mediaType,
          format_id: formatId,
          format_has_audio: selected?.has_audio ?? false,
          audio_format: audioFormat,
          subtitle_language: mediaType === 'video' && subtitle ? subtitle : null,
          transcript_mode: mediaType === 'transcript' ? (transcriptMode === 'none' ? 'auto' : transcriptMode) : transcriptMode,
          transcript_format: transcriptFormat,
          transcript_language: transcriptLanguage === 'auto' ? null : transcriptLanguage,
          include_description: includeDescription,
          include_thumbnail: includeThumbnail,
        }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as { job_id: string }
      const nextResponse = await apiFetch(`/api/jobs/${body.job_id}`)
      if (!nextResponse.ok) throw new Error(await readError(nextResponse))
      const next = (await nextResponse.json()) as Job
      setJob(next)
      setHistory((items) => [next, ...items.filter((item) => item.job_id !== next.job_id)])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务创建失败')
    } finally {
      setIsCreating(false)
    }
  }

  async function jobAction(action: 'cancel' | 'retry', target = job) {
    if (!target) return
    setMessage(null)
    try {
      const response = await apiFetch(`/api/jobs/${target.job_id}/${action}`, { method: 'POST' })
      if (!response.ok) throw new Error(await readError(response))
      const next = (await response.json()) as Job
      setJob(next)
      setHistory((items) => [next, ...items.filter((item) => item.job_id !== next.job_id)])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败')
    }
  }

  async function copyDownloadLink(downloadUrl?: string | null) {
    if (!downloadUrl) return
    await navigator.clipboard.writeText(new URL(downloadUrl, window.location.origin).toString())
    setMessage('15 分钟有效的下载链接已复制。')
  }

  const selectedSubtitle = parsed?.subtitles.find((item) => item.language === subtitle)
  return (
    <main className="app-shell app-v2">
      <header className="top-nav">
        <a className="brand" href="#top"><span className="brand-mark"><Play size={15} fill="currentColor" /></span>影链工坊 <em>公开版</em></a>
        <nav><a href="#workspace">下载工作台</a><a href="#platforms">支持平台</a><a href="#notice">使用说明</a></nav>
        <span className="public-badge"><CheckCircle2 size={15} />免安装 · 免登录</span>
      </header>

      <section className="v2-intro" id="top">
        <span className="version-pill"><Zap size={14} />影链工坊 2.5 · 公开内容下载中心</span>
        <h1>粘贴链接，选择你真正需要的格式。</h1>
        <p>无需安装助手，不用登录账号。单条作品、多链接批量、博主主页、画质、封面、字幕和文案，一处完成。</p>
      </section>

      <section className="workbench" id="workspace">
        <div className="parser-workspace">
          <div className="entry-mode" role="tablist" aria-label="下载模式">
            <button className={inputMode === 'single' ? 'active' : ''} type="button" onClick={() => { setInputMode('single'); setMessage(null) }}>单条解析</button>
            <button className={inputMode === 'batch' ? 'active' : ''} type="button" onClick={() => { setInputMode('batch'); setMessage(null) }}>多链接批量</button>
            <button className={inputMode === 'profile' ? 'active' : ''} type="button" onClick={() => { setInputMode('profile'); setMessage(null) }}>博主主页</button>
          </div>
          <div className="public-mode-bar">
            <span><CheckCircle2 size={15} />免安装 · 免登录 · 仅处理无需账号即可访问的公开内容</span>
            <small>服务器自动建立匿名访客会话</small>
          </div>

          {inputMode === 'single' ? (
            <form className="parser-form parser-form-v2" onSubmit={parseUrl}>
              <label htmlFor="video-url">视频链接</label>
              <div className="input-row">
                <Link2 size={20} />
                <input id="video-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴 YouTube / 抖音 / Bilibili / TikTok 等链接" autoComplete="off" />
                <button type="submit" disabled={isParsing || !sessionReady || !clientToken}>
                  {isParsing ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}{isParsing ? '正在解析' : '解析链接'}
                </button>
              </div>
            </form>
          ) : inputMode === 'batch' ? (
            <form className="batch-form multi-link-batch" onSubmit={createLinkBatch}>
              <div className="batch-heading"><label htmlFor="batch-urls">多条作品链接</label><span>可混合不同平台、不同博主 · 最多 50 条</span></div>
              <div className="multi-link-input">
                <textarea id="batch-urls" value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'每行粘贴一条视频链接，或直接粘贴多段带中文的分享文案\nhttps://www.tiktok.com/@creator/video/123...\n长按复制此条消息，打开抖音查看作品 https://v.douyin.com/...'} rows={7} />
                <span className={batchUrls.length > 50 ? 'over-limit' : ''}>已识别 {batchUrls.length} 条</span>
              </div>
              {batchUrls.length > 0 && (
                <div className="multi-link-preview">
                  {batchUrls.slice(0, 8).map((item, index) => <div className="multi-link-item" key={item}><span>{index + 1}</span><code>{item}</code></div>)}
                  {batchUrls.length > 8 && <p>另有 {batchUrls.length - 8} 条链接，将一起加入队列。</p>}
                </div>
              )}
              {renderBatchOptions()}
              <button className="primary-download" type="submit" disabled={isBatchCreating || !batchUrls.length || batchUrls.length > 50 || !sessionReady || !clientToken}>
                {isBatchCreating ? <Loader2 className="spin" size={18} /> : <ClipboardCopy size={18} />}{isBatchCreating ? '正在加入下载队列' : `批量下载 ${batchUrls.length || 0} 条作品`}
              </button>
              <p className="batch-note">每条链接会成为独立任务，按服务器并发能力依次下载；某条不可用会明确跳过，不影响其他链接。</p>
            </form>
          ) : (
            <div className="batch-form">
              <form className="collection-scan" onSubmit={scanCollection}>
                <div className="batch-heading"><label htmlFor="collection-url">单个博主主页 / 频道链接</label><span>最多读取 500 个公开视频</span></div>
                <div className="collection-link-row">
                  <div className="collection-link-input"><Link2 size={19} /><input id="collection-url" value={collectionUrl} onChange={(event) => { setCollectionUrl(event.target.value); setCollection(null) }} placeholder="可粘贴整段分享文案、主页短链或频道链接" autoComplete="off" /></div>
                  <label className="collection-limit"><span>读取范围</span><select value={collectionLimit} onChange={(event) => { setCollectionLimit(Number(event.target.value)); setCollection(null) }}><option value={20}>最近 20 个</option><option value={50}>最近 50 个</option><option value={100}>最近 100 个</option><option value={500}>全部公开作品（最多 500）</option></select></label>
                  <button className="scan-button" type="submit" disabled={isCollectionParsing || !collectionUrl.trim() || !sessionReady || !clientToken}>{isCollectionParsing ? <Loader2 className="spin" size={17} /> : <Search size={17} />}{isCollectionParsing ? '正在扫描' : '扫描主页'}</button>
                </div>
                <p className="batch-note">这里一次只填写一个博主主页；选择“全部公开作品”会自动翻页读取。多位博主的单条作品请使用“多链接批量”。</p>
              </form>

              {isCollectionParsing && <div className="collection-loading"><Loader2 className="spin" size={26} /><div><strong>正在读取主页视频列表</strong><span>系统正在建立匿名访客会话并自动翻页，请稍候。</span></div></div>}

              {collection && (
                <section className="collection-result">
                  <div className="collection-result-head"><div><span>{collection.extractor || '自动识别'} · 已发现 {collection.items.length} 个</span><h2>{collection.title}</h2></div><strong>{collection.items.length}</strong></div>
                  <div className="collection-items">
                    {collection.items.map((item, index) => (
                      <article className="collection-item" key={item.url}>
                        <span className="collection-index">{index + 1}</span>
                        <div className="collection-thumb">{item.thumbnail ? <img src={item.thumbnail_proxy_url || item.thumbnail} alt="" /> : <FileVideo size={18} />}</div>
                        <div><h3>{item.title}</h3><p>{item.uploader || '公开视频'} · {formatDuration(item.duration)}</p></div>
                      </article>
                    ))}
                  </div>
                  {collection.truncated && <p className="collection-warning"><AlertTriangle size={14} />该主页还有更多视频，本次按你选择的上限下载；可提高扫描数量后重新扫描。</p>}
                  {renderBatchOptions()}
                  <button className="primary-download" type="button" onClick={createProfileBatch} disabled={isBatchCreating || !sessionReady || !clientToken}>
                    {isBatchCreating ? <Loader2 className="spin" size={18} /> : <ClipboardCopy size={18} />}{isBatchCreating ? '正在加入下载队列' : `全部下载这 ${collection.items.length} 个视频`}
                  </button>
                  <p className="batch-note">主页里的每个视频会成为独立任务。平台未公开媒体流的作品会单独标记跳过，其余任务继续下载。</p>
                </section>
              )}
            </div>
          )}

          {message && <div className="inline-alert" role="status"><AlertTriangle size={16} />{message}</div>}

          {batchRun && batchRun.mode === inputMode && batchProgress && (
            <section className="batch-progress" aria-live="polite">
              <div className="batch-progress-head">
                <div><span>本次批量任务</span><strong>{batchRun.label}</strong></div>
                <b>{batchProgress.finished} / {batchProgress.total}</b>
              </div>
              <div className="progress-track"><div style={{ width: `${batchProgress.percent}%` }} /></div>
              <div className="batch-progress-stats">
                <span className="batch-stat-completed"><CheckCircle2 size={14} />已完成 {batchProgress.completed}</span>
                <span className="batch-stat-skipped"><AlertTriangle size={14} />平台未提供，已跳过 {batchProgress.skipped}</span>
                <span className="batch-stat-failed"><XCircle size={14} />其他失败 {batchProgress.failed}</span>
                <span><Clock3 size={14} />剩余 {batchProgress.total - batchProgress.finished}</span>
              </div>
              <p>{batchProgress.finished === batchProgress.total ? '本批任务已处理完毕；已完成的文件可直接下载。' : '正在逐条处理；某条失败不会中断整批。'}</p>
            </section>
          )}

          {inputMode === 'single' && !parsed && !isParsing && (
            <div className="empty-parser">
              <div><Link2 size={28} /></div>
              <h2>从一个公开链接开始</h2>
              <p>先读取视频信息和可用格式，确认后再加入下载队列。</p>
            </div>
          )}
          {inputMode === 'single' && isParsing && <div className="empty-parser parsing"><Loader2 className="spin" size={30} /><h2>正在连接解析引擎</h2><p>部分平台可能需要几秒钟完成格式探测。</p></div>}
          {inputMode === 'single' && parsed && (
            <article className="media-config">
              <div className="media-preview">
                <div className="preview-image">{parsed.thumbnail ? <img src={parsed.thumbnail_proxy_url || parsed.thumbnail} alt="视频封面" /> : <FileVideo size={32} />}</div>
                <div className="preview-copy"><span>{parsed.platform || '自动识别'} · {formatDuration(parsed.duration)}</span><h2>{parsed.title}</h2><p>{parsed.uploader || '公开内容'}</p>{parsed.thumbnail_download_url && <a className="cover-download" href={parsed.thumbnail_download_url}><Download size={14} />下载原始封面</a>}</div>
              </div>
              {parsed.description && <details className="description-preview"><summary><FileText size={14} />查看作品公开文案</summary><p>{parsed.description}</p><button type="button" onClick={() => navigator.clipboard.writeText(parsed.description || '')}><Copy size={14} />复制文案</button></details>}
              <div className="media-tabs">
                <button className={mediaType === 'video' ? 'active' : ''} type="button" onClick={() => { if (mediaType === 'transcript') setTranscriptMode('none'); setMediaType('video') }}><FileVideo size={17} />视频</button>
                <button className={mediaType === 'audio' ? 'active' : ''} type="button" onClick={() => { if (mediaType === 'transcript') setTranscriptMode('none'); setMediaType('audio') }}><Music2 size={17} />仅音频</button>
                <button className={mediaType === 'transcript' ? 'active' : ''} type="button" onClick={() => { setMediaType('transcript'); if (transcriptMode === 'none') setTranscriptMode('auto') }}><FileText size={17} />字幕 / 文案</button>
              </div>
              <div className="option-grid">
                {mediaType === 'video' ? (
                  <>
                    <label><span>画质与格式</span><select value={formatId} disabled={parsed.formats.length === 1} onChange={(event) => setFormatId(event.target.value)}>{parsed.formats.map((item) => <option value={item.format_id} key={item.format_id}>{item.label}{item.filesize ? ` · ${formatBytes(item.filesize)}` : ''}</option>)}</select><small>{parsed.formats.length === 1 ? '平台仅提供这一档可下载画质' : `检测到 ${parsed.formats.length - 1} 个具体格式`}</small></label>
                    <label><span><Captions size={14} />字幕</span><select value={subtitle} disabled={!parsed.subtitles.length} onChange={(event) => setSubtitle(event.target.value)}><option value="">{parsed.subtitles.length ? '不嵌入字幕' : '无可下载字幕'}</option>{parsed.subtitles.map((item) => <option value={item.language} key={item.language}>{item.label}{item.ext ? ` · ${item.ext.toUpperCase()}` : ''}{item.automatic ? '（自动）' : ''}</option>)}</select><small>{parsed.subtitle_note || '选择后会嵌入视频，也可单独下载字幕文件'}</small>{selectedSubtitle?.download_url && <a className="subtitle-download" href={selectedSubtitle.download_url}><Download size={13} />单独下载 {selectedSubtitle.label} 字幕</a>}</label>
                  </>
                ) : mediaType === 'audio' ? (
                  <label><span>音频格式</span><select value={audioFormat} onChange={(event) => setAudioFormat(event.target.value)}><option value="mp3">MP3 · 通用兼容</option><option value="m4a">M4A · 保留质量</option><option value="opus">OPUS · 高压缩率</option><option value="flac">FLAC · 无损</option><option value="wav">WAV · 未压缩</option></select></label>
                ) : (
                  <>
                    <label><span><Sparkles size={14} />提取方式</span><select value={transcriptMode === 'none' ? 'auto' : transcriptMode} onChange={(event) => setTranscriptMode(event.target.value as 'native' | 'ai' | 'auto')}><option value="auto">自动 · 原生字幕优先，AI 兜底</option><option value="native" disabled={!parsed.subtitles.length}>仅平台原生字幕</option><option value="ai" disabled={!parsed.ai_transcription_available}>AI 识别视频语音</option></select><small>{parsed.subtitles.length ? `检测到 ${parsed.subtitles.length} 条平台字幕轨道` : '没有原生字幕时将自动识别口播语音'}</small></label>
                    <label><span>导出格式</span><select value={transcriptFormat} onChange={(event) => setTranscriptFormat(event.target.value as 'txt' | 'srt' | 'vtt')}><option value="txt">TXT · 纯文字文案</option><option value="srt">SRT · 视频剪辑字幕</option><option value="vtt">VTT · 网页字幕</option></select></label>
                    <label><span>语音语言</span><select value={transcriptLanguage} onChange={(event) => setTranscriptLanguage(event.target.value)}><option value="auto">自动识别语言</option><option value="zh">中文</option><option value="en">英语</option><option value="id">印尼语</option><option value="ja">日语</option><option value="ko">韩语</option></select><small>仅 AI 语音转写时使用</small></label>
                  </>
                )}
              </div>
              {mediaType !== 'transcript' && (
                <div className="transcript-addon">
                  <label><span><FileText size={14} />随文件生成口播文案</span><select value={transcriptMode} onChange={(event) => setTranscriptMode(event.target.value as 'none' | 'native' | 'ai' | 'auto')}><option value="none">不生成</option><option value="auto">自动 · 原生字幕优先，AI 兜底</option><option value="native" disabled={!parsed.subtitles.length}>仅平台原生字幕</option><option value="ai" disabled={!parsed.ai_transcription_available}>AI 语音识别</option></select></label>
                  {transcriptMode !== 'none' && <label><span>文案格式</span><select value={transcriptFormat} onChange={(event) => setTranscriptFormat(event.target.value as 'txt' | 'srt' | 'vtt')}><option value="txt">TXT</option><option value="srt">SRT</option><option value="vtt">VTT</option></select></label>}
                </div>
              )}
              <div className="bundle-options">
                <label><input type="checkbox" checked={includeDescription} onChange={(event) => setIncludeDescription(event.target.checked)} />附带标题、描述与话题文案</label>
                <label><input type="checkbox" checked={includeThumbnail} onChange={(event) => setIncludeThumbnail(event.target.checked)} />附带原始封面</label>
                {(includeDescription || includeThumbnail || (mediaType !== 'transcript' && transcriptMode !== 'none')) && <small>多个文件会自动打包为 ZIP。</small>}
              </div>
              <button className="primary-download" type="button" onClick={createJob} disabled={isCreating || !sessionReady || !clientToken}>
                {isCreating ? <Loader2 className="spin" size={18} /> : mediaType === 'transcript' ? <FileText size={18} /> : <Download size={18} />}{isCreating ? '正在创建任务' : `${mediaType === 'transcript' ? '开始提取文案' : '加入下载队列'} · 不限次数`}
              </button>
            </article>
          )}
        </div>

        <QueuePanel job={job} history={history} onSelect={setJob} onAction={jobAction} onCopy={copyDownloadLink} />
      </section>

      <section className="lower-grid"><HistoryPanel history={history} /><InfoPanel /></section>
      <FooterInfo />
    </main>
  )
}

function QueuePanel({
  job,
  history,
  onSelect,
  onAction,
  onCopy,
}: {
  job: Job | null
  history: Job[]
  onSelect: (job: Job) => void
  onAction: (action: 'cancel' | 'retry', job?: Job | null) => void
  onCopy: (url?: string | null) => void
}) {
  const current = job || history[0] || null
  const queue = history.filter((item) => ['queued', 'parsing', 'downloading', 'transcribing', 'merging'].includes(item.status))
  return (
    <aside className="queue-panel">
      <div className="queue-header"><div><span className="caption">Download queue</span><h2>下载队列</h2></div><span>{queue.length} 个进行中</span></div>
      {current ? (
        <div className="current-download">
          <div className="current-title"><div className="mini-thumb">{current.thumbnail ? <img src={current.thumbnail_proxy_url || current.thumbnail} alt="" /> : current.media_type === 'transcript' ? <FileText size={22} /> : <FileVideo size={22} />}</div><div><h3>{current.title || '正在读取视频信息'}</h3><p>{current.platform || '解析中'} · {current.media_type === 'audio' ? current.audio_format.toUpperCase() : current.media_type === 'transcript' ? current.transcript_format.toUpperCase() : current.format_id}</p></div></div>
          <div className="current-state"><StatusBadge status={current.status} error={current.error} /><strong>{Math.round(current.progress)}%</strong></div>
          <div className="progress-track"><div style={{ width: `${Math.max(0, Math.min(current.progress, 100))}%` }} /></div>
          <div className="transfer-meta"><span>{formatBytes(current.downloaded_bytes)} / {formatBytes(current.total_bytes)}</span><span>{current.speed ? `${formatBytes(current.speed)}/s` : '等待数据'}{current.eta ? ` · ${current.eta}s` : ''}</span></div>
          {current.error && <p className="error-text">{current.error}</p>}
          <div className="action-row">
            {current.download_url && <a className="download-button" href={current.download_url}><Download size={17} />下载文件</a>}
            {current.thumbnail_download_url && <a className="secondary-button" href={current.thumbnail_download_url}><Download size={15} />封面</a>}
            {current.download_url && <button className="secondary-button" type="button" onClick={() => onCopy(current.download_url)}><Copy size={16} />复制链接</button>}
            {current.can_cancel && <button className="secondary-button danger-soft" type="button" onClick={() => onAction('cancel', current)}><XCircle size={16} />取消</button>}
            {current.can_retry && <button className="secondary-button" type="button" onClick={() => onAction('retry', current)}><RotateCcw size={16} />重试</button>}
          </div>
        </div>
      ) : (
        <div className="queue-empty"><Clock3 size={26} /><h3>队列还是空的</h3><p>解析链接并选择格式后，任务会出现在这里。</p></div>
      )}
      <div className="queue-list">
        {history.slice(0, 8).map((item) => (
          <button className={current?.job_id === item.job_id ? 'active' : ''} type="button" key={item.job_id} onClick={() => onSelect(item)}>
            <div><strong>{item.title || '等待解析'}</strong><span>{formatDate(item.created_at)} · {item.media_type === 'audio' ? '音频' : item.media_type === 'transcript' ? '字幕 / 文案' : '视频'}</span></div><StatusBadge status={item.status} error={item.error} />
          </button>
        ))}
      </div>
    </aside>
  )
}

function TaskPanel({ job, onCopy }: { job: Job; onCopy: (downloadUrl?: string | null) => void }) {
  const isPreview = job.job_id === 'preview'
  return (
    <section className="task-panel" aria-label="当前任务">
      <div className="panel-header">
        <div>
          <span className="caption">Current job</span>
          <h2>{isPreview ? '等待链接输入' : statusText[job.status]}</h2>
        </div>
        <StatusBadge status={job.status} error={job.error} />
      </div>

      <div className="steps">
        {statusOrder.map((step) => (
          <div className={`step ${isActiveStep(job.status, step) ? 'active' : ''}`} key={step}>
            <span />
            {statusText[step]}
          </div>
        ))}
      </div>

      <div className="progress-track">
        <div style={{ width: `${Math.max(0, Math.min(job.progress, 100))}%` }} />
      </div>

      <article className="result-row">
        <div className="thumb">
          {job.thumbnail ? <img src={job.thumbnail_proxy_url || job.thumbnail} alt="" /> : <FileVideo size={28} />}
        </div>
        <div className="result-main">
          <h3>{job.title || '链接提交后会显示视频标题'}</h3>
          <dl>
            <div><dt>平台</dt><dd>{job.platform || '自动识别'}</dd></div>
            <div><dt>时长</dt><dd>{formatDuration(job.duration)}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(job.size_bytes || job.total_bytes)}</dd></div>
          </dl>
          {job.error && <p className="error-text">{job.error}</p>}
        </div>
      </article>

      <div className="action-row">
        <a
          className={`download-button ${job.download_url ? '' : 'disabled'}`}
          href={job.download_url || '#'}
          aria-disabled={!job.download_url}
        >
          <Download size={17} />
          下载文件
        </a>
        <button className="secondary-button" type="button" disabled={!job.download_url} onClick={() => onCopy(job.download_url)}>
          <Copy size={16} />
          复制链接
        </button>
      </div>
    </section>
  )
}

function HistoryPanel({ history }: { history: Job[] }) {
  return (
    <section className="panel history-panel" aria-label="最近任务">
      <div className="panel-title">
        <History size={17} />
        <h2>最近任务</h2>
      </div>
      <div className="history-list">
        {history.slice(0, 4).map((item) => (
          <div className="history-item" key={item.job_id}>
            <div>
              <strong>{item.title || '未命名视频'}</strong>
              <span>{item.platform || new URL(item.url).hostname}</span>
            </div>
            <StatusBadge status={item.status} error={item.error} />
          </div>
        ))}
        {!history.length && <p className="history-empty">完成或失败的任务会持久保存在这里。</p>}
      </div>
    </section>
  )
}

function InfoPanel() {
  const internationalPlatforms = [
    'YouTube',
    'TikTok',
    'Instagram',
    'Facebook',
    'X / Twitter',
    'Bilibili',
    'Vimeo',
    'SoundCloud',
    'Reddit',
    'Twitch',
    'Dailymotion',
    'Rumble',
  ]
  const chinaPlatforms = ['抖音', '小红书', '哔哩哔哩', '微博', 'AcFun', '优酷', '爱奇艺', '腾讯视频', '百度视频', '斗鱼', '虎牙']

  return (
    <section className="panel info-panel" id="platforms">
      <div className="info-block">
        <span className="caption">Platforms</span>
        <h2>支持平台</h2>
        <p>能力跟随当前 yt-dlp、服务器区域、平台风控和公开页面可用性。快手、Shopee 与 TikTok Shop 属于实验性解析。</p>
      </div>
      <span className="platform-group-title">国内平台</span>
      <div className="platform-list" aria-label="支持平台列表">
        {chinaPlatforms.map((platform) => (
          <span key={platform}>{platform}</span>
        ))}
      </div>
      <span className="platform-group-title">国际平台</span>
      <div className="platform-list" aria-label="支持平台列表">
        {internationalPlatforms.map((platform) => (
          <span key={platform}>{platform}</span>
        ))}
      </div>
    </section>
  )
}

function FooterInfo() {
  return (
    <section className="footer-info" aria-label="安全限制与免责声明">
      <article className="footer-card" id="limits">
        <div className="panel-title">
          <Shield size={17} />
          <h2>安全限制</h2>
        </div>
        <div className="limit-grid">
          <span><Download size={16} />无需安装，无需注册</span>
          <span><CheckCircle2 size={16} />匿名访客会话自动建立</span>
          <span><Shield size={16} />只处理公开可访问内容</span>
          <span><Gauge size={16} />默认 512 MB 文件上限</span>
          <span><FileText size={16} />原生字幕优先，AI 转写兜底</span>
        </div>
      </article>

      <article className="footer-card" id="notice">
        <div className="panel-title">
          <AlertTriangle size={17} />
          <h2>免责声明</h2>
        </div>
        <p className="notice">请只处理你拥有权利或已获授权的视频内容。本工具不承诺绕过登录、DRM、私密内容或平台反爬限制。</p>
      </article>
    </section>
  )
}

function StatusBadge({ status, error }: { status: JobStatus; error?: string | null }) {
  const skipped = status === 'failed' && error?.includes('已跳过')
  const icon = status === 'completed' ? <CheckCircle2 size={14} /> : status === 'failed' || status === 'cancelled' || status === 'expired' ? <AlertTriangle size={14} /> : <Loader2 size={14} className={status === 'queued' ? '' : 'spin'} />
  return <span className={`status ${skipped ? 'status-skipped' : `status-${status}`}`}>{icon}{skipped ? '已跳过' : statusText[status]}</span>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
