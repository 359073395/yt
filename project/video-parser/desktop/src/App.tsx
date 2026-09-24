import React from 'react'
import { Archive, ChevronDown, Clock3, Folder, Plus, Search, Play, Radio, Rss } from 'lucide-react'
import { MediaCard } from './MediaCard'
import { AccountsPanel } from './AccountsPanel'
import { AutomationPanel, useAutomation } from './AutomationPanel'
import { mergeDeliveries } from './automation'
import { categoryDirectory, filterRecords, isActive, normalizeCategory, restoreLibrary, type PendingItem, type LibraryRecord, type LibraryJournal } from './library'
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
import { AutoDownloadControl, TeamInbox, type Snapshot } from './TeamInbox'

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
  const [view, setView] = React.useState<'tasks' | 'library' | 'subscriptions' | 'live'>('library')
  const automation = useAutomation()
  const autoStarting = React.useRef(false)
  const [persistedAutomation, setPersistedAutomation] = React.useState<string[]>([])
  const [category, setCategory] = React.useState('*')
  const [categories, setCategories] = React.useState<string[]>([])
  const [search, setSearch] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [accountsOpen, setAccountsOpen] = React.useState(false)
  const [categoryDraft, setCategoryDraft] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<LibraryRecord | null>(null)
  const [editCategory, setEditCategory] = React.useState('')
  const [editNote, setEditNote] = React.useState('')
  const [actionBusy, setActionBusy] = React.useState(false)
  const [journalReady, setJournalReady] = React.useState(false)
  const [feishu, setFeishu] = React.useState<Snapshot | null>(null)
  const [feishuProgress, setFeishuProgress] = React.useState<Record<string, ProgressEvent>>({})
  const journalWriter = React.useRef(Promise.resolve())
  const journalTimer = React.useRef<number | null>(null)
  const journalLatest = React.useRef<LibraryJournal | null>(null)
  const aborters = React.useRef(new Map<string, AbortController>())
  const pendingStartIds = React.useRef<string[] | undefined>(undefined)
  const [teamOpen, setTeamOpen] = React.useState(false)
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

  React.useEffect(() => {
    let cancelled = false
    void invoke<unknown>('library_load').then(value => {
      if (cancelled) return
      const restored = restoreLibrary(value)
      setPendingItems(restored.items); setTasks(restored.tasks); setCategories(restored.categories); setJournalReady(true)
    }).catch(error => { if (!cancelled) setMessage(String(error)) })
    return () => { cancelled = true }
  }, [])
  React.useEffect(() => {
    if (!journalReady) return
    journalLatest.current = { version: 1, items: pendingItems, tasks, categories }
    if (journalTimer.current !== null) return
    journalTimer.current = window.setTimeout(() => {
      const data = journalLatest.current
      journalTimer.current = null
      journalWriter.current = journalWriter.current.then(async () => {
        await invoke<void>('library_save', { data })
        const ids = data?.items.map(item => item.automationId).filter((id): id is string => !!id) || []
        setPersistedAutomation(ids)
        if (ids.length) await invoke('automation_ack', { ids })
      })
        .catch(error => setMessage(`任务记录保存失败：${String(error)}。请不要退出软件。`))
    }, 500)
  }, [journalReady, pendingItems, tasks, categories])
  React.useEffect(() => () => { if (journalTimer.current !== null) window.clearTimeout(journalTimer.current) }, [])
  React.useEffect(() => {
    if (!journalReady || !automation.snapshot.deliveries.length) return
    setPendingItems(items => mergeDeliveries(items, automation.snapshot.deliveries, quality))
  }, [journalReady, automation.snapshot.deliveries, quality])

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
        if (payload.job_id.startsWith('team-')) setFeishuProgress(current => ({ ...current, [payload.job_id.slice(5)]: payload }))
        setTasks((current) => current.map((task) => task.id === payload.job_id && task.status !== 'cancelled'
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
    if (!runtime || runtime.preview_build) return
    const timer = window.setTimeout(() => void checkForUpdates(true), 4000)
    return () => window.clearTimeout(timer)
  }, [runtime?.version, runtime?.preview_build])

  const urls = React.useMemo(() => extractSharedUrls(input), [input])
  const taskIndex = React.useMemo(() => new Map(tasks.map(task => [task.queueItemId, task])), [tasks])
  const selectedItems = React.useMemo(() => pendingItems.filter(item => item.selected && !isActive(taskIndex.get(item.id)) && taskIndex.get(item.id)?.status !== 'completed'), [pendingItems, taskIndex])
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
    if (!runtime || runtime.preview_build) {
      if (!silent && runtime?.preview_build) setMessage('这是独立试用版，不连接正式版自动升级渠道。')
      return
    }
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
      category: category === '*' ? '待分类' : category,
      note: '',
      created: Date.now(),
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
    if (parsing || !journalReady) return
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
      setSearch('')
      setStatusFilter('all')
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
      if (prompt.resumeDownload) await executeSelectedDownloads(true, pendingStartIds.current)
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

  async function startSelectedDownloads(ids?: string[]) {
    pendingStartIds.current = ids
    if (downloadStarting || running) return
    if (!ids?.length && !selectedItems.length) {
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
      await executeSelectedDownloads(false, ids)
    } catch (error) {
      setMessage(`无法启动下载：${String(error)}`)
    } finally {
      setDownloadStarting(false)
    }
  }

  const autoReady = journalReady && toolsReady && !!downloadDir && !!selectedOutputCount && !running && !downloadStarting && !parsing
    && (!includeCopy || ((transcriptMode === 'native' || !!installedModel) && (translationProvider === 'api' ? aiConfigured : translationCached)))
  const autoCandidates = pendingItems.filter(item => item.autoDownload && persistedAutomation.includes(item.automationId || '') && !tasks.some(task => task.queueItemId === item.id))
  React.useEffect(() => {
    if (!autoReady || autoStarting.current || !autoCandidates.length) return
    autoStarting.current = true
    void startSelectedDownloads(autoCandidates.map(item => item.id)).finally(() => { autoStarting.current = false })
  }, [autoReady, pendingItems, tasks, persistedAutomation])

  async function executeSelectedDownloads(modelsPrepared = false, ids?: string[]) {
    if (running || !journalReady) return
    setMessage(null)
    const chosen = pendingItems.filter(item => (ids ? ids.includes(item.id) : item.selected) && !isActive(tasks.find(task => task.queueItemId === item.id)) && tasks.find(task => task.queueItemId === item.id)?.status !== 'completed')
    if (!chosen.length) return
    const created = chosen.map<DownloadTask>(item => ({
      id: crypto.randomUUID(), queueItemId: item.id, url: item.url, title: item.title,
      platform: item.platform, status: 'queued', percent: 0, message: '已加入本地下载队列',
    }))
    const chosenIds = new Set(chosen.map(item => item.id))
    setTasks(current => [...created, ...current.filter(task => !chosenIds.has(task.queueItemId))])
    created.forEach(task => aborters.current.set(task.id, new AbortController()))
    setRunning(true)
    let translationReady: Promise<void> | null = null
    if (translationTarget === 'zh' && translationProvider === 'local') {
      translationReady = modelsPrepared ? Promise.resolve() : prepareTranslation()
      void translationReady.catch(() => undefined)
    }
    let textQueue = Promise.resolve()
    try {
      for (let index = 0; index < created.length; index += 1) {
        const task = created[index], source = chosen[index]
        const signal = aborters.current.get(task.id)!.signal
        if (signal.aborted) continue
        try {
          const options: DownloadOptions = {
            download_dir: downloadDir, category: source.category, quality: source.quality,
            include_video: includeVideo, include_thumbnail: includeThumbnail,
            include_original_subtitle: includeSubtitle, transcript_mode: includeCopy ? transcriptMode : 'none',
            language, model_id: modelId,
          }
          const result = await invoke<DownloadResult>('download_item', { request: { job_id: task.id, url: task.url, options } })
          setPendingItems(current => current.map(item => item.id === source.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, thumbnail: result.thumbnail || item.thumbnail, uploader: result.uploader || item.uploader, duration: result.duration ?? item.duration, downloaded: true, loading: false, error: null } : item))
          setTasks(current => current.map(item => item.id === task.id
            ? { ...item, title: result.title, platform: result.platform || item.platform, result, outputDir: result.output_dir, sourceLanguage: result.source_language, status: signal.aborted ? 'cancelled' : 'translating', percent: 0, message: '文件已保存；文案排队中' } : item))
          // A separate serial text queue lets the next video download while the API/worker translates.
          textQueue = textQueue.then(async () => {
            if (signal.aborted) return
            const outcome = await finishTranslation(result, {
              target: translationTarget, provider: translationProvider, modelBaseUrl: runtime!.model_server_url,
              ready: translationReady, signal,
            }, (percent, detail) => setTasks(current => current.map(item => item.id === task.id && !signal.aborted
              ? { ...item, status: 'translating', percent, message: detail } : item)))
            if (!signal.aborted) {
              setTasks(current => current.map(item => item.id === task.id ? { ...item, ...outcome, percent: 100 } : item))
              setPendingItems(current => current.map(item => item.id === source.id ? { ...item, selected: false } : item))
            }
          })
        } catch (error) {
          const detail = String(error)
          setTasks(current => current.map(item => item.id === task.id
            ? { ...item, status: signal.aborted || detail.includes('已取消') ? 'cancelled' : 'failed', message: signal.aborted ? '用户已取消' : detail } : item))
        }
      }
      await textQueue
    } finally {
      created.forEach(task => aborters.current.delete(task.id))
      setRunning(false)
    }
  }

  async function cancelTask(task: DownloadTask) {
    aborters.current.get(task.id)?.abort()
    setTasks(current => current.map(item => item.id === task.id ? { ...item, status: 'cancelled', message: item.outputDir ? '已取消后续处理，已保存文件保留' : '用户已取消' } : item))
    // No child exists yet for queued work, or while an API response settles.
    if (task.status !== 'queued' && task.status !== 'translating') await invoke('cancel_job', { jobId: task.id }).catch(() => undefined)
  }

  async function retryRecord(record: LibraryRecord) {
    if (record.source === 'feishu') {
      await action(async () => { await invoke('team_action', { action: 'edit', body: { id: record.item.id, retry: true } }) }); return
    }
    const task = record.task
    if (task?.result?.segments.length) {
      if (running) { setMessage('请等待当前文案处理结束后再重试'); return }
      if (requiredModels(false)) return
      const controller = new AbortController()
      aborters.current.set(task.id, controller); setRunning(true)
      setTasks(current => current.map(item => item.id === task.id ? { ...item, status: 'translating', percent: 0, message: '正在重试文案，不重新下载视频' } : item))
      try {
        const outcome = await finishTranslation(task.result, { target: 'zh', provider: translationProvider, modelBaseUrl: runtime!.model_server_url, ready: translationProvider === 'local' ? prepareTranslation() : null, signal: controller.signal },
          (percent, detail) => setTasks(current => current.map(item => item.id === task.id && !controller.signal.aborted ? { ...item, percent, message: detail } : item)))
        if (!controller.signal.aborted) setTasks(current => current.map(item => item.id === task.id ? { ...item, ...outcome } : item))
      } finally { aborters.current.delete(task.id); setRunning(false) }
    } else await startSelectedDownloads([record.item.id])
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
    const ids = new Set(bulkTargets.map(record => record.item.id))
    const shouldSelect = bulkTargets.some(record => !record.item.selected)
    setPendingItems(current => current.map(item => ids.has(item.id) ? { ...item, selected: shouldSelect } : item))
  }

  function setBatchQuality(next: string) {
    setQuality(next)
    setPendingItems((current) => current.map((item) => item.selected ? { ...item, quality: next } : item))
  }

  function removeSelectedQueueItems() {
    const ids = new Set(bulkTargets.filter(record => record.item.selected).map(record => record.item.id))
    setPendingItems(current => current.filter(item => !ids.has(item.id)))
    setTasks(current => current.filter(task => !ids.has(task.queueItemId)))
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

  const deferredSearch = React.useDeferredValue(search)
  const records = React.useMemo<LibraryRecord[]>(() => [
    ...pendingItems.map(item => ({ item, task: taskIndex.get(item.id), source: 'manual' as const })),
    ...(feishu?.jobs || []).map(job => {
      const progress = feishuProgress[job.id]
      const status = ({ queued: 'queued', downloading: 'downloading', archiving: 'downloading', downloaded: 'translating', preparing: 'transcribing', text_ready: 'translating', completed: 'completed', partial: 'partial', failed: 'failed' } as const)[job.stage as 'queued'] || 'queued'
      return {
        source: 'feishu' as const,
        item: { id: job.id, url: job.url, title: job.result?.title || '飞书收录的视频', platform: job.result?.platform || platformName(job.url), uploader: job.result?.uploader || '', thumbnail: job.result?.thumbnail, duration: job.result?.duration, selected: false, quality: '1080', loading: false, category: job.category, note: job.note, created: job.created },
        task: { id: job.id, queueItemId: job.id, url: job.url, title: job.result?.title || '飞书视频', platform: job.result?.platform || '', status, percent: progress?.percent || 0, message: job.detail, outputDir: job.result?.output_dir, result: job.result },
      }
    }),
  ], [pendingItems, taskIndex, feishu, feishuProgress])
  const allCategories = [...new Set(['待分类', ...categories, ...records.map(record => record.item.category)])]
  const shown = filterRecords(records, category, deferredSearch, statusFilter, view)
  const bulkTargets = shown.filter(record => record.source === 'manual' && !isActive(record.task))
  const visibleSelected = bulkTargets.filter(record => record.item.selected && record.task?.status !== 'completed')
  const paired = Boolean(feishu?.config.session?.device_id) && !feishu?.config.onboarding
  const outputPath = downloadDir ? categoryDirectory(downloadDir, category === '*' ? '待分类' : category) : '请选择保存位置'
  async function action(work: () => Promise<void>) {
    setActionBusy(true)
    try { await work() } catch (error) { setMessage(String(error)) } finally { setActionBusy(false) }
  }
  async function toggleFeishu() {
    if (!paired || !feishu?.config.root) { setTeamOpen(true); return }
    await action(async () => {
      await invoke('team_save', { config: { ...feishu!.config, enabled: !feishu!.config.enabled } })
      setFeishu(await invoke<Snapshot>('team_snapshot'))
    })
  }
  function editRecord(record: LibraryRecord) {
    setEditing(record); setEditCategory(record.item.category); setEditNote(record.item.note)
  }
  async function saveRecord() {
    if (!editing) return
    await action(async () => {
      const targetCategory = normalizeCategory(editCategory)
      if (editing.source === 'feishu') await invoke('team_action', { action: 'edit', body: { id: editing.item.id, category: targetCategory, note: editNote } })
      else {
        let target = editing.task?.outputDir
        if (target && targetCategory !== editing.item.category) target = await invoke<string>('relocate_output', { outputDir: target, root: downloadDir, category: targetCategory })
        setPendingItems(current => current.map(item => item.id === editing.item.id ? { ...item, category: targetCategory, note: editNote } : item))
        if (target) setTasks(current => current.map(task => task.queueItemId === editing.item.id ? { ...task, outputDir: target, result: task.result ? { ...task.result, output_dir: target! } : undefined } : task))
      }
      setCategories(current => [...new Set([...current, targetCategory])]); setEditing(null)
    })
  }

  return (
    <main className="desktop-shell workbench">
      <header className="workbench-header">
        <div className="workbench-brand"><Play size={24} fill="currentColor" /><strong>跑量影链工坊</strong></div>
        <nav aria-label="工作区"><button className={view === 'tasks' ? 'active' : ''} onClick={() => { setView('tasks'); setStatusFilter('all') }}>视频任务</button><button className={view === 'library' ? 'active' : ''} onClick={() => { setView('library'); setStatusFilter('all') }}>素材库</button><button className={view === 'subscriptions' ? 'active' : ''} onClick={() => setView('subscriptions')}>博主订阅</button><button className={view === 'live' ? 'active' : ''} onClick={() => setView('live')}>直播录制</button></nav>
        <div className="workbench-tools"><button onClick={() => setAccountsOpen(true)}><UserRound size={18} />账号</button><button onClick={openModels}><Languages size={18} />模型</button><button title={runtime?.preview_build ? '独立试用版，不连接正式版自动升级渠道' : undefined} disabled={updateChecking || running} onClick={() => void checkForUpdates(false)}><RefreshCw size={18} className={updateChecking ? 'spin' : ''} />{runtime?.preview_build ? '试用版' : updatePrompt ? '可升级' : '更新'}</button></div>
      </header>
      {message && <div className="notice" role="status"><AlertCircle size={18} /><span>{message}</span><button aria-label="关闭提示" onClick={() => setMessage(null)}><X size={18} /></button></div>}
      <div className="workbench-body">
        <aside className="category-sidebar">
          <h2>分类文件夹</h2>
          <div className="category-list">
            <button className={category === '*' ? 'active' : ''} onClick={() => setCategory('*')}><Archive size={21} />全部素材</button>
            {allCategories.map(name => <button key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)} title={name}>{name === '待分类' ? <Clock3 size={21} /> : <Folder size={21} />}<span>{name}</span></button>)}
            <button onClick={() => setCategoryDraft('')}><Plus size={21} />新建分类</button>
          </div>
          <div className="feishu-shortcut">
            <button onClick={() => setTeamOpen(true)}><Cloud size={22} /><span>我的飞书 · {paired ? '已配对' : '未绑定'}</span></button>
            <AutoDownloadControl compact enabled={!!feishu?.config.enabled} busy={actionBusy} onToggle={() => void toggleFeishu()} />
            <small title={feishu?.connection}>{feishu?.connection || '点击上方绑定个人助手'}</small><small className="feishu-category-tip">发链接时加：分类 护肤</small>
          </div>
        </aside>
        {view === 'subscriptions' || view === 'live' ? <AutomationPanel key={view} view={view} snapshot={automation.snapshot} error={automation.error} root={downloadDir} category={category} chooseRoot={() => void action(chooseDirectory)} showTasks={() => { setView('tasks'); setCategory('*'); setStatusFilter('all') }} waiting={autoCandidates.length > 0 && !autoReady} /> : <section className="library-workspace">
          <form className="collection-composer" onSubmit={event => void parseLinks(event)}>
            <div className="collection-heading"><h1>视频链接</h1>{urls.length > 0 && <span>识别到 {urls.length} 条</span>}</div>
            <div className="collection-input"><textarea aria-label="视频链接" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void parseLinks() } }} placeholder={'粘贴多条视频链接或分享文案，每行一条'} /><button className="primary" type="submit" disabled={parsing || !toolsReady || !urls.length || !journalReady}>{parsing ? <LoaderCircle className="spin" size={20} /> : null}解析链接</button><button type="button" disabled={parsing || !toolsReady || urls.length !== 1 || !journalReady} onClick={() => void parseLinks(undefined, true)}>博主主页</button></div>
            <div className="collection-options">
              <div className="output-options"><label><input type="checkbox" checked={includeVideo} onChange={event => setIncludeVideo(event.target.checked)} />视频</label><label><input type="checkbox" checked={includeThumbnail} onChange={event => setIncludeThumbnail(event.target.checked)} />封面</label><label><input type="checkbox" checked={includeCopy} onChange={event => requestTranslation(event.target.checked ? 'zh' : 'none')} />双语文案</label><label title="平台字幕存在时保存原文件"><input type="checkbox" checked={includeSubtitle} onChange={event => setIncludeSubtitle(event.target.checked)} />原版字幕</label></div>
              <label className="compact-select">画质<select aria-label="批量画质" value={quality} onChange={event => setBatchQuality(event.target.value)}><option value="best">原始最佳</option><option value="2160">最高 4K</option><option value="1080">最高 1080P</option><option value="720">最高 720P</option><option value="480">最高 480P</option></select></label>
              <button className="text-button" type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}>下载选项<ChevronDown size={18} /></button>
            </div>
            <div className="collection-location"><span>保存到</span><button type="button" className="path-control" title={outputPath} onClick={() => void action(chooseDirectory)}><span>{outputPath}</span><FolderOpen size={20} /><span>更改</span></button><label className="compact-select">识别<select aria-label="识别模型" value={modelId} onChange={event => chooseModelFromPanel(event.target.value)}>{runtime?.models.map(model => <option key={model.id} value={model.id}>{model.name.split(' · ')[0]}{model.installed ? '' : ' · 未下载'}</option>)}</select></label><label className="compact-select">翻译<select aria-label="翻译方式" value={translationProvider} onChange={event => { const value = event.target.value as TranslationProvider; setTranslationProvider(value); window.localStorage.setItem('yinglian-translation-provider', value) }}><option value="api">AI 接口</option><option value="local">本地模型</option></select></label></div>
            {optionsOpen && <div className="advanced-options"><label>提取方式<select value={transcriptMode} onChange={event => requestTranscriptMode(event.target.value as TranscriptMode)}><option value="auto">字幕优先，AI 兜底</option><option value="native">仅平台字幕</option><option value="ai">始终 AI 识别</option></select></label><label>来源语言<select value={language} onChange={event => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="en">英语</option><option value="id">印尼语</option><option value="zh">中文</option><option value="ja">日语</option><option value="ko">韩语</option><option value="es">西班牙语</option></select></label><p>画质不超过原视频；原字幕有则保存。API 翻译会发送字幕文本至你配置的服务，不上传账号 Cookie。</p></div>}
          </form>
          <section className="library-section">
            <div className="library-heading"><h2>{category === '*' ? (view === 'tasks' ? '视频任务' : '全部素材') : category}</h2><div className="library-filters" aria-label="任务状态筛选">{[['all','全部'],['active','进行中'],['completed','已完成'],['issues','需处理']].map(([value,label]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => { if (value === 'completed') setView('library'); setStatusFilter(value) }}>{label}</button>)}</div><label className="library-search"><Search size={18} /><input aria-label="搜索素材" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题或备注" /></label></div>
            {bulkTargets.some(record => record.item.selected) && <div className="library-bulk"><label><input type="checkbox" checked={bulkTargets.length > 0 && bulkTargets.every(record => record.item.selected)} disabled={!bulkTargets.length} onChange={toggleAll} />全选手动任务</label><span>{shown.length} 条</span><button disabled={!bulkTargets.some(record => record.item.selected) || running} onClick={removeSelectedQueueItems}><Trash2 size={16} />移除记录</button><button className="primary" disabled={downloadStarting || running || parsing || !visibleSelected.length || !selectedOutputCount || !toolsReady || !journalReady} onClick={() => void startSelectedDownloads(visibleSelected.map(record => record.item.id))}>{running ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{running ? '任务处理中' : `下载选中 ${visibleSelected.length} 项`}</button></div>}
            <div className="asset-grid">
              {!shown.length && <div className="library-empty"><Archive size={38} /><h3>{search || statusFilter !== 'all' ? '没有匹配的素材' : '把好视频收在这里'}</h3><p>粘贴链接解析，或用自己的飞书助手发送视频。</p><p>每条视频独立保存，可按分类和备注查找。</p></div>}
              {shown.map(record => <MediaCard key={record.source + record.item.id} record={record}
                onSelect={() => setPendingItems(current => current.map(item => item.id === record.item.id ? { ...item, selected: !item.selected } : item))}
                onEdit={() => editRecord(record)} onOpen={() => record.task && void openTaskFolder(record.task)}
                onCopy={() => void action(async () => { const text = await invoke<string>('read_bilingual', { outputDir: record.task!.outputDir }); await navigator.clipboard.writeText(text); setMessage('双语文案已复制') })}
                onCancel={() => record.task && void cancelTask(record.task)} onRetry={() => void retryRecord(record)} />)}
            </div>
          </section>
        </section>}
      </div>
      <TeamInbox open={teamOpen} onClose={() => setTeamOpen(false)} runtime={runtime} defaultDir={downloadDir} provider={translationProvider} modelId={modelId} onSnapshot={setFeishu} />
      {categoryDraft !== null && <div className="modal-backdrop"><form className="modal simple-form" onSubmit={event => { event.preventDefault(); try { const name = normalizeCategory(categoryDraft); setCategories(current => [...new Set([...current, name])]); setCategory(name); setCategoryDraft(null) } catch (error) { setMessage(String(error)) } }}><h2>新建分类</h2><label>分类名称<input autoFocus value={categoryDraft} maxLength={180} onChange={event => setCategoryDraft(event.target.value)} placeholder="例如：美妆/口播" required /></label><p>新任务将保存到对应分类文件夹。</p><div className="modal-actions"><button type="button" onClick={() => setCategoryDraft(null)}>取消</button><button className="confirm" type="submit">创建</button></div></form></div>}
      {editing && <div className="modal-backdrop"><form className="modal simple-form" onSubmit={event => { event.preventDefault(); void saveRecord() }}><h2>分类与备注</h2><label>分类<input value={editCategory} onChange={event => setEditCategory(event.target.value)} required maxLength={180} /></label><label>备注<textarea value={editNote} onChange={event => setEditNote(event.target.value)} maxLength={1000} /></label><p>已下载的单条视频文件夹会一起移动，不覆盖已有文件。</p><div className="modal-actions"><button type="button" onClick={() => setEditing(null)} disabled={actionBusy}>取消</button><button className="confirm" type="submit" disabled={actionBusy}>保存</button></div></form></div>}
      {accountsOpen && <AccountsPanel onClose={() => setAccountsOpen(false)} />}

      {modelPrompt && (
        <div className="modal-backdrop">
          <section className="modal first-model-modal">
            <div className="model-prompt-mark"><WandSparkles /></div>
            <h2>首次使用需要下载模型</h2>
            <p>模型只下载一次，并保存在你选择的本地位置。没有得到确认前，跑量影链工坊不会自动下载。</p>
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
          <section className="modal model-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭模型窗口" type="button" disabled={aiSettingsBusy || aiModelsBusy} onClick={() => !modelBusy && !translationBusy && !aiSettingsBusy && !aiModelsBusy && setModelsOpen(false)}><X /></button><Languages className="modal-mark" /><h2>模型</h2><p>管理语音识别模型，并选择本地模型或兼容 OpenAI 格式的 AI 接口完成中文翻译。</p>
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
