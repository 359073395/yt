import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleStop,
  Download,
  FileText,
  FolderOpen,
  Languages,
  Link2,
  ListVideo,
  LoaderCircle,
  LogIn,
  PackageOpen,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import {
  type DownloadOptions,
  type DownloadRequest,
  type DownloadResult,
  type DownloadTask,
  type InputMode,
  type ModelProgress,
  type ProfileItem,
  type ProgressEvent,
  type RuntimeInfo,
  type TranscriptMode,
  type TranslationInput,
  extractSharedUrls,
  platformName,
  statusLabel,
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

function formatBytes(value: number) {
  if (!value) return '0 MB'
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`
}

function App() {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [mode, setMode] = React.useState<InputMode>('single')
  const [input, setInput] = React.useState('')
  const [profileLimit, setProfileLimit] = React.useState(50)
  const [downloadDir, setDownloadDir] = React.useState('')
  const [quality, setQuality] = React.useState('best')
  const [transcriptMode, setTranscriptMode] = React.useState<TranscriptMode>('auto')
  const [language, setLanguage] = React.useState('auto')
  const [modelId, setModelId] = React.useState('small')
  const [includeThumbnail, setIncludeThumbnail] = React.useState(true)
  const [includeDescription, setIncludeDescription] = React.useState(true)
  const [tasks, setTasks] = React.useState<DownloadTask[]>([])
  const [running, setRunning] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const [modelsOpen, setModelsOpen] = React.useState(false)
  const [modelProgress, setModelProgress] = React.useState<ModelProgress | null>(null)
  const [modelBusy, setModelBusy] = React.useState(false)
  const [translationTarget, setTranslationTarget] = React.useState<'none' | 'zh'>('none')
  const [translationBusy, setTranslationBusy] = React.useState(false)
  const [translationProgress, setTranslationProgress] = React.useState({ percent: 0, message: '' })
  const [translationCached, setTranslationCached] = React.useState(false)

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
        setTasks((current) =>
          current.map((task) =>
            task.id === payload.job_id
              ? { ...task, status: payload.phase, percent: payload.percent, message: payload.message }
              : task,
          ),
        )
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

  const urls = React.useMemo(() => extractSharedUrls(input), [input])
  const installedModel = runtime?.models.find((model) => model.id === modelId)?.installed ?? false
  const toolsReady = Boolean(runtime?.yt_dlp_available && runtime?.ffmpeg_available)

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
      setMessage('多语言模型已准备好。')
    } catch (error) {
      setMessage(String(error))
      throw error
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

  async function resolveUrls(): Promise<string[]> {
    if (mode === 'profile') {
      if (urls.length !== 1) throw new Error('博主主页模式一次只粘贴一个主页或频道链接。')
      setScanning(true)
      try {
        const entries = await invoke<ProfileItem[]>('scan_profile', {
          request: { url: urls[0], limit: profileLimit },
        })
        return entries.map((item) => item.url)
      } finally {
        setScanning(false)
      }
    }
    if (!urls.length) throw new Error('没有识别到有效链接，可以直接粘贴带中文的完整分享文案。')
    if (mode === 'single') return [urls[0]]
    if (urls.length > 50) throw new Error('多链接批量一次最多处理 50 条。')
    return urls
  }

  async function startDownload(event: React.FormEvent) {
    event.preventDefault()
    if (running || scanning) return
    setMessage(null)
    if (!toolsReady) {
      setMessage('桌面运行组件尚未准备好，请使用正式安装包或重新安装。')
      return
    }
    let translationReady: Promise<void> | null = null
    try {
      if (translationTarget === 'zh' && transcriptMode === 'none') {
        throw new Error('请先开启“字幕优先，AI 兜底”或“AI 识别语音”，才能翻译成中文。')
      }
      if ((transcriptMode === 'ai' || transcriptMode === 'auto') && !installedModel) {
        setMessage('首次使用 AI 文案，模型下载完成后会自动开始任务。')
        await installModel(modelId)
      }
      if (translationTarget === 'zh') {
        translationReady = prepareTranslation()
        void translationReady.catch(() => undefined)
      }
      const resolved = await resolveUrls()
      const created = resolved.map<DownloadTask>((url) => ({
        id: crypto.randomUUID(),
        url,
        title: '等待读取视频信息',
        platform: platformName(url),
        status: 'queued',
        percent: 0,
        message: '已加入本地队列',
      }))
      setTasks((current) => [...created, ...current].slice(0, 200))
      setRunning(true)
      const options: DownloadOptions = {
        download_dir: downloadDir,
        quality,
        include_thumbnail: includeThumbnail,
        include_description: includeDescription,
        transcript_mode: transcriptMode,
        language,
        model_id: modelId,
        translation_target: translationTarget === 'zh' ? 'zh' : null,
      }
      for (const task of created) {
        try {
          const request: DownloadRequest = { job_id: task.id, url: task.url, options }
          const result = await invoke<DownloadResult>('download_item', { request })
          let finalMessage = result.warning || '视频、封面和文案已保存'
          if (translationTarget === 'zh' && result.transcript_available) {
            const source = toTranslationLanguage(result.source_language)
            if (source === 'zh') {
              finalMessage = `${finalMessage}；语音文案已经是中文`
            } else if (!source) {
              finalMessage = `${finalMessage}；未能确定原文语言，中文翻译已跳过`
            } else {
              setTasks((current) => current.map((item) => item.id === task.id ? { ...item, title: result.title, platform: result.platform || item.platform, status: 'transcribing', percent: 0, outputDir: result.output_dir, message: '正在翻译为中文' } : item))
              try {
                await translationReady
                const translationInput = await invoke<TranslationInput>('translation_input', {
                  request: { output_dir: result.output_dir, source_language: result.source_language },
                })
                const translations = await translateToChinese(
                  translationInput.segments.map((segment) => segment.text),
                  source,
                  runtime!.model_server_url,
                  (percent, detail) => setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'transcribing', percent, message: detail } : item)),
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
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, title: result.title, platform: result.platform || item.platform, status: 'completed', percent: 100, outputDir: result.output_dir, message: finalMessage } : item))
        } catch (error) {
          const detail = String(error)
          const cancelled = detail.toLowerCase().includes('terminated') || detail.includes('已取消')
          setTasks((current) =>
            current.map((item) =>
              item.id === task.id
                ? { ...item, status: cancelled ? 'cancelled' : 'failed', message: detail }
                : item,
            ),
          )
        }
      }
    } catch (error) {
      setMessage(String(error))
    } finally {
      setRunning(false)
    }
  }

  async function cancelTask(task: DownloadTask) {
    try {
      await invoke('cancel_job', { jobId: task.id })
      setTasks((current) => current.map((item) => (item.id === task.id ? { ...item, status: 'cancelled', message: '用户已取消' } : item)))
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

  return (
    <main className="desktop-app">
      <header className="topbar">
        <div className="brand"><span><Video size={17} fill="currentColor" /></span><strong>影链工坊</strong><em>Desktop 1.0</em></div>
        <div className="top-actions">
          <button className="quiet" type="button" onClick={() => setModelsOpen(true)}><Sparkles size={16} />模型</button>
          <button className="quiet" type="button" onClick={() => setAccountOpen(true)}><UserRound size={16} />平台登录{runtime?.login_profile_available && <i />}</button>
        </div>
      </header>

      <section className="hero">
        <div><span className="eyebrow">本地处理 · 公开内容免登录 · 登录会话不上传</span><h1>视频、封面与多语言文案，一次保存。</h1><p>粘贴作品或博主主页；下载在后台执行，界面始终可以操作。</p></div>
        <div className="runtime-strip">
          <span className={runtime?.yt_dlp_available ? 'ok' : 'bad'}>{runtime?.yt_dlp_available ? <Check /> : <AlertCircle />}下载引擎</span>
          <span className={runtime?.ffmpeg_available ? 'ok' : 'bad'}>{runtime?.ffmpeg_available ? <Check /> : <AlertCircle />}媒体处理</span>
          <span className={installedModel ? 'ok' : ''}>{installedModel ? <Check /> : <PackageOpen />}多语言模型</span>
        </div>
      </section>

      {message && <div className="notice"><AlertCircle size={17} /><span>{message}</span><button type="button" onClick={() => setMessage(null)}><X size={15} /></button></div>}

      <section className="workspace">
        <form className="composer" onSubmit={startDownload}>
          <div className="mode-tabs">
            <button type="button" className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}><Link2 size={16} />单条</button>
            <button type="button" className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}><ListVideo size={16} />多链接批量</button>
            <button type="button" className={mode === 'profile' ? 'active' : ''} onClick={() => setMode('profile')}><UserRound size={16} />博主主页</button>
          </div>

          <label className="input-label" htmlFor="share-input">
            <span>{mode === 'profile' ? '主页 / 频道链接' : mode === 'batch' ? '作品链接或分享文案' : '视频链接或完整分享文案'}</span>
            <small>{mode === 'profile' ? '一个博主的全部公开视频' : mode === 'batch' ? '可以混合不同平台和博主' : '会自动识别中文分享文本中的链接'}</small>
          </label>
          <div className="link-input">
            <textarea
              id="share-input"
              rows={mode === 'batch' ? 6 : 3}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={mode === 'profile' ? '粘贴抖音 / TikTok / YouTube 等主页链接' : '长按复制此条消息，打开平台查看作品 https://...'}
            />
            <span>识别 {urls.length} 条</span>
          </div>

          {mode === 'profile' && (
            <label className="range-row"><span>读取数量</span><input type="number" min="1" max="500" value={profileLimit} onChange={(event) => setProfileLimit(Math.min(500, Math.max(1, Number(event.target.value))))} /><small>最多 500 条</small></label>
          )}

          <div className="options">
            <label><span>视频清晰度</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="best">自动最佳</option><option value="2160">最高 4K</option><option value="1440">最高 2K</option><option value="1080">最高 1080p</option><option value="720">最高 720p</option><option value="480">最高 480p</option></select></label>
            <label><span>文案提取</span><select value={transcriptMode} onChange={(event) => setTranscriptMode(event.target.value as TranscriptMode)}><option value="auto">字幕优先，AI 兜底</option><option value="ai">始终 AI 识别语音</option><option value="native">仅平台字幕</option><option value="none">不提取语音文案</option></select></label>
            <label><span>识别语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英语</option><option value="id">印尼语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="es">西班牙语</option></select></label>
            <label><span>识别模型</span><select value={modelId} onChange={(event) => { setModelId(event.target.value); window.localStorage.setItem('yinglian-model', event.target.value) }}>{runtime?.models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.installed ? ' · 已下载' : ` · ${formatBytes(model.size_bytes)}`}</option>)}</select></label>
            <label><span>中文翻译</span><select value={translationTarget} onChange={(event) => { const next = event.target.value as 'none' | 'zh'; setTranslationTarget(next); if (next === 'zh' && transcriptMode === 'none') setTranscriptMode('auto') }}><option value="none">不翻译</option><option value="zh">原文 + 中文 + 双语字幕</option></select></label>
          </div>

          <div className="checks">
            <label><input type="checkbox" checked={includeThumbnail} onChange={(event) => setIncludeThumbnail(event.target.checked)} />下载原始封面</label>
            <label><input type="checkbox" checked={includeDescription} onChange={(event) => setIncludeDescription(event.target.checked)} />保存标题、简介和话题</label>
          </div>

          <div className="destination">
            <div><FolderOpen size={16} /><span>{downloadDir || '正在读取下载目录'}</span></div>
            <button type="button" onClick={chooseDirectory}>更改作品位置</button>
          </div>
          <small className="destination-note">视频、封面、平台文案、字幕、语音识别和翻译文件都会保存到这里。</small>

          <button className="primary" type="submit" disabled={running || scanning || modelBusy || !toolsReady}>
            {running || scanning || modelBusy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
            {modelBusy ? '正在准备模型' : scanning ? '正在扫描主页' : running ? '队列处理中' : mode === 'profile' ? '扫描并全部下载' : mode === 'batch' ? `下载 ${urls.length} 条作品` : '开始下载'}
          </button>
        </form>

        <aside className="queue-panel">
          <div className="panel-heading"><div><span>LOCAL QUEUE</span><h2>本地任务</h2></div><b>{tasks.filter((task) => task.status === 'completed').length} / {tasks.length}</b></div>
          {!tasks.length ? (
            <div className="empty"><ListVideo size={34} /><strong>还没有任务</strong><p>下载开始后可以继续修改输入和选项，窗口不会卡住。</p></div>
          ) : (
            <div className="task-list">
              {tasks.map((task) => (
                <article className={`task ${task.status}`} key={task.id}>
                  <div className="task-head"><div className="task-icon">{task.status === 'completed' ? <Check /> : task.status === 'failed' ? <AlertCircle /> : <Video />}</div><div><strong>{task.title}</strong><span>{task.platform} · {statusLabel(task.status)}</span></div></div>
                  <div className="progress"><i style={{ width: `${task.percent}%` }} /></div>
                  <p>{task.message}</p>
                  <div className="task-actions">
                    {task.outputDir && <button type="button" onClick={() => invoke('open_directory', { path: task.outputDir })}><FolderOpen size={14} />打开文件夹</button>}
                    {['downloading', 'transcribing'].includes(task.status) && <button type="button" onClick={() => cancelTask(task)}><CircleStop size={14} />取消</button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>
      </section>

      {accountOpen && (
        <div className="modal-backdrop" onMouseDown={() => setAccountOpen(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setAccountOpen(false)}><X /></button><LogIn className="modal-mark" /><h2>平台官方登录</h2><p>公开内容不需要登录。遇到平台限制时，在官方窗口登录一次，会话只保存在本机。</p><div className="platform-grid">{LOGIN_PLATFORMS.map(([id, label]) => <button type="button" key={id} onClick={() => login(id)}><span>{label}</span><ChevronRight size={16} /></button>)}</div></section>
        </div>
      )}

      {modelsOpen && (
        <div className="modal-backdrop" onMouseDown={() => !modelBusy && setModelsOpen(false)}>
          <section className="modal model-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => !modelBusy && setModelsOpen(false)}><X /></button><Languages className="modal-mark" /><h2>多语言模型</h2><p>模型按需下载，不增加主安装包体积。支持自动识别中文、英语、印尼语等语言。</p>
            <div className="destination model-location"><div><FolderOpen size={16} /><span>{runtime?.model_dir || '正在读取模型目录'}</span></div><button type="button" disabled={modelBusy || translationBusy} onClick={chooseModelDirectory}>选择模型位置</button></div>
            {modelProgress && <div className="model-download"><div><span>{modelProgress.message}</span><b>{Math.round(modelProgress.percent)}%</b></div><div className="progress"><i style={{ width: `${modelProgress.percent}%` }} /></div><small>{formatBytes(modelProgress.downloaded)} / {formatBytes(modelProgress.total)}</small><button type="button" onClick={() => invoke('cancel_model_download')}>取消下载</button></div>}
            {translationBusy && <div className="model-download"><div><span>{translationProgress.message || '正在准备中文翻译模型'}</span><b>{Math.round(translationProgress.percent)}%</b></div><div className="progress"><i style={{ width: `${translationProgress.percent}%` }} /></div><small>模型约 {formatBytes(runtime?.translation_model_size_bytes || 646109073)}，只在首次使用时下载到所选模型位置</small></div>}
            <div className="model-list">{runtime?.models.map((model) => <article key={model.id}><div><strong>{model.name}</strong><span>{formatBytes(model.size_bytes)}{model.recommended ? ' · 默认推荐' : ''}</span></div>{model.installed ? <button type="button" className="danger" disabled={modelBusy} onClick={() => removeModel(model.id)}><Trash2 size={14} />删除</button> : <button type="button" disabled={modelBusy} onClick={() => installModel(model.id)}><Download size={14} />下载</button>}</article>)}</div>
            <div className="model-list translation-model"><article><div><strong>多语言 → 简体中文</strong><span>量化 M2M100 · 100 种语言 · {formatBytes(runtime?.translation_model_size_bytes || 646109073)}</span></div>{translationCached ? <button type="button" className="danger" disabled={translationBusy} onClick={removeTranslationModel}><Trash2 size={14} />删除</button> : <button type="button" disabled={translationBusy} onClick={prepareTranslation}><Download size={14} />下载</button>}</article></div>
            <div className="future-note"><Settings2 size={16} /><span>翻译在独立后台线程运行，不会阻塞下载队列或操作界面。</span></div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
