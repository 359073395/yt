import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, Check, FolderOpen, LoaderCircle, Monitor, Pencil, RefreshCw, Search, Smartphone, X } from 'lucide-react'
import type { DownloadResult, ProgressEvent, RuntimeInfo, TranslationProvider } from './core'
import { finishTranslation } from './translation-job'
import { preloadTranslationModel } from './translator'
import { FeishuBinding, type Pair, type Registration } from './FeishuBinding'
import './team.css'

interface TeamConfig {
  app_id: string; device_name: string; root: string; enabled: boolean; copy: boolean; provider: TranslationProvider;
  model_id: string; quality: string; language: string; subtitle: boolean; transcript_mode: string;
  onboarding: boolean; owner?: string;
  session: { device_id?: string; user_name?: string; device_name?: string;  } | null;
}
interface InboxJob {
  id: string; category: string; note: string; url: string; stage: string; detail: string; created: number;
  result?: DownloadResult; provider: TranslationProvider; copy: boolean;
}
export interface Snapshot { config: TeamConfig; jobs: InboxJob[]; error: string; busy: boolean; connection: string; pair: Pair | null; registration: Registration | null }
const names: Record<string, string> = { queued: '已收录 · 待下载', downloading: '下载中', archiving: '正在归档', downloaded: '视频已保存 · 待生成文案', preparing: '提取文案', text_ready: '翻译中', completed: '已完成', partial: '文案待重试', failed: '下载失败' }

export function AutoDownloadControl({ enabled, busy, onToggle, compact = false }: { enabled: boolean; busy: boolean; onToggle: () => void; compact?: boolean }) {
  return <button type="button" className={`team-auto-toggle${enabled ? ' is-on' : ''}`} role="switch" aria-label="飞书自动下载" aria-checked={enabled} disabled={busy} onClick={onToggle}>
    <span className="team-auto-track" aria-hidden="true"><i /></span>
    {compact ? '自动下载' : enabled ? '自动下载已开启 · 点击暂停' : '开启自动下载'}
  </button>
}

export function TeamInbox({ open, onClose, runtime, defaultDir, provider, modelId, onSnapshot }: {
  open: boolean; onClose: () => void; runtime: RuntimeInfo | null; defaultDir: string; provider: TranslationProvider; modelId: string; onSnapshot?: (snapshot: Snapshot) => void;
}) {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [draft, setDraft] = React.useState<TeamConfig | null>(null)
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [settings, setSettings] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [category, setCategory] = React.useState('全部')
  const [editing, setEditing] = React.useState<InboxJob | null>(null)
  const [progress, setProgress] = React.useState<Record<string, ProgressEvent>>({})
  React.useEffect(() => { if (snapshot) onSnapshot?.(snapshot) }, [snapshot, onSnapshot])
  const translating = React.useRef(false)
  const polling = React.useRef(false)
  const runtimeRef = React.useRef(runtime); runtimeRef.current = runtime

  React.useEffect(() => {
    if (!snapshot?.config.enabled || !navigator.locks) return
    let release: () => void = () => undefined
    let cancelled = false
    void navigator.locks.request('yinglian-inbox-background', async () => {
      if (cancelled) return
      await new Promise<void>(resolve => { release = resolve })
    })
    return () => { cancelled = true; release() }
  }, [snapshot?.config.enabled])

  React.useEffect(() => {
    let mounted = true
    const refresh = async () => {
      if (polling.current) return
      polling.current = true
      try {
        const s = await invoke<Snapshot>('team_snapshot')
        if (!mounted) return
        setSnapshot(s)
        setDraft(current => current || { ...s.config, root: s.config.root || defaultDir, provider: s.config.session ? s.config.provider : provider, model_id: s.config.session ? s.config.model_id : modelId })
        const job = s.jobs.find(j => j.copy && j.provider === 'local' && ['downloaded', 'text_ready'].includes(j.stage))
        if (s.config.enabled && job && !translating.current && runtimeRef.current) {
          translating.current = true
          void (async () => {
            try {
              const result = await invoke<DownloadResult>('team_prepare_text', { id: job.id })
              const outcome = await finishTranslation(result, {
                target: 'zh', provider: job.provider, modelBaseUrl: runtimeRef.current!.model_server_url,
                ready: job.provider === 'local' ? (runtimeRef.current!.translation_model_installed ? preloadTranslationModel(runtimeRef.current!.model_server_url) : Promise.reject(new Error('请在“模型”中下载本地翻译模型，或选择 AI 接口后重试'))) : null,
              }, (percent, detail) => setProgress(p => ({ ...p, [job.id]: { job_id: job.id, phase: 'transcribing', percent, message: detail } })))
              await invoke('team_text_done', { id: job.id, status: outcome.status === 'completed' ? 'completed' : 'partial', detail: outcome.message })
            } catch (e) {
              await invoke('team_text_done', { id: job.id, status: 'partial', detail: `视频已保存；${String(e)}` }).catch(() => undefined)
            } finally { translating.current = false }
          })()
        }
      } catch (e) { if (mounted) setMessage(String(e)) }
      finally { polling.current = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2500)
    const cleanup = listen<ProgressEvent>('job-progress', ({ payload }) => {
      if (payload.job_id.startsWith('team-')) setProgress(p => ({ ...p, [payload.job_id.slice(5)]: payload }))
    })
    return () => { mounted = false; window.clearInterval(timer); void cleanup.then(fn => fn()) }
  }, [defaultDir, provider, modelId])

  async function run(work: () => Promise<void>) { setBusy(true); setMessage(''); try { await work() } catch (e) { setMessage(String(e)) } finally { setBusy(false) } }
  async function refresh() { const s = await invoke<Snapshot>('team_snapshot'); setSnapshot(s); setDraft({ ...s.config, root: s.config.root || defaultDir }) }
  async function save(enabled: boolean, source = draft) {
    if (!source) return
    await invoke('team_save', { config: { ...source, root: source.root || defaultDir, enabled } }); await refresh(); setSettings(false)
    setMessage(enabled ? '自动下载已开启。关闭窗口后仍在托盘收件；退出软件或关机时不下载。历史消息补收取决于飞书权限及保留范围。' : '已暂停自动下载，仍接收链接并保存到本机队列；正在处理的任务会继续完成。')
  }
  async function edit(body: object) { await invoke('team_action', { action: 'edit', body }); setEditing(null); setMessage('已保存，文件会在当前任务处理完成后归入对应分类。') }
  const jobs = [...(snapshot?.jobs || [])].sort((a, b) => b.created - a.created)
  const categories = ['全部', ...new Set(jobs.map(j => j.category))]
  const shown = jobs.filter(j => (category === '全部' || j.category === category) && `${j.result?.title || ''} ${j.result?.uploader || ''} ${j.note || ''} ${j.category}`.toLowerCase().includes(search.toLowerCase()))
  const paired = Boolean(snapshot?.config.session?.device_id) && !snapshot?.config.onboarding
  const setupVisible = !paired || settings
  const pair = snapshot?.pair
  const registering = ['starting', 'waiting'].includes(snapshot?.registration?.status || '')
  React.useEffect(() => { if (paired && !snapshot?.config.enabled) setSettings(true) }, [paired, snapshot?.config.enabled])
  async function bindingAction(action: 'start' | 'cancel' | 'open' | 'disconnect' | 'renew_pair' | 'confirm_pair') {
    await run(async () => {
      if (action === 'start') {
        if (!draft) return
        await invoke('team_save', { config: { ...draft, root: draft.root || defaultDir, enabled: false } })
        await invoke('team_register', { deviceName: draft.device_name })
      } else if (action === 'cancel') await invoke('team_cancel_register')
      else if (action === 'open') await invoke('team_open_registration')
      else if (action === 'confirm_pair') { await invoke('team_confirm_pair'); setSettings(true) }
      else await invoke('team_action', { action, body: {} })
      await refresh()
    })
  }

  return <section className="team-inbox" style={{ display: open ? undefined : 'none' }} aria-label="飞书收件箱">
    <header className="team-heading"><div><button onClick={onClose} aria-label="返回手动下载"><ArrowLeft size={20} /></button><div><h1>飞书收件箱</h1><p>{paired ? `${snapshot?.config.session?.user_name} · ${snapshot?.config.session?.device_name}` : '手机随手发，视频自动保存到你的电脑'}</p></div></div><div className="team-heading-actions">{paired && <><span className="team-connection">{snapshot?.connection || '未连接'}</span><AutoDownloadControl enabled={Boolean(snapshot?.config.enabled)} busy={busy} onToggle={() => void run(() => save(!snapshot?.config.enabled, setupVisible ? draft : snapshot!.config))} /><button onClick={() => { setDraft(snapshot!.config); setSettings(s => !s) }}>{settings ? '查看收件队列' : '保存位置与选项'}</button></>}</div></header>
    {(message || snapshot?.error) && <div className="team-notice" role="status">{message || snapshot?.error}<button onClick={() => setMessage('')} aria-label="关闭提示"><X size={16} /></button></div>}
    {setupVisible ? <div className="team-setup">
      <div className="team-setup-main">
        <h2><Monitor size={21} />{paired ? '我的飞书与保存位置' : '连接我的飞书机器人'}</h2>
        <p>每人使用独立机器人，直接连接自己的电脑，不需要公司中转地址。</p>
        {!paired && <>
          <label>电脑名称<input value={draft?.device_name || ''} maxLength={80} placeholder="例如：小李的办公电脑" disabled={registering || Boolean(snapshot?.config.app_id)} onChange={e => setDraft(d => d && ({ ...d, device_name: e.target.value }))} /></label>
          {!snapshot?.config.app_id && <button className="team-primary" disabled={busy || registering || !draft?.device_name} onClick={() => void bindingAction('start')}>{registering ? <LoaderCircle className="spin" size={17} /> : <Smartphone size={17} />}{registering ? '等待扫码确认…' : '一键绑定飞书'}</button>}
          <p className="team-hint">授权在飞书官方页面完成，应用凭证自动加密保存在这台电脑。</p>
        </>}
        <label>视频保存位置<div className="team-path"><span title={draft?.root || defaultDir}>{draft?.root || defaultDir || '请选择文件夹'}</span><button disabled={busy} onClick={() => void run(async () => { const dir = await invoke<string | null>('choose_download_dir'); if (dir) setDraft(d => d && ({ ...d, root: dir })) })}><FolderOpen size={17} />选择</button></div></label>
        <p className="team-hint">这里保存视频、封面和文案；不是模型目录。模型位置在顶部“模型”中管理。</p>
        {paired && <div className="team-settings-actions"><button className="team-primary" disabled={busy} onClick={() => void run(() => save(true))}>{snapshot?.config.enabled ? '保存收件设置' : '保存并开启自动下载'}</button></div>}
        <details className="team-download-options" open={paired}><summary>下载选项与模型</summary><div className="team-options"><label><input type="checkbox" checked={draft?.copy ?? true} onChange={e => setDraft(d => d && ({ ...d, copy: e.target.checked }))} />保存双语文案</label><label><input type="checkbox" checked={draft?.subtitle ?? true} onChange={e => setDraft(d => d && ({ ...d, subtitle: e.target.checked }))} />有原版字幕时保留</label></div>
        <div className="team-option-grid">
          <label>翻译方式<select value={draft?.provider || provider} onChange={e => setDraft(d => d && ({ ...d, provider: e.target.value as TranslationProvider }))}><option value="api">AI 接口</option><option value="local">本地翻译</option></select></label>
          <label>语音识别<select value={draft?.model_id || modelId} onChange={e => setDraft(d => d && ({ ...d, model_id: e.target.value }))}>{(runtime?.models || []).map(m => <option key={m.id} value={m.id}>{m.name}{m.installed ? '' : '（未下载）'}</option>)}</select></label>
          <label>视频画质<select value={draft?.quality || '1080'} onChange={e => setDraft(d => d && ({ ...d, quality: e.target.value }))}><option value="best">最高画质</option><option value="2160">4K</option><option value="1080">1080P</option><option value="720">720P</option></select></label>
        </div>
        <p className="team-hint">视频和封面先保存，双语文案随后处理。AI 接口与本地模型沿用顶部“模型”的配置。</p></details>
      </div>
      <aside className="team-pair-panel">
        {!paired ? <FeishuBinding registration={snapshot?.registration || null} configured={Boolean(snapshot?.config.app_id)} ownerKnown={Boolean(snapshot?.config.owner)} pair={pair || null} connection={snapshot?.connection || ''} busy={busy} onAction={action => void bindingAction(action)} /> : <><Check className="team-paired-icon" /><h2>{snapshot?.config.session?.user_name}</h2><p>{snapshot?.config.session?.device_name}</p><p>只接收已绑定账号与此机器人的私聊。群聊、其他员工和机器人发来的消息不会触发下载。</p><code>视频链接或分享文案<br />分类 美妆/口播参考<br />备注 这个开头很好</code><p>分类可放在文案末尾，不必输入冒号。把同一个链接带新分类再发一次，就会更新归档，不重复下载。也可以回复原消息补写分类。</p><p>只写“备注 好开头”会保存到“好开头”文件夹；不写分类或备注则放入“待分类”。</p><button disabled={busy || snapshot?.busy} onClick={() => void bindingAction('disconnect')}>解除本机配对（保留文件）</button></>}
        {paired && <p className="team-hint">电脑离线时不会下载。重新运行后会尝试补收绑定后、仍可读取的私聊历史；链接失效或历史不可读取时无法补救。</p>}
      </aside>
    </div> : <><div className="team-library-toolbar"><div className="team-search"><Search size={18} /><input aria-label="搜索视频" placeholder="搜索标题、博主、备注" value={search} onChange={e => setSearch(e.target.value)} /></div><select aria-label="按分类筛选" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select><span>{shown.length} 条视频</span></div><div className="team-library">
      {!shown.length && <div className="team-empty"><Smartphone size={42} /><h2>现在就可以从手机发视频了</h2><p>将链接或整段分享文案发给自己的机器人。</p><p>末尾加“分类 润唇膏”即可自动归档，支持有无冒号。</p><small>这台电脑：{snapshot?.config.session?.device_name} · {snapshot?.config.root}</small></div>}
      {shown.map(j => <article className="team-card" key={j.id}><div className="team-cover">{j.result?.thumbnail ? <img src={j.result.thumbnail} alt={j.result.title} loading="lazy" /> : <Smartphone size={30} />}</div><div className="team-card-content"><div className="team-card-title"><h3 title={j.result?.title || j.url}>{j.result?.title || (j.stage === 'queued' ? '已收录视频链接' : '正在读取视频信息')}</h3><button aria-label="修改分类和备注" onClick={() => setEditing(j)}><Pencil size={17} /></button></div><small>{j.result?.platform || '视频'} · {j.result?.uploader || ''}</small><span className="team-category">{j.category}</span>{j.note && <p className="team-note">{j.note}</p>}<div className={`team-card-status ${j.stage}`}><span>{names[j.stage] || j.stage}{j.stage === 'downloading' && progress[j.id] ? ` ${Math.round(progress[j.id].percent)}%` : ''}</span>{j.result?.output_dir && <button onClick={() => void run(async () => { await invoke('open_directory', { path: j.result!.output_dir }) })}><FolderOpen size={16} />打开文件夹</button>}{['failed', 'partial'].includes(j.stage) && <button onClick={() => void run(() => edit({ id: j.id, retry: true }))}><RefreshCw size={15} />重试</button>}</div>{['partial', 'failed'].includes(j.stage) && <p className="team-job-error">{j.detail}</p>}</div></article>)}
    </div></>}
    {editing && <div className="modal-backdrop"><form className="team-edit" onSubmit={e => { e.preventDefault(); void run(() => edit({ id: editing.id, category: editing.category, note: editing.note })) }}><h2>分类与备注</h2><label>分类<input required maxLength={60} value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} /></label><label>备注<textarea maxLength={1000} value={editing.note || ''} onChange={e => setEditing({ ...editing, note: e.target.value })} /></label><p>已保存的视频会自动移动到对应分类文件夹。</p><div><button type="button" onClick={() => setEditing(null)}>取消</button><button className="team-primary" disabled={busy}>保存</button></div></form></div>}
  </section>
}
