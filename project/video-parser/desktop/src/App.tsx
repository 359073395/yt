import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { check, type Update } from '@tauri-apps/plugin-updater'
import {
  AlertCircle,
  Check,
  CheckSquare2,
  CircleStop,
  Cloud,
  Download,
  FileText,
  FolderOpen,
  Image,
  KeyRound,
  Languages,
  Link2,
  ListChecks,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Save,
  Server,
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
  type MediaPreview,
  type ModelProgress,
  type ProfileItem,
  type ProgressEvent,
  type RuntimeInfo,
  type AiTranslationSettings,
  type TranscriptMode,
  type TranslationProvider,
  extractSharedUrls,
  platformName,
} from './core'
import { clearTranslationModel, preloadTranslationModel } from './translator'
import { finishTranslation } from './translation-job'

interface PendingItem extends MediaPreview {
  id: string
  selected: boolean
  quality: string
  loading: boolean
  downloaded?: boolean
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

interface AiSettingsDraft {
  baseUrl: string
  model: string
  apiKey: string
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

function languageName(value?: string) {
  return {
    zh: '中文',
    en: '英语',
    id: '印尼语',
    ja: '日语',
    ko: '韩语',
    es: '西班牙语',
  }[value || ''] || '语言'
}

function progressSpeed(message: string) {
  return message.match(/\s([\d.]+(?:Ki|Mi|Gi)?B\/s)\s/i)?.[1] || ''
}

function App() {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [input, setInput] = React.useState('')
  const [downloadDir, setDownloadDir] = React.useState('')
  const [quality, setQuality] = React.useState('1080')
  const [transcriptMode, setTranscriptMode] = React.useState<TranscriptMode>(() => {
    const saved = window.localStorage.getItem('yinglian-transcript-mode')
    return saved === 'auto' || saved === 'ai' || saved === 'native' ? saved : 'auto'
  })
  const [language, setLanguage] = React.useState('auto')
  const [modelId, setModelId] = React.useState('small')
  const [includeVideo, setIncludeVideo] = React.useState(true)
  const [includeThumbnail, setIncludeThumbnail] = React.useState(true)
  const [includeSubtitle, setIncludeSubtitle] = React.useState(true)
  const [pendingItems, setPendingItems] = React.useState<PendingItem[]>([])
  const [tasks, setTasks] = React.useState<DownloadTask[]>([])
  const [running, setRunning] = React.useState(false)
  const [downloadStarting, setDownloadStarting] = React.useState(false)
  const [parsing, setParsing] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [modelsOpen, setModelsOpen] = React.useState(false)
  const [modelPrompt, setModelPrompt] = React.useState<ModelPromptState | null>(null)
  const [modelProgress, setModelProgress] = React.useState<ModelProgress | null>(null)
  const [modelBusy, setModelBusy] = React.useState(false)
  const [translationTarget, setTranslationTarget] = React.useState<'none' | 'zh'>(() => window.localStorage.getItem('yinglian-translation-target') === 'none' ? 'none' : 'zh')
  const includeCopy = translationTarget === 'zh'
  const [translationProvider, setTranslationProvider] = React.useState<TranslationProvider>(() => window.localStorage.getItem('yinglian-translation-provider') === 'api' ? 'api' : 'local')
  const [settingsProvider, setSettingsProvider] = React.useState<TranslationProvider>('local')
  const [aiSettings, setAiSettings] = React.useState<AiTranslationSettings>({ base_url: '', model: '', api_key_saved: false })
  const [aiDraft, setAiDraft] = React.useState<AiSettingsDraft>({ baseUrl: '', model: '', apiKey: '' })
  const [aiSettingsBusy, setAiSettingsBusy] = React.useState(false)
  const [aiSettingsStatus, setAiSettingsStatus] = React.useState<string | null>(null)
  const [availableAiModels, setAvailableAiModels] = React.useState<string[]>([])
  const [aiModelManual, setAiModelManual] = React.useState(true)
  const [aiModelsBusy, setAiModelsBusy] = React.useState(false)
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
    setModelId((current) => {
      const saved = window.localStorage.getItem('yinglian-model')
      const selected = [saved, current, info.selected_model]
        .find((candidate) => candidate && info.models.some((model) => model.id === candidate && model.installed))
        || info.selected_model
      if (info.models.some((model) => model.id === selected && model.installed)) {
        window.localStorage.setItem('yinglian-model', selected)
      }
      return selected
    })
    setTranslationCached(info.translation_model_installed)
  }, [])

  const refreshAiSettings = React.useCallback(async () => {
    const settings = await invoke<AiTranslationSettings>('get_ai_settings')
    setAiSettings(settings)
    setAiDraft((current) => ({ ...current, baseUrl: settings.base_url, model: settings.model }))
  }, [])

  React.useEffect(() => {
    refreshRuntime().catch((error) => setMessage(String(error)))
    refreshAiSettings().catch((error) => setMessage(String(error)))
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
  }, [refreshAiSettings, refreshRuntime])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdates(true), 4000)
    return () => window.clearTimeout(timer)
  }, [])

  const urls = React.useMemo(() => extractSharedUrls(input), [input])
  const selectedItems = React.useMemo(() => pendingItems.filter((item) => item.selected), [pendingItems])
  const selectedModel = runtime?.models.find((model) => model.id === modelId)
  const installedModel = selectedModel?.installed ?? false
  const toolsReady = Boolean(runtime?.yt_dlp_available && runtime?.ffmpeg_available)
  const queueTasks = selectedItems.map((item) => tasks.find((task) => task.queueItemId === item.id)).filter(Boolean) as DownloadTask[]
  const completedCount = queueTasks.filter((task) => task.status === 'completed').length
  const activeTask = tasks.find((task) => ['queued', 'scanning', 'downloading', 'transcribing'].includes(task.status))
  const estimatedSize = selectedItems.reduce((total, item) => total + (item.size_bytes || 0), 0)
  const selectedOutputCount = [includeVideo, includeThumbnail, includeCopy, includeSubtitle].filter(Boolean).length
  const aiConfigured = Boolean(aiSettings.base_url && aiSettings.model)

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

  function openModels() {
    setAiDraft({ baseUrl: aiSettings.base_url, model: aiSettings.model, apiKey: '' })
    setSettingsProvider(translationProvider)
    setAiSettingsStatus(null)
    setAvailableAiModels([])
    setModelsOpen(true)
  }

  function chooseTranslationProvider(next: TranslationProvider) {
    setSettingsProvider(next)
    setAiSettingsStatus(null)
  }

  async function saveAiTranslationSettings(testConnection = false) {
    if (settingsProvider !== 'api') {
      setTranslationProvider('local')
      window.localStorage.setItem('yinglian-translation-provider', 'local')
      setAiSettingsStatus('已切换为本地翻译模型。')
      setMessage('中文翻译将使用本地模型。')
      return
    }
    setAiSettingsBusy(true)
    setAiSettingsStatus(testConnection ? '正在保存并测试连接…' : '正在保存设置…')
    try {
      const saved = await invoke<AiTranslationSettings>('save_ai_settings', {
        request: {
          base_url: aiDraft.baseUrl,
          model: aiDraft.model,
          api_key: aiDraft.apiKey,
          clear_api_key: false,
        },
      })
      setAiSettings(saved)
      setAiDraft((current) => ({ ...current, apiKey: '' }))
      if (testConnection) {
        const result = await invoke<string>('test_ai_translation')
        setAiSettingsStatus(result)
      } else {
        setAiSettingsStatus('AI 接口设置已安全保存。')
        setMessage('设置已保存，中文翻译将使用 AI 接口。')
      }
      setTranslationProvider('api')
      window.localStorage.setItem('yinglian-translation-provider', 'api')
    } catch (error) {
      setAiSettingsStatus(String(error))
    } finally {
      setAiSettingsBusy(false)
    }
  }

  async function clearSavedAiKey() {
    setAiSettingsBusy(true)
    setAiSettingsStatus('正在清除已保存的 API Key…')
    try {
      const saved = await invoke<AiTranslationSettings>('save_ai_settings', {
        request: {
          base_url: aiDraft.baseUrl,
          model: aiDraft.model,
          api_key: '',
          clear_api_key: true,
        },
      })
      setAiSettings(saved)
      setAiSettingsStatus('已清除 API Key。')
    } catch (error) {
      setAiSettingsStatus(String(error))
    } finally {
      setAiSettingsBusy(false)
    }
  }

  async function loadAiModels() {
    if (!aiDraft.baseUrl.trim()) {
      setAiSettingsStatus('请先填写 AI 接口 URL。')
      return
    }
    setAiModelsBusy(true)
    setAiSettingsStatus('正在从上游读取模型列表…')
    try {
      const models = await invoke<string[]>('list_ai_models', {
        request: { base_url: aiDraft.baseUrl, api_key: aiDraft.apiKey },
      })
      setAvailableAiModels(models)
      setAiDraft((current) => ({ ...current, model: models.includes(current.model) ? current.model : models[0] }))
      setAiModelManual(false)
      setAiSettingsStatus(`已获取 ${models.length} 个上游模型，可以直接选择。`)
    } catch (error) {
      setAvailableAiModels([])
      setAiModelManual(true)
      setAiSettingsStatus(`${String(error)}；仍可手动填写模型名称。`)
    } finally {
      setAiModelsBusy(false)
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
      window.localStorage.setItem('yinglian-model', selected)
      setModelId(selected)
      await refreshRuntime()
      const name = runtime?.models.find((model) => model.id === selected)?.name || '多语言语音模型'
      setMessage(`${name}已下载并设为当前模型。`)
    } finally {
      setModelBusy(false)
      setModelProgress(null)
    }
  }

  async function removeModel(selected: string) {
    await invoke('delete_model', { modelId: selected })
    if (window.localStorage.getItem('yinglian-model') === selected) {
      window.localStorage.removeItem('yinglian-model')
    }
    await refreshRuntime()
  }

  function selectModel(selected: string) {
    const model = runtime?.models.find((item) => item.id === selected)
    if (!model?.installed) return
    window.localStorage.setItem('yinglian-model', selected)
    setModelId(selected)
    setMessage(`已选用 ${model.name}，后续 AI 语音识别将使用此模型。`)
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
        return preview && !item.downloaded ? { ...item, ...preview, loading: false } : item
      }))
    }
  }

  async function parseLinks(event?: React.FormEvent, profile = false) {
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
      if (profile) {
        if (urls.length !== 1) throw new Error('博主主页模式一次只粘贴一个主页或频道链接。')
        const entries = await invoke<ProfileItem[]>('scan_profile', { request: { url: urls[0], limit: 500 } })
        resolved = entries.map((item) => item.url)
        titles = new Map(entries.map((item) => [item.url, item.title]))
      } else {
        if (!urls.length) throw new Error('没有识别到有效链接，可以直接粘贴带中文的完整分享文案。')
        if (urls.length > 50) throw new Error('多链接批量一次最多处理 50 条。')
      }
      if (token !== parseToken.current) return
      setPendingItems((current) => {
        const existing = new Set(current.map((item) => item.url))
        const added = seedItems(resolved.filter((url) => !existing.has(url)), titles)
        return [...current, ...added.map((item) => profile ? { ...item, loading: false } : item)]
      })
      setInput('')
      if (!profile) {
        void inspectInChunks(resolved, token).catch(() => {
          setPendingItems((current) => current.map((item) => ({ ...item, loading: false })))
        })
      }
    } catch (error) {
      setMessage(String(error))
    } finally {
      if (token === parseToken.current) setParsing(false)
    }
  }

  function requestTranscriptMode(next: TranscriptMode) {
    window.localStorage.setItem('yinglian-transcript-mode', next)
    setTranscriptMode(next)
    if (next === 'none') requestTranslation('none')
    if (includeCopy && (next === 'auto' || next === 'ai') && !installedModel) {
      setModelPrompt({ speech: true, translation: false, resumeDownload: false })
    }
  }

  function requestTranslation(next: 'none' | 'zh') {
    window.localStorage.setItem('yinglian-translation-target', next)
    setTranslationTarget(next)
    if (next === 'zh') {
      if (transcriptMode === 'none') {
        window.localStorage.setItem('yinglian-transcript-mode', 'auto')
        setTranscriptMode('auto')
      }
      if (translationProvider === 'api' && !aiConfigured) {
        openModels()
        setAiSettingsStatus('请先填写 AI 接口 URL 和模型名称。')
      } else if ((translationProvider === 'local' && !translationCached) || !installedModel) {
        setModelPrompt({ speech: !installedModel, translation: translationProvider === 'local' && !translationCached, resumeDownload: false })
      }
    }
  }

  function requiredModels(resumeDownload: boolean) {
    const speech = includeCopy && (transcriptMode === 'auto' || transcriptMode === 'ai') && !installedModel
    if (translationTarget === 'zh' && translationProvider === 'api' && !aiConfigured) {
      openModels()
      setAiSettingsStatus('请先完成 AI 接口设置，再开始翻译。')
      return true
    }
    const translation = translationTarget === 'zh' && translationProvider === 'local' && !translationCached
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
      window.localStorage.setItem('yinglian-transcript-mode', 'none')
      setTranscriptMode('none')
      requestTranslation('none')
    }
    if (modelPrompt?.translation) {
      window.localStorage.setItem('yinglian-translation-target', 'none')
      setTranslationTarget('none')
    }
    setModelPrompt(null)
    setMessage('已跳过模型下载，仍可下载视频、封面和平台提供的原版字幕。')
  }

  async function startSelectedDownloads() {
    if (downloadStarting || running) return
    if (!selectedItems.length) {
      setMessage('请先解析并勾选至少一条作品。')
      return
    }
    if (!selectedOutputCount) {
      setMessage('请至少选择一种下载内容。')
      return
    }
    setDownloadStarting(true)
    setMessage('正在创建本地下载任务…')
    try {
      if (requiredModels(true)) {
        setMessage(translationProvider === 'api' && !aiConfigured
          ? '请先完成 AI 接口设置，保存后即可继续。'
          : '请先确认所需模型，确认后会自动继续下载。')
        return
      }
      await executeSelectedDownloads()
    } catch (error) {
      setMessage(`无法启动下载：${String(error)}`)
    } finally {
      setDownloadStarting(false)
    }
  }

  async function executeSelectedDownloads(modelsPrepared = false) {
    if (running) return
    setMessage(null)
    const chosen = pendingItems.filter((item) => item.selected)
    if (!chosen.length) return
    const created = chosen.map<DownloadTask>((item) => ({
      id: crypto.randomUUID(),
      queueItemId: item.id,
      url: item.url,
      title: item.title,
      platform: item.platform,
      status: 'queued',
      percent: 0,
      message: '已加入本地下载队列',
    }))
    const chosenUrls = new Set(chosen.map((item) => item.url))
    setTasks((current) => [...created, ...current.filter((task) => !chosenUrls.has(task.url))].slice(0, 200))
    setRunning(true)
    let translationReady: Promise<void> | null = null
    if (translationTarget === 'zh' && translationProvider === 'local') {
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
            include_video: includeVideo,
            include_thumbnail: includeThumbnail,
            include_original_subtitle: includeSubtitle,
            transcript_mode: includeCopy ? transcriptMode : 'none',
            language,
            model_id: modelId,
          }
          const request: DownloadRequest = { job_id: task.id, url: task.url, options }
          const result = await invoke<DownloadResult>('download_item', { request })
          setPendingItems((current) => current.map((item) => item.id === source.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, thumbnail: result.thumbnail || item.thumbnail, uploader: result.uploader || item.uploader, duration: result.duration ?? item.duration, downloaded: true, loading: false, error: null }
            : item))
          const outcome = await finishTranslation(result, {
            target: translationTarget, provider: translationProvider,
            modelBaseUrl: runtime!.model_server_url, ready: translationReady,
          }, (percent, detail) => setTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, status: 'transcribing', percent, outputDir: result.output_dir, sourceLanguage: result.source_language, message: detail }
            : item)))
          setTasks((current) => current.map((item) => item.id === task.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, ...outcome, percent: 100, outputDir: result.output_dir, sourceLanguage: result.source_language }
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

  async function openTaskFolder(task: DownloadTask) {
    if (!task.outputDir) return
    try {
      await invoke('open_directory', { path: task.outputDir })
    } catch (error) {
      setMessage(`无法打开“${task.title}”的文件夹：${String(error)}`)
    }
  }

  function toggleAll() {
    const shouldSelect = pendingItems.some((item) => !item.selected)
    setPendingItems((current) => current.map((item) => ({ ...item, selected: shouldSelect })))
  }

  function setBatchQuality(next: string) {
    setQuality(next)
    setPendingItems((current) => current.map((item) => item.selected ? { ...item, quality: next } : item))
  }

  function removeSelectedQueueItems() {
    const removedUrls = new Set(pendingItems.filter((item) => item.selected).map((item) => item.url))
    setPendingItems((current) => current.filter((item) => !item.selected))
    setTasks((current) => current.filter((task) => !removedUrls.has(task.url)))
  }

  function clearQueue() {
    const removedUrls = new Set(pendingItems.map((item) => item.url))
    setPendingItems([])
    setTasks((current) => current.filter((task) => !removedUrls.has(task.url)))
  }

  function chooseModelFromPanel(selected: string) {
    const model = runtime?.models.find((item) => item.id === selected)
    if (!model) return
    setModelId(selected)
    if (model.installed) {
      selectModel(selected)
    } else {
      setModelPrompt({ speech: true, translation: false, resumeDownload: false })
    }
  }

  return (
    <main className="desktop-shell">
      <header className="app-header">
        <div className="brand"><span><Link2 size={19} /></span><strong>影链工坊</strong></div>
        <div className="header-actions">
          <button className={`update-button ${updatePrompt ? 'available' : ''}`} type="button" disabled={updateChecking} onClick={() => void checkForUpdates(false)} title="检查更新"><RefreshCw className={updateChecking ? 'spin' : ''} size={17} /><span>{updatePrompt ? `升级 ${updatePrompt.version}` : '更新'}</span>{updatePrompt && <i />}</button>
          <button type="button" onClick={openModels}><Languages size={17} /><span>模型</span></button>
        </div>
      </header>

      {message && <div className="notice"><AlertCircle size={16} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><X size={15} /></button></div>}

      <div className="app-body">
        <section className="inbox-pane">
          <form className="link-composer" onSubmit={parseLinks}>
            <div className="composer-heading"><div><h1>视频链接</h1><span>支持分享文案自动识别</span></div>{urls.length > 0 && <b>已识别 {urls.length} 条</b>}</div>
            <div className="composer-field">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void parseLinks()
                }}
                placeholder={'粘贴一个或多个视频链接 / 分享文案，每行一条'}
              />
              {input && <button type="button" onClick={() => setInput('')} aria-label="清空链接"><X /></button>}
            </div>
            <div className="composer-actions">
              <button className="primary-action" type="submit" disabled={parsing || running || !toolsReady || !urls.length}>{parsing ? <LoaderCircle className="spin" /> : <ListChecks />}解析并加入队列</button>
              <button type="button" disabled={parsing || running || !toolsReady || urls.length !== 1} onClick={() => void parseLinks(undefined, true)}><UserRound />添加博主主页</button>
              <span>多链接最多 50 条 · 博主主页读取公开作品</span>
            </div>
          </form>

          <section className="queue-section">
            <div className="queue-toolbar">
              <div><h2>待下载队列</h2><b>{pendingItems.length}</b></div>
              <div className="queue-actions">
                <label><span>批量画质</span><select value={quality} onChange={(event) => setBatchQuality(event.target.value)}><option value="best">最佳</option><option value="2160">4K</option><option value="1080">1080P</option><option value="720">720P</option><option value="480">480P</option></select></label>
                <button type="button" disabled={!selectedItems.length || running} onClick={removeSelectedQueueItems}><Trash2 />移除</button>
                <button type="button" disabled={!pendingItems.length || running} onClick={clearQueue}><X />清空</button>
                <button className="start-download" type="button" onClick={() => void startSelectedDownloads()} disabled={downloadStarting || running || parsing || !selectedItems.length || !toolsReady || !selectedOutputCount}>{downloadStarting || running ? <LoaderCircle className="spin" /> : <Download />} {running ? `下载中 ${Math.min(completedCount + 1, selectedItems.length)} / ${selectedItems.length}` : `开始下载 ${selectedItems.length} 项`}</button>
              </div>
            </div>

            <div className="queue-table">
              <div className="queue-head"><button type="button" onClick={toggleAll} aria-label="全选">{pendingItems.length > 0 && pendingItems.every((item) => item.selected) ? <CheckSquare2 /> : <Square />}</button><span>标题 / 平台 / 博主</span><span>画质</span><span>输出内容</span><span>状态</span></div>
              {!pendingItems.length ? (
                <div className="queue-empty"><Link2 /><strong>还没有待下载视频</strong><span>把链接或分享文案粘贴到上方，解析后会在这里逐条确认。</span></div>
              ) : pendingItems.map((item) => {
                const task = tasks.find((entry) => entry.queueItemId === item.id)
                const speed = task ? progressSpeed(task.message) : ''
                return (
                  <article className={`media-row ${item.selected ? 'selected' : ''}`} data-url={item.url} key={item.id}>
                    <button className="select-box" type="button" onClick={() => setPendingItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, selected: !entry.selected } : entry))}>{item.selected ? <CheckSquare2 /> : <Square />}</button>
                    <div className="media-summary"><div className="media-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" onError={() => setPendingItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, thumbnail: null } : entry))} /> : <Video />}<span>{formatDuration(item.duration)}</span></div><div className="media-copy"><strong title={item.title}>{item.title}</strong><span>{item.platform} · {item.uploader}</span>{item.error && <small title={item.error}>预览受限，下载时会再次尝试</small>}</div></div>
                    <select value={item.quality} aria-label={`${item.title} 视频清晰度`} onChange={(event) => setPendingItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, quality: event.target.value } : entry))}><option value="best">最佳</option><option value="2160">4K</option><option value="1080">1080P</option><option value="720">720P</option><option value="480">480P</option></select>
                    <div className="media-tags">{includeVideo && <span><Video />视频</span>}{includeThumbnail && <span><Image />封面</span>}{includeCopy && <span><FileText />双语文案</span>}{includeSubtitle && <span><Subtitles />原版字幕</span>}</div>
                    <div className={`row-status ${task?.status || 'waiting'}`} title={task?.message}>{!task ? <><span>等待中</span></> : task.status === 'completed' ? <><strong><Check />已完成</strong></> : task.status === 'partial' ? <strong><AlertCircle />未全部完成</strong> : task.status === 'failed' ? <strong><AlertCircle />失败</strong> : task.status === 'cancelled' ? <><span>已取消</span></> : <><strong>{task.status === 'transcribing' ? (task.message.includes('翻译') ? '翻译中' : '提取文案') : task.status === 'queued' ? '排队中' : `下载中 ${Math.round(task.percent)}%`}</strong>{speed && <small>{speed}</small>}</>}{task?.outputDir && (task.status === 'completed' || task.status === 'partial') && <button className="open-task-folder" type="button" aria-label={`打开 ${task.title} 的文件夹`} title={task.outputDir} onClick={() => void openTaskFolder(task)}><FolderOpen />打开文件夹</button>}</div>
                    {task && (task.status === 'partial' || task.status === 'failed') && <p className="row-issue" role="status">{task.message}</p>}
                    {item.loading && <div className="row-loading"><LoaderCircle className="spin" />读取中</div>}
                  </article>
                )
              })}
            </div>
            <p className="platform-note">支持 YouTube、TikTok、Instagram、抖音等主流平台的公开视频链接</p>
          </section>
        </section>

        <aside className="inspector-pane">
          {activeTask && <section className="active-progress" aria-live="polite">
            <div className="progress-heading"><h2>任务进度</h2><b>{Math.min(completedCount + 1, selectedItems.length)} / {selectedItems.length}</b></div>
            {activeTask.status === 'transcribing' ? <>
              <div className="progress-title"><h3>AI 文案与翻译</h3><strong>进行中</strong></div>
              <div className="ai-steps">
                <div className="done"><i><Check /></i><span>提取音轨</span></div>
                <div className={activeTask.sourceLanguage ? 'done' : 'active'}><i>{activeTask.sourceLanguage ? <Check /> : '2'}</i><span>{activeTask.sourceLanguage ? `识别${languageName(activeTask.sourceLanguage)}` : '识别语言'}</span></div>
                {translationTarget === 'zh' && <div className={activeTask.sourceLanguage ? 'active' : ''}><i>3</i><span>翻译中文</span></div>}
              </div>
              <div className="detail-progress"><div><i style={{ width: `${Math.max(3, activeTask.percent)}%` }} /></div><b>{Math.round(activeTask.percent)}%</b></div>
              <p className="progress-message">{activeTask.message}</p>
            </> : <>
              <div className="progress-title"><h3>原视频下载</h3><strong>进行中</strong></div>
              <div className="detail-progress"><div><i style={{ width: `${Math.max(3, activeTask.percent)}%` }} /></div><b>{Math.round(activeTask.percent)}%</b></div>
              <div className="progress-meta"><span>{activeTask.message}</span>{progressSpeed(activeTask.message) && <b>速度 {progressSpeed(activeTask.message)}</b>}</div>
            </>}
            <button className="cancel-active" type="button" onClick={() => void cancelTask(activeTask)}><CircleStop />取消当前任务</button>
          </section>}

          <section className="setting-section">
            <h2>下载内容</h2>
            <div className="output-grid">
              <label><input type="checkbox" checked={includeVideo} onChange={(event) => setIncludeVideo(event.target.checked)} /><Video />视频</label>
              <label><input type="checkbox" checked={includeThumbnail} onChange={(event) => setIncludeThumbnail(event.target.checked)} /><Image />封面</label>
              <label><input type="checkbox" checked={includeCopy} onChange={(event) => requestTranslation(event.target.checked ? 'zh' : 'none')} /><FileText />双语文案</label>
              <label title="仅保存平台提供的原文字幕，没有则跳过"><input type="checkbox" checked={includeSubtitle} onChange={(event) => setIncludeSubtitle(event.target.checked)} /><Subtitles />原版字幕</label>
            </div>
            <p className="output-note">原版字幕有则保存；不额外生成中文或双语字幕文件。</p>
          </section>

          <section className="setting-section ai-section">
            <div className="section-row"><div><h2>识别模型</h2><p>已安装模型可以随时切换</p></div><button className="manage-models" type="button" onClick={openModels}>管理模型</button></div>
            <div className="model-cards">{runtime?.models.map((model) => <button type="button" className={model.id === modelId ? 'selected' : ''} aria-pressed={model.id === modelId} key={model.id} onClick={() => chooseModelFromPanel(model.id)}><div className="model-card-heading"><i aria-hidden="true">{model.id === modelId && <Check />}</i><strong>{model.name.split(' · ')[0]}</strong></div><span>{model.name.split(' · ')[1]}</span><span className={model.installed ? 'installed' : ''}>{model.installed ? '已安装' : '未下载'}</span></button>)}</div>
            <div className="ai-options-grid">
              <label className="select-field"><span>提取方式</span><select value={transcriptMode} onChange={(event) => requestTranscriptMode(event.target.value as TranscriptMode)}><option value="none">不提取语音文案</option><option value="auto">字幕优先，AI 兜底</option><option value="ai">始终 AI 识别语音</option><option value="native">仅平台字幕</option></select></label>
              <label className="select-field"><span>来源语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英语</option><option value="id">印尼语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="es">西班牙语</option></select></label>
              <label className="select-field full-field"><span>文案输出 · {translationProvider === 'api' ? 'AI 接口' : '本地模型'}</span><select value={translationTarget} onChange={(event) => requestTranslation(event.target.value as 'none' | 'zh')}><option value="none">不生成双语文案</option><option value="zh">原文 + 中文（合并为一份双语文案）</option></select><small>翻译方式可在顶部“模型”中切换</small></label>
            </div>
          </section>

          <section className="setting-section save-section">
            <h2>保存位置</h2>
            <button className="folder-field" type="button" onClick={chooseDirectory}><span title={downloadDir}>{downloadDir || '正在读取下载目录'}</span><FolderOpen /><em>更改</em></button>
            <div className="space-row"><span>每条视频独立保存，完成后可从队列打开文件夹</span><b>{estimatedSize ? `约 ${formatBytes(estimatedSize)}` : ''}</b></div>
          </section>
        </aside>
      </div>

      {modelPrompt && (
        <div className="modal-backdrop">
          <section className="modal first-model-modal">
            <div className="model-prompt-mark"><WandSparkles /></div>
            <h2>首次使用需要下载模型</h2>
            <p>模型只下载一次，并保存在你选择的本地位置。没有得到确认前，影链工坊不会自动下载。</p>
            <div className="prompt-models">
              {modelPrompt.speech && <div><span><PackageOpen /><strong>{selectedModel?.name || '语音识别模型'}</strong></span><b>{formatBytes(selectedModel?.size_bytes)}</b><small>用于英语、印尼语等多语言语音文案提取</small></div>}
              {modelPrompt.translation && <div><span><Languages /><strong>多语言 → 简体中文</strong></span><b>{formatBytes(runtime?.translation_model_size_bytes || 646109073)}</b><small>用于生成原文与中文对照的双语文案</small></div>}
            </div>
            <button className="model-folder path-readable" type="button" onClick={chooseModelDirectory}><FolderOpen /><span title={runtime?.model_dir}>{runtime?.model_dir || '正在读取模型位置'}</span><em>更改位置</em></button>
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

      {modelsOpen && (
        <div className="modal-backdrop" onMouseDown={() => !modelBusy && !translationBusy && !aiSettingsBusy && !aiModelsBusy && setModelsOpen(false)}>
          <section className="modal model-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" disabled={aiSettingsBusy || aiModelsBusy} onClick={() => !modelBusy && !translationBusy && !aiSettingsBusy && !aiModelsBusy && setModelsOpen(false)}><X /></button><Languages className="modal-mark" /><h2>模型</h2><p>管理语音识别模型，并选择本地模型或兼容 OpenAI 格式的 AI 接口完成中文翻译。</p>
            <button className="model-folder path-readable" type="button" disabled={modelBusy || translationBusy} onClick={chooseModelDirectory}><FolderOpen /><span title={runtime?.model_dir}>{runtime?.model_dir || '正在读取模型目录'}</span><em>选择位置</em></button>
            {modelProgress && <div className="model-confirm-progress"><div><span>{modelProgress.message}</span><b>{Math.round(modelProgress.percent)}%</b></div><div><i style={{ width: `${modelProgress.percent}%` }} /></div><small>{formatBytes(modelProgress.downloaded)} / {formatBytes(modelProgress.total)}</small><button type="button" onClick={() => invoke('cancel_model_download')}>取消下载</button></div>}
            {translationBusy && <div className="model-confirm-progress"><div><span>{translationProgress.message || '正在准备中文翻译模型'}</span><b>{Math.round(translationProgress.percent)}%</b></div><div><i style={{ width: `${translationProgress.percent}%` }} /></div></div>}
            <h3 className="model-group-title">语音识别模型 · 来源 Whisper 官方上游</h3>
            <div className="model-list speech-model-list">{runtime?.models.map((model) => <article className={model.id === modelId && model.installed ? 'selected' : ''} key={model.id}><div><strong>{model.name}</strong><span>{formatBytes(model.size_bytes)}{model.recommended ? ' · 推荐' : ''}</span></div><div className="model-actions">{model.installed && <button type="button" className={model.id === modelId ? 'current' : 'use'} disabled={modelBusy || model.id === modelId} onClick={() => selectModel(model.id)}>{model.id === modelId ? <Check /> : null}{model.id === modelId ? '使用中' : '选用'}</button>}{model.installed ? <button type="button" className="danger icon-only" aria-label={`删除 ${model.name}`} disabled={modelBusy} onClick={() => removeModel(model.id)}><Trash2 /></button> : <button type="button" disabled={modelBusy} onClick={() => installModel(model.id)}><Download />下载</button>}</div></article>)}</div>
            <div className="translation-provider-settings">
              <h3 className="model-group-title translation-title">中文翻译方式</h3>
              <div className="provider-switch">
                <button className={settingsProvider === 'local' ? 'selected' : ''} type="button" onClick={() => chooseTranslationProvider('local')}><Server /><span><strong>本地模型</strong><small>离线运行，不需要 Key</small></span></button>
                <button className={settingsProvider === 'api' ? 'selected' : ''} type="button" onClick={() => chooseTranslationProvider('api')}><Cloud /><span><strong>AI 接口</strong><small>无需下载翻译模型</small></span></button>
              </div>

              {settingsProvider === 'local' ? <div className="model-list translation-model"><article><div><strong>多语言 → 简体中文</strong><span>{formatBytes(runtime?.translation_model_size_bytes || 646109073)} · 生成双语文案</span></div>{translationCached ? <div className="model-actions"><span className="installed-badge"><Check />已安装</span><button type="button" className="danger icon-only" aria-label="删除中文翻译模型" disabled={translationBusy} onClick={removeTranslationModel}><Trash2 /></button></div> : <button type="button" disabled={translationBusy} onClick={prepareTranslation}><Download />下载</button>}</article></div> : <div className="api-settings-form">
                <label><span>接口 URL</span><input type="url" value={aiDraft.baseUrl} onChange={(event) => { setAiDraft((current) => ({ ...current, baseUrl: event.target.value })); setAvailableAiModels([]); setAiModelManual(true) }} placeholder="https://api.openai.com/v1" /></label>
                <label className="api-model-field"><span>AI 模型</span><div><select aria-label="选择上游模型" value={aiModelManual ? '__manual__' : aiDraft.model} onChange={(event) => { if (event.target.value === '__manual__') { setAiModelManual(true) } else { setAiModelManual(false); setAiDraft((current) => ({ ...current, model: event.target.value })) } }}>{availableAiModels.map((model) => <option value={model} key={model}>{model}</option>)}<option value="__manual__">{availableAiModels.length ? '手动填写其他模型…' : '手动填写模型名称'}</option></select><button type="button" disabled={aiModelsBusy} onClick={() => void loadAiModels()}>{aiModelsBusy ? <LoaderCircle className="spin" /> : <RefreshCw />}获取模型</button></div>{aiModelManual && <input className="manual-model-input" type="text" value={aiDraft.model} onChange={(event) => setAiDraft((current) => ({ ...current, model: event.target.value }))} placeholder="例如 gpt-4o-mini" />}</label>
                <label className="api-key-field"><span>API Key <small>本地接口可留空</small></span><div><KeyRound /><input type="password" autoComplete="off" value={aiDraft.apiKey} onChange={(event) => { setAiDraft((current) => ({ ...current, apiKey: event.target.value })); setAvailableAiModels([]); setAiModelManual(true) }} placeholder={aiSettings.api_key_saved ? '已安全保存，留空不会替换' : 'sk-…'} /></div></label>
                {aiSettings.api_key_saved && <div className="saved-key-row"><ShieldCheck /><span>API Key 已使用 Windows 加密保存在本机</span><button type="button" disabled={aiSettingsBusy} onClick={() => void clearSavedAiKey()}>清除</button></div>}
                <p className="api-hint">支持服务根地址、以 /v1 结尾的地址，或完整 /chat/completions 地址。</p>
              </div>}
              {aiSettingsStatus && <div className="settings-status"><AlertCircle />{aiSettingsStatus}</div>}
              <div className="model-provider-actions">
                {settingsProvider === 'api' && <button type="button" disabled={aiSettingsBusy || aiModelsBusy} onClick={() => void saveAiTranslationSettings(true)}>{aiSettingsBusy ? <LoaderCircle className="spin" /> : <RefreshCw />}测试连接</button>}
                <button className="confirm" type="button" disabled={aiSettingsBusy || aiModelsBusy} onClick={() => void saveAiTranslationSettings(false)}>{aiSettingsBusy ? <LoaderCircle className="spin" /> : <Save />}保存翻译方式</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
