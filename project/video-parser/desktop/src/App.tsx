import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { check, type Update } from '@tauri-apps/plugin-updater'
import {
  AlertCircle,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ClipboardPaste,
  Download,
  FileText,
  FolderOpen,
  History,
  Image,
  Languages,
  Link2,
  ListChecks,
  ListVideo,
  LoaderCircle,
  LogIn,
  MoreHorizontal,
  PackageOpen,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Subtitles,
  Trash2,
  UserRound,
  Video,
  WandSparkles,
  X,
} from 'lucide-react'
import {
  type DownloadOptions,
  type DownloadRequest,
  type DownloadResult,
  type DownloadTask,
  type InputMode,
  type MediaPreview,
  type ModelProgress,
  type ProfileItem,
  type ProgressEvent,
  type RuntimeInfo,
  type TranscriptMode,
  type TranslationInput,
  extractSharedUrls,
  platformName,
} from './core'
import { clearTranslationModel, preloadTranslationModel, toTranslationLanguage, translateToChinese } from './translator'

const LOGIN_PLATFORMS = [
  ['douyin', '抖音'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['bilibili', '哔哩哔哩'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['twitter', 'X / Twitter'],
] as const

interface PendingItem extends MediaPreview {
  id: string
  selected: boolean
  quality: string
  loading: boolean
}

interface ModelPromptState {
  speech: boolean
  translation: boolean
  resumeDownload: boolean
}

interface UpdatePromptState {
  currentVersion: string
  version: string
  body: string
}

function formatBytes(value?: number | null) {
  if (!value) return '大小待确认'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(value / 1024 ** 2))} MB`
}

function formatDuration(value?: number | null) {
  if (!value) return '--:--'
  const total = Math.max(0, Math.round(value))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function App() {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [mode, setMode] = React.useState<InputMode>('single')
  const [input, setInput] = React.useState('')
  const [profileLimit, setProfileLimit] = React.useState(50)
  const [downloadDir, setDownloadDir] = React.useState('')
  const [quality] = React.useState('1080')
  const [transcriptMode, setTranscriptMode] = React.useState<TranscriptMode>('none')
  const [language, setLanguage] = React.useState('auto')
  const [modelId, setModelId] = React.useState('small')
  const includeVideo = true
  const [includeThumbnail, setIncludeThumbnail] = React.useState(true)
  const [includeDescription, setIncludeDescription] = React.useState(true)
  const [includeSubtitle, setIncludeSubtitle] = React.useState(false)
  const [pendingItems, setPendingItems] = React.useState<PendingItem[]>([])
  const [tasks, setTasks] = React.useState<DownloadTask[]>([])
  const [running, setRunning] = React.useState(false)
  const [parsing, setParsing] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const [modelsOpen, setModelsOpen] = React.useState(false)
  const [modelPrompt, setModelPrompt] = React.useState<ModelPromptState | null>(null)
  const [modelProgress, setModelProgress] = React.useState<ModelProgress | null>(null)
  const [modelBusy, setModelBusy] = React.useState(false)
  const [translationTarget, setTranslationTarget] = React.useState<'none' | 'zh'>('none')
  const [translationBusy, setTranslationBusy] = React.useState(false)
  const [translationProgress, setTranslationProgress] = React.useState({ percent: 0, message: '' })
  const [translationCached, setTranslationCached] = React.useState(false)
  const [updatePrompt, setUpdatePrompt] = React.useState<UpdatePromptState | null>(null)
  const [updateOpen, setUpdateOpen] = React.useState(false)
  const [updateChecking, setUpdateChecking] = React.useState(false)
  const [updateInstalling, setUpdateInstalling] = React.useState(false)
  const [updateProgress, setUpdateProgress] = React.useState({ percent: 0, downloaded: 0, total: 0 })
  const [updateError, setUpdateError] = React.useState<string | null>(null)
  const parseToken = React.useRef(0)
  const updateRef = React.useRef<Update | null>(null)
  const updateCheckBusy = React.useRef(false)

  const refreshRuntime = React.useCallback(async () => {
    const info = await invoke<RuntimeInfo>('runtime_info')
    setRuntime(info)
    setDownloadDir((current) => current || window.localStorage.getItem('yinglian-download-dir') || info.default_download_dir)
    setModelId((current) => window.localStorage.getItem('yinglian-model') || current || info.selected_model)
    setTranslationCached(info.translation_model_installed)
  }, [])

  React.useEffect(() => {
    refreshRuntime().catch((error) => setMessage(String(error)))
    const cleanups = [
      listen<ProgressEvent>('job-progress', ({ payload }) => {
        setTasks((current) => current.map((task) => task.id === payload.job_id
          ? { ...task, status: payload.phase, percent: payload.percent, message: payload.message }
          : task))
      }),
      listen<ModelProgress>('model-progress', ({ payload }) => {
        if (payload.model_id === 'translation') {
          setTranslationProgress({ percent: payload.percent, message: payload.message })
        } else {
          setModelProgress(payload)
        }
      }),
    ]
    return () => {
      void Promise.all(cleanups).then((items) => items.forEach((cleanup) => cleanup()))
    }
  }, [refreshRuntime])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdates(true), 4000)
    return () => window.clearTimeout(timer)
  }, [])

  const urls = React.useMemo(() => extractSharedUrls(input), [input])
  const selectedItems = React.useMemo(() => pendingItems.filter((item) => item.selected), [pendingItems])
  const selectedModel = runtime?.models.find((model) => model.id === modelId)
  const installedModel = selectedModel?.installed ?? false
  const toolsReady = Boolean(runtime?.yt_dlp_available && runtime?.ffmpeg_available)
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const activeTask = tasks.find((task) => ['queued', 'scanning', 'downloading', 'transcribing'].includes(task.status))
  const estimatedSize = selectedItems.reduce((total, item) => total + (item.size_bytes || 0), 0)

  async function checkForUpdates(silent = false) {
    if (updateCheckBusy.current) return
    if (updateRef.current && updatePrompt) {
      setUpdateOpen(true)
      return
    }
    updateCheckBusy.current = true
    setUpdateChecking(true)
    try {
      const update = await check({ timeout: 15000 })
      if (!update) {
        if (!silent) setMessage(`当前已是最新版本 ${runtime?.version || ''}`.trim())
        return
      }
      if (updateRef.current) await updateRef.current.close()
      updateRef.current = update
      setUpdatePrompt({
        currentVersion: update.currentVersion,
        version: update.version,
        body: update.body?.trim() || '性能、稳定性与下载体验改进。',
      })
      setUpdateProgress({ percent: 0, downloaded: 0, total: 0 })
      setUpdateError(null)
      setUpdateOpen(true)
    } catch (error) {
      if (!silent) setMessage(`检查更新失败：${String(error)}`)
    } finally {
      updateCheckBusy.current = false
      setUpdateChecking(false)
    }
  }

  async function installAvailableUpdate() {
    const update = updateRef.current
    if (!update || updateInstalling) return
    setUpdateInstalling(true)
    setUpdateError(null)
    setUpdateProgress({ percent: 0, downloaded: 0, total: 0 })
    let downloaded = 0
    let total = 0
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0
          setUpdateProgress({ percent: 0, downloaded: 0, total })
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          const percent = total ? Math.min(99, (downloaded / total) * 100) : 0
          setUpdateProgress({ percent, downloaded, total })
        } else {
          setUpdateProgress({ percent: 100, downloaded: total || downloaded, total })
        }
      }, { restartAfterInstall: true })
    } catch (error) {
      setUpdateError(`升级失败，旧版本未被替换：${String(error)}`)
      setUpdateInstalling(false)
    }
  }

  async function chooseDirectory() {
    const selected = await invoke<string | null>('choose_download_dir')
    if (selected) {
      setDownloadDir(selected)
      window.localStorage.setItem('yinglian-download-dir', selected)
    }
  }

  async function chooseModelDirectory() {
    if (modelBusy || translationBusy) return
    const selected = await invoke<string | null>('choose_model_dir')
    if (selected) {
      clearTranslationModel()
      await refreshRuntime()
      setMessage(`模型将保存到：${selected}`)
    }
  }

  async function installModel(selected: string) {
    setModelBusy(true)
    setModelProgress({ model_id: selected, percent: 0, downloaded: 0, total: 0, message: '正在连接模型仓库' })
    try {
      await invoke('download_model', { modelId: selected })
      await refreshRuntime()
      setMessage('多语言语音模型已准备好。')
    } finally {
      setModelBusy(false)
      setModelProgress(null)
    }
  }

  async function removeModel(selected: string) {
    await invoke('delete_model', { modelId: selected })
    await refreshRuntime()
  }

  async function prepareTranslation() {
    if (!runtime?.model_server_url) throw new Error('本地模型服务尚未启动。')
    setTranslationBusy(true)
    setTranslationProgress({ percent: 0, message: '正在连接中文翻译模型' })
    try {
      if (!runtime.translation_model_installed) {
        await invoke('download_translation_model')
        await refreshRuntime()
      }
      await preloadTranslationModel(runtime.model_server_url, (percent, detail) => setTranslationProgress({ percent, message: detail }))
      setTranslationCached(true)
      setMessage('中文翻译模型已准备好。')
    } finally {
      setTranslationBusy(false)
    }
  }

  async function removeTranslationModel() {
    setTranslationBusy(true)
    try {
      clearTranslationModel()
      await invoke('delete_translation_model')
      setTranslationCached(false)
      setTranslationProgress({ percent: 0, message: '' })
      await refreshRuntime()
    } finally {
      setTranslationBusy(false)
    }
  }

  function seedItems(rawUrls: string[], titles?: Map<string, string>) {
    return rawUrls.map<PendingItem>((url) => ({
      id: crypto.randomUUID(),
      url,
      title: titles?.get(url) || '正在读取作品信息',
      platform: platformName(url),
      uploader: '公开作品',
      selected: true,
      quality,
      loading: true,
    }))
  }

  async function inspectInChunks(rawUrls: string[], token: number) {
    for (let index = 0; index < rawUrls.length; index += 12) {
      if (token !== parseToken.current) return
      const chunk = rawUrls.slice(index, index + 12)
      const previews = await invoke<MediaPreview[]>('inspect_items', { urls: chunk })
      if (token !== parseToken.current) return
      const lookup = new Map(previews.map((item) => [item.url, item]))
      setPendingItems((current) => current.map((item) => {
        const preview = lookup.get(item.url)
        return preview ? { ...item, ...preview, loading: false } : item
      }))
    }
  }

  async function parseLinks(event?: React.FormEvent) {
    event?.preventDefault()
    if (parsing || running) return
    setMessage(null)
    if (!toolsReady) {
      setMessage('桌面运行组件尚未准备好，请使用正式安装包或重新安装。')
      return
    }
    const token = ++parseToken.current
    setParsing(true)
    try {
      let resolved = urls
      let titles: Map<string, string> | undefined
      if (mode === 'profile') {
        if (urls.length !== 1) throw new Error('博主主页模式一次只粘贴一个主页或频道链接。')
        const entries = await invoke<ProfileItem[]>('scan_profile', { request: { url: urls[0], limit: profileLimit } })
        resolved = entries.map((item) => item.url)
        titles = new Map(entries.map((item) => [item.url, item.title]))
      } else {
        if (!urls.length) throw new Error('没有识别到有效链接，可以直接粘贴带中文的完整分享文案。')
        if (mode === 'single') resolved = [urls[0]]
        if (mode === 'batch' && urls.length > 50) throw new Error('多链接批量一次最多处理 50 条。')
      }
      if (token !== parseToken.current) return
      setPendingItems(seedItems(resolved, titles))
      await inspectInChunks(resolved, token)
    } catch (error) {
      setMessage(String(error))
    } finally {
      if (token === parseToken.current) setParsing(false)
    }
  }

  function requestTranscriptMode(next: TranscriptMode) {
    setTranscriptMode(next)
    setIncludeSubtitle(next !== 'none')
    if ((next === 'auto' || next === 'ai') && !installedModel) {
      setModelPrompt({ speech: true, translation: false, resumeDownload: false })
    }
  }

  function requestTranslation(next: 'none' | 'zh') {
    setTranslationTarget(next)
    if (next === 'zh') {
      if (transcriptMode === 'none') {
        setTranscriptMode('auto')
        setIncludeSubtitle(true)
      }
      if (!translationCached || !installedModel) {
        setModelPrompt({ speech: !installedModel, translation: !translationCached, resumeDownload: false })
      }
    }
  }

  function requiredModels(resumeDownload: boolean) {
    const speech = (transcriptMode === 'auto' || transcriptMode === 'ai') && !installedModel
    const translation = translationTarget === 'zh' && !translationCached
    if (speech || translation) {
      setModelPrompt({ speech, translation, resumeDownload })
      return true
    }
    return false
  }

  async function confirmModelSetup() {
    if (!modelPrompt) return
    const prompt = modelPrompt
    try {
      if (prompt.speech && !installedModel) await installModel(modelId)
      if (prompt.translation && !translationCached) await prepareTranslation()
      setModelPrompt(null)
      if (prompt.resumeDownload) await executeSelectedDownloads(true)
    } catch (error) {
      setMessage(String(error))
    }
  }

  function skipModelSetup() {
    if (modelPrompt?.speech) {
      setTranscriptMode('none')
      setIncludeSubtitle(false)
    }
    if (modelPrompt?.translation) setTranslationTarget('none')
    setModelPrompt(null)
    setMessage('已跳过模型下载，仍可正常下载视频、封面和平台文案。')
  }

  async function startSelectedDownloads() {
    if (!selectedItems.length) {
      setMessage('请先解析并勾选至少一条作品。')
      return
    }
    if (!includeVideo) {
      setMessage('当前版本下载任务必须包含视频文件。')
      return
    }
    if (requiredModels(true)) return
    await executeSelectedDownloads()
  }

  async function executeSelectedDownloads(modelsPrepared = false) {
    if (running) return
    setMessage(null)
    const chosen = pendingItems.filter((item) => item.selected)
    if (!chosen.length) return
    const created = chosen.map<DownloadTask>((item) => ({
      id: crypto.randomUUID(),
      url: item.url,
      title: item.title,
      platform: item.platform,
      status: 'queued',
      percent: 0,
      message: '已加入本地下载队列',
    }))
    setTasks((current) => [...created, ...current].slice(0, 200))
    setRunning(true)
    let translationReady: Promise<void> | null = null
    if (translationTarget === 'zh') {
      translationReady = modelsPrepared ? Promise.resolve() : prepareTranslation()
      void translationReady.catch(() => undefined)
    }
    try {
      for (let index = 0; index < created.length; index += 1) {
        const task = created[index]
        const source = chosen[index]
        try {
          const options: DownloadOptions = {
            download_dir: downloadDir,
            quality: source.quality,
            include_thumbnail: includeThumbnail,
            include_description: includeDescription,
            transcript_mode: includeSubtitle ? transcriptMode : 'none',
            language,
            model_id: modelId,
            translation_target: translationTarget === 'zh' ? 'zh' : null,
          }
          const request: DownloadRequest = { job_id: task.id, url: task.url, options }
          const result = await invoke<DownloadResult>('download_item', { request })
          let finalMessage = result.warning || '视频、封面和文案已保存'
          if (translationTarget === 'zh' && result.transcript_available) {
            const sourceLanguage = toTranslationLanguage(result.source_language)
            if (sourceLanguage === 'zh') {
              finalMessage = `${finalMessage}；语音文案已经是中文`
            } else if (!sourceLanguage) {
              finalMessage = `${finalMessage}；未能确定原文语言，中文翻译已跳过`
            } else {
              setTasks((current) => current.map((item) => item.id === task.id
                ? { ...item, title: result.title, platform: result.platform || item.platform, status: 'transcribing', percent: 0, outputDir: result.output_dir, message: '正在翻译为中文' }
                : item))
              try {
                await translationReady
                const translationInput = await invoke<TranslationInput>('translation_input', {
                  request: { output_dir: result.output_dir, source_language: result.source_language },
                })
                const translations = await translateToChinese(
                  translationInput.segments.map((segment) => segment.text),
                  sourceLanguage,
                  runtime!.model_server_url,
                  (percent, detail) => setTasks((current) => current.map((item) => item.id === task.id
                    ? { ...item, status: 'transcribing', percent, message: detail }
                    : item)),
                )
                await invoke('save_translation', {
                  request: { output_dir: result.output_dir, segments: translationInput.segments, translations },
                })
                finalMessage = `${finalMessage}；中文翻译和双语字幕已保存`
              } catch (error) {
                finalMessage = `${finalMessage}；中文翻译失败：${String(error)}`
              }
            }
          }
          setTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, status: 'completed', percent: 100, outputDir: result.output_dir, message: finalMessage }
            : item))
        } catch (error) {
          const detail = String(error)
          const cancelled = detail.toLowerCase().includes('terminated') || detail.includes('已取消')
          setTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, status: cancelled ? 'cancelled' : 'failed', message: detail }
            : item))
        }
      }
    } finally {
      setRunning(false)
    }
  }

  async function cancelTask(task: DownloadTask) {
    try {
      await invoke('cancel_job', { jobId: task.id })
      setTasks((current) => current.map((item) => item.id === task.id
        ? { ...item, status: 'cancelled', message: '用户已取消' }
        : item))
    } catch (error) {
      setMessage(String(error))
    }
  }

  async function login(platform: string) {
    try {
      const result = await invoke<string>('launch_login', { platform })
      setMessage(result)
      setAccountOpen(false)
      window.setTimeout(() => void refreshRuntime(), 2500)
    } catch (error) {
      setMessage(String(error))
    }
  }

  function toggleAll() {
    const shouldSelect = pendingItems.some((item) => !item.selected)
    setPendingItems((current) => current.map((item) => ({ ...item, selected: shouldSelect })))
  }

  return (
    <main className="desktop-shell">
      <header className="app-header">
        <div className="brand"><span><Video size={18} fill="currentColor" /></span><strong>影链工坊</strong></div>
        <form className="quick-paste" onSubmit={parseLinks}>
          <ClipboardPaste size={18} />
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="粘贴链接或分享文案，按 Enter 解析" />
          {input && <button className="clear-input" type="button" onClick={() => setInput('')} aria-label="清空"><X size={16} /></button>}
          <button className="parse-button" type="submit" disabled={parsing || running || !toolsReady} aria-label="解析内容">{parsing ? <LoaderCircle className="spin" size={18} /> : <ChevronRight size={21} />}</button>
        </form>
        <div className="header-actions">
          <button className={`update-button ${updatePrompt ? 'available' : ''}`} type="button" disabled={updateChecking} onClick={() => void checkForUpdates(false)} title="检查更新"><RefreshCw className={updateChecking ? 'spin' : ''} size={17} /><span>{updatePrompt ? `升级 ${updatePrompt.version}` : '更新'}</span>{updatePrompt && <i />}</button>
          <button type="button" onClick={() => setModelsOpen(true)}><Languages size={17} /><span>模型</span></button>
          <button type="button" onClick={() => setAccountOpen(true)} className="account-button"><UserRound size={18} />{runtime?.login_profile_available && <i />}</button>
          <button type="button" onClick={() => setModelsOpen(true)}><Settings2 size={18} /></button>
        </div>
      </header>

      {message && <div className="notice"><AlertCircle size={16} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><X size={15} /></button></div>}

      <div className="app-body">
        <section className="inbox-pane">
          <div className="inbox-toolbar">
            <div><h1>待下载</h1><b>{pendingItems.length}</b></div>
            <div className="list-tools">
              <button type="button" onClick={toggleAll}>{pendingItems.length > 0 && pendingItems.every((item) => item.selected) ? <CheckSquare2 /> : <Square />}全选</button>
              <button type="button" onClick={() => setPendingItems((current) => current.filter((item) => !item.selected))}><Trash2 />移除</button>
              <button type="button" onClick={() => parseLinks()} disabled={parsing || !input}><RefreshCw className={parsing ? 'spin' : ''} />刷新</button>
            </div>
          </div>

          {!pendingItems.length ? (
            <div className="inbox-empty">
              <div className="empty-mark"><Link2 size={28} /></div>
              <h2>粘贴链接，先确认再下载</h2>
              <p>支持带中文的完整分享文案、多个不同博主链接，以及一个博主的公开主页。</p>
              <div className="empty-shortcuts"><span><Search />自动识别链接</span><span><ListChecks />下载前可勾选</span><span><FolderOpen />保存位置自选</span></div>
            </div>
          ) : (
            <div className="media-list">
              {pendingItems.map((item) => (
                <article className={`media-row ${item.selected ? 'selected' : ''}`} key={item.id}>
                  <button className="select-box" type="button" onClick={() => setPendingItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, selected: !entry.selected } : entry))}>{item.selected ? <CheckSquare2 /> : <Square />}</button>
                  <div className="media-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" /> : <Video size={24} />}<span>{formatDuration(item.duration)}</span></div>
                  <div className="media-copy"><strong title={item.title}>{item.title}</strong><span>{item.platform} · {item.uploader}</span>{item.error && <small title={item.error}>预览受限，下载时会再次尝试</small>}</div>
                  <select value={item.quality} aria-label="视频清晰度" onChange={(event) => setPendingItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, quality: event.target.value } : entry))}><option value="best">最佳</option><option value="2160">4K</option><option value="1080">1080P</option><option value="720">720P</option><option value="480">480P</option></select>
                  <div className="media-tags">{includeThumbnail && <span>封面</span>}{includeDescription && <span>文案</span>}{includeSubtitle && <span>字幕</span>}</div>
                  <button className="row-more" type="button" aria-label="更多"><MoreHorizontal /></button>
                  {item.loading && <div className="row-loading"><LoaderCircle className="spin" />读取中</div>}
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="inspector-pane">
          <section className="setting-section mode-section">
            <h2>解析模式</h2>
            <div className="mode-switch">
              <button type="button" className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}><Link2 />单条</button>
              <button type="button" className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}><ListVideo />多链接</button>
              <button type="button" className={mode === 'profile' ? 'active' : ''} onClick={() => setMode('profile')}><UserRound />博主主页</button>
            </div>
            {mode === 'profile' && <label className="profile-count"><span>读取最近作品</span><input type="number" min="1" max="500" value={profileLimit} onChange={(event) => setProfileLimit(Math.min(500, Math.max(1, Number(event.target.value))))} /><small>最多 500 条</small></label>}
          </section>

          <section className="setting-section">
            <h2>输出内容</h2>
            <div className="output-grid">
              <label title="视频为下载任务的核心文件"><input type="checkbox" checked={includeVideo} readOnly aria-disabled="true" /><Video />视频</label>
              <label><input type="checkbox" checked={includeThumbnail} onChange={(event) => setIncludeThumbnail(event.target.checked)} /><Image />封面</label>
              <label><input type="checkbox" checked={includeDescription} onChange={(event) => setIncludeDescription(event.target.checked)} /><FileText />文案</label>
              <label><input type="checkbox" checked={includeSubtitle} onChange={(event) => { const checked = event.target.checked; setIncludeSubtitle(checked); if (!checked) setTranscriptMode('none'); else if (transcriptMode === 'none') requestTranscriptMode('auto') }} /><Subtitles />字幕</label>
            </div>
          </section>

          <section className="setting-section ai-section">
            <div className="section-row"><div><h2>AI 提取文案</h2><p>优先平台字幕，没有时识别语音</p></div><label className="switch"><input type="checkbox" checked={transcriptMode !== 'none'} onChange={(event) => requestTranscriptMode(event.target.checked ? 'auto' : 'none')} /><i /></label></div>
            {transcriptMode !== 'none' && <>
              <label className="select-field"><span>提取方式</span><select value={transcriptMode} onChange={(event) => requestTranscriptMode(event.target.value as TranscriptMode)}><option value="auto">字幕优先，AI 兜底</option><option value="ai">始终 AI 识别语音</option><option value="native">仅平台字幕</option></select></label>
              <label className="select-field"><span>来源语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英语</option><option value="id">印尼语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="es">西班牙语</option></select></label>
            </>}
            <label className="select-field"><span>翻译为</span><select value={translationTarget} onChange={(event) => requestTranslation(event.target.value as 'none' | 'zh')}><option value="none">不翻译</option><option value="zh">中文（原文 + 中文 + 双语字幕）</option></select></label>
          </section>

          <section className="setting-section save-section">
            <h2>保存位置</h2>
            <button className="folder-field" type="button" onClick={chooseDirectory}><span title={downloadDir}>{downloadDir || '正在读取下载目录'}</span><FolderOpen /></button>
            <div className="space-row"><span>已选 {selectedItems.length} 项</span><b>{estimatedSize ? `约 ${formatBytes(estimatedSize)}` : '大小下载时确认'}</b></div>
          </section>

          <button className="download-selected" type="button" onClick={startSelectedDownloads} disabled={running || parsing || !selectedItems.length || !toolsReady}>
            {running ? <LoaderCircle className="spin" /> : <Download />}
            {running ? `正在下载 ${Math.min(completedCount + 1, tasks.length)} / ${tasks.length}` : `下载已选 ${selectedItems.length} 项`}
            <ChevronDown />
          </button>
        </aside>
      </div>

      <footer className="activity-bar">
        <div className="activity-label"><History /><strong>{activeTask ? '下载中 1 项' : tasks.length ? `已完成 ${completedCount} 项` : '暂无下载任务'}</strong></div>
        {activeTask ? <>
          <div className="activity-title"><Video /><span>{activeTask.title}</span><em>{activeTask.platform}</em></div>
          <b>{Math.round(activeTask.percent)}%</b>
          <div className="activity-progress"><i style={{ width: `${activeTask.percent}%` }} /></div>
          <span className="activity-message">{activeTask.message}</span>
          <button type="button" onClick={() => cancelTask(activeTask)}><CircleStop />取消</button>
        </> : <span className="activity-hint">粘贴链接后先检查内容，再开始下载</span>}
      </footer>

      {modelPrompt && (
        <div className="modal-backdrop">
          <section className="modal first-model-modal">
            <div className="model-prompt-mark"><WandSparkles /></div>
            <h2>首次使用需要下载模型</h2>
            <p>模型只下载一次，并保存在你选择的本地位置。没有得到确认前，影链工坊不会自动下载。</p>
            <div className="prompt-models">
              {modelPrompt.speech && <div><span><PackageOpen /><strong>{selectedModel?.name || '语音识别模型'}</strong></span><b>{formatBytes(selectedModel?.size_bytes)}</b><small>用于英语、印尼语等多语言语音文案提取</small></div>}
              {modelPrompt.translation && <div><span><Languages /><strong>多语言 → 简体中文</strong></span><b>{formatBytes(runtime?.translation_model_size_bytes || 646109073)}</b><small>用于生成中文翻译和双语字幕</small></div>}
            </div>
            <button className="model-folder" type="button" onClick={chooseModelDirectory}><FolderOpen /><span>{runtime?.model_dir || '正在读取模型位置'}</span><em>更改位置</em></button>
            {(modelBusy || translationBusy) && <div className="model-confirm-progress"><div><span>{modelProgress?.message || translationProgress.message}</span><b>{Math.round(modelProgress?.percent || translationProgress.percent)}%</b></div><div><i style={{ width: `${modelProgress?.percent || translationProgress.percent}%` }} /></div></div>}
            <div className="modal-actions"><button type="button" onClick={skipModelSetup} disabled={modelBusy || translationBusy}>暂不使用 AI</button><button className="confirm" type="button" onClick={confirmModelSetup} disabled={modelBusy || translationBusy}>{modelBusy || translationBusy ? <LoaderCircle className="spin" /> : <Download />}下载并继续</button></div>
          </section>
        </div>
      )}

      {updateOpen && updatePrompt && (
        <div className="modal-backdrop" onMouseDown={() => !updateInstalling && setUpdateOpen(false)}>
          <section className="modal update-modal" onMouseDown={(event) => event.stopPropagation()}>
            {!updateInstalling && <button className="modal-close" type="button" onClick={() => setUpdateOpen(false)}><X /></button>}
            <div className="update-mark"><ShieldCheck /></div>
            <h2>发现新版本 {updatePrompt.version}</h2>
            <p>当前版本 {updatePrompt.currentVersion}。更新包会先完成官方签名校验，再自动安装并重启。</p>
            <div className="update-notes"><strong>本次更新</strong><p>{updatePrompt.body}</p></div>
            {updateInstalling && <div className="update-progress"><div><span>{updateProgress.percent >= 100 ? '正在安装并准备重启' : '正在安全下载更新'}</span><b>{updateProgress.total ? `${Math.round(updateProgress.percent)}%` : '请稍候'}</b></div><div><i style={{ width: `${updateProgress.percent}%` }} /></div>{updateProgress.total > 0 && <small>{formatBytes(updateProgress.downloaded)} / {formatBytes(updateProgress.total)}</small>}</div>}
            {updateError && <div className="update-error"><AlertCircle />{updateError}</div>}
            <div className="modal-actions"><button type="button" onClick={() => setUpdateOpen(false)} disabled={updateInstalling}>稍后更新</button><button className="confirm" type="button" onClick={installAvailableUpdate} disabled={updateInstalling}>{updateInstalling ? <LoaderCircle className="spin" /> : <Download />} {updateInstalling ? '升级中' : updateError ? '重新升级' : '立即升级'}</button></div>
          </section>
        </div>
      )}

      {accountOpen && (
        <div className="modal-backdrop" onMouseDown={() => setAccountOpen(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setAccountOpen(false)}><X /></button><LogIn className="modal-mark" /><h2>平台官方登录</h2><p>公开内容默认免登录。遇到平台限制时，在官方窗口登录一次，会话只保存在本机。</p><div className="platform-grid">{LOGIN_PLATFORMS.map(([id, label]) => <button type="button" key={id} onClick={() => login(id)}><span>{label}</span><ChevronRight size={16} /></button>)}</div></section>
        </div>
      )}

      {modelsOpen && (
        <div className="modal-backdrop" onMouseDown={() => !modelBusy && !translationBusy && setModelsOpen(false)}>
          <section className="modal model-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => !modelBusy && !translationBusy && setModelsOpen(false)}><X /></button><Languages className="modal-mark" /><h2>本地模型</h2><p>模型按需下载，不增加主安装包体积。首次使用时会先征得用户确认。</p>
            <button className="model-folder" type="button" disabled={modelBusy || translationBusy} onClick={chooseModelDirectory}><FolderOpen /><span>{runtime?.model_dir || '正在读取模型目录'}</span><em>选择位置</em></button>
            {modelProgress && <div className="model-confirm-progress"><div><span>{modelProgress.message}</span><b>{Math.round(modelProgress.percent)}%</b></div><div><i style={{ width: `${modelProgress.percent}%` }} /></div><small>{formatBytes(modelProgress.downloaded)} / {formatBytes(modelProgress.total)}</small><button type="button" onClick={() => invoke('cancel_model_download')}>取消下载</button></div>}
            {translationBusy && <div className="model-confirm-progress"><div><span>{translationProgress.message || '正在准备中文翻译模型'}</span><b>{Math.round(translationProgress.percent)}%</b></div><div><i style={{ width: `${translationProgress.percent}%` }} /></div></div>}
            <div className="model-list">{runtime?.models.map((model) => <article key={model.id}><div><strong>{model.name}</strong><span>{formatBytes(model.size_bytes)}{model.recommended ? ' · 推荐' : ''}</span></div>{model.installed ? <button type="button" className="danger" disabled={modelBusy} onClick={() => removeModel(model.id)}><Trash2 />删除</button> : <button type="button" disabled={modelBusy} onClick={() => installModel(model.id)}><Download />下载</button>}</article>)}</div>
            <div className="model-list translation-model"><article><div><strong>多语言 → 简体中文</strong><span>{formatBytes(runtime?.translation_model_size_bytes || 646109073)} · 生成中文和双语字幕</span></div>{translationCached ? <button type="button" className="danger" disabled={translationBusy} onClick={removeTranslationModel}><Trash2 />删除</button> : <button type="button" disabled={translationBusy} onClick={prepareTranslation}><Download />下载</button>}</article></div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
