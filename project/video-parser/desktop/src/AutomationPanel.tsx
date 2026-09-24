import React from 'react'
import './automation.css'
import { invoke } from '@tauri-apps/api/core'
import { FolderOpen, LoaderCircle, Plus, Radio, Rss } from 'lucide-react'
import { extractSharedUrls } from './core'
import { normalizeCategory } from './library'
import { emptyAutomation, recordingActive, type AutomationSnapshot } from './automation'

export function useAutomation() {
  const [snapshot, setSnapshot] = React.useState(emptyAutomation)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let disposed = false
    let timer: number | undefined
    async function poll() {
      try {
        const next = await invoke<AutomationSnapshot>('automation_snapshot')
        if (!disposed) { setSnapshot(next); setError(next.error) }
      } catch (reason) { if (!disposed) setError(String(reason)) }
      if (!disposed) timer = window.setTimeout(poll, 2000)
    }
    void poll()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [])
  return { snapshot, error }
}
const time = (value: number) => value ? new Date(value * 1000).toLocaleString() : '尚未检查'
const statusLabel: Record<string, string> = { resolving: '连接中', recording: '录制中', stopping: '正在收尾', completed: '已保存', partial: '部分保存', failed: '录制失败', cancelled: '已取消', interrupted: '录制中断' }

export function AutomationPanel({ view, snapshot, error, root, category, chooseRoot, showTasks, waiting }: {
  view: 'subscriptions' | 'live'; snapshot: AutomationSnapshot; error: string; root: string; category: string
  chooseRoot: () => void; showTasks: () => void; waiting: boolean
}) {
  const [url, setUrl] = React.useState('')
  const [name, setName] = React.useState('')
  const [folder, setFolder] = React.useState(category === '*' ? '待分类' : category)
  const [interval, setInterval] = React.useState(60)
  const [limit, setLimit] = React.useState(50)
  const [existing, setExisting] = React.useState(false)
  const [auto, setAuto] = React.useState(false)
  const [minutes, setMinutes] = React.useState(60)
  const [maxGb, setMaxGb] = React.useState(4)
  const [busy, setBusy] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const subscriptions = view === 'subscriptions'
  async function command(key: string, operation: () => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(key); setNotice('')
    try { await operation(); setNotice(message) } catch (reason) { setNotice(String(reason)) }
    finally { setBusy('') }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault()
    void command('add', async () => {
      const links = extractSharedUrls(url)
      if (links.length !== 1) throw new Error('请粘贴一个主页或直播间链接，可包含中文分享文案')
      const cleaned = normalizeCategory(folder)
      if (subscriptions) await invoke('subscription_add', { request: { url: links[0], name: name.trim(), category: cleaned, interval_minutes: interval, limit, include_existing: existing, auto_download: auto } })
      else await invoke('live_start', { request: { url: links[0], name: name.trim(), category: cleaned, root, minutes, max_gb: maxGb } })
      setUrl(''); setName('')
    }, subscriptions ? '订阅已保存，后台将开始首次检查。' : '录制任务已创建，连接结果会显示在下方。')
  }
  return <section className="automation-workspace">
    <header className="automation-heading"><div>{subscriptions ? <Rss /> : <Radio />}<h1>{subscriptions ? '博主订阅' : '直播录制'}</h1></div><p>{subscriptions ? '定时检查公开主页，只收新作品。软件退出或电脑休眠时不检查。' : '录制正在开播的公开直播间；原流保存，不重新压制画质。'}</p></header>
    {(error || notice) && <div className="automation-notice" role="status">{error || notice}</div>}
    <form className="automation-form" onSubmit={submit}>
      <label className="automation-url">{subscriptions ? '主页链接 / 分享文案' : '直播间链接 / 分享文案'}<textarea required rows={2} value={url} onChange={e => setUrl(e.target.value)} placeholder={subscriptions ? '粘贴博主主页、频道或播放列表链接' : '例如 https://live.douyin.com/房间号'} /></label>
      <div className="automation-fields">
        <label>{subscriptions ? '订阅名称' : '直播备注'}<input required={subscriptions} maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="例如：美妆参考" /></label>
        <label>分类文件夹<input value={folder} onChange={e => setFolder(e.target.value)} maxLength={180} required /></label>
        {subscriptions ? <><label>检查间隔<select value={interval} onChange={e => setInterval(Number(e.target.value))}><option value={15}>每 15 分钟</option><option value={60}>每小时</option><option value={360}>每 6 小时</option><option value={1440}>每天</option></select></label><label>每次扫描<select value={limit} onChange={e => setLimit(Number(e.target.value))}><option value={20}>最近 20 条</option><option value={50}>最近 50 条</option><option value={200}>最近 200 条</option><option value={500}>最近 500 条</option></select></label></> : <><label>最多录制<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}><option value={5}>5 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={180}>3 小时</option><option value={360}>6 小时</option></select></label><label>容量上限<select value={maxGb} onChange={e => setMaxGb(Number(e.target.value))}><option value={1}>1 GB</option><option value={4}>4 GB</option><option value={10}>10 GB</option><option value={50}>50 GB</option></select></label></>}
      </div>
      <div className="automation-path"><span>保存根目录</span><button type="button" className="path-control" onClick={chooseRoot} title={root}><span>{root || '请选择保存位置'}</span><FolderOpen size={19} /><span>更改</span></button></div>
      {subscriptions ? <><div className="automation-checks"><label><input type="checkbox" checked={existing} onChange={e => setExisting(e.target.checked)} />首次补下扫描到的已有作品</label><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />新作品自动下载</label></div><p className="automation-help">不勾选补下时，首次只建立基线。自动下载沿用“视频任务”的画质、输出、模型与保存根目录；需要的模型未就绪时只收录，不重复弹窗。超出扫描范围的作品可能遗漏。</p></> : <p className="automation-help">每 10 分钟保存一段 MKV，最多同时录制 2 路。抖音请使用直播间完整链接；其他平台由下载引擎尝试解析。未开播、风控或需要额外权限会明确报错，不保证所有平台直播可录。</p>}
      <div className="automation-submit"><button className="primary" type="submit" disabled={!!busy || !!error || !root}>{busy === 'add' ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}{subscriptions ? '添加订阅' : '开始录制'}</button>{subscriptions && <button type="button" onClick={showTasks}>查看收录的视频</button>}<span>{subscriptions ? '关闭窗口可留在托盘继续检查；退出程序则停止。' : '停止后保留已录文件，可直接打开对应文件夹。'}</span></div>
    </form>
    {subscriptions && waiting && <div className="automation-notice">有自动下载作品等待处理。请在视频任务确认输出内容、保存路径和模型配置。</div>}
    <div className="automation-records">
      {subscriptions ? snapshot.subscriptions.length ? snapshot.subscriptions.map(s => <article key={s.id}><div className="automation-record-title"><h2>{s.name}</h2><span className={s.enabled ? 'enabled' : ''}>{s.checking ? '检查中' : s.enabled ? '订阅中' : '已暂停'}</span></div><p className="automation-source" title={s.url}>{s.url}</p><p>{s.category} · 每 {s.interval_minutes} 分钟 · 最近 {s.limit} 条 · {s.auto_download ? '自动下载' : '只加入队列'}</p><p>{s.detail}</p><small>上次：{time(s.last_checked)}{s.enabled && s.next_check > 0 ? ` · 下次：${time(s.next_check)}` : ''}</small><div className="automation-record-actions"><button disabled={!!busy || !s.enabled || s.checking} onClick={() => void command(s.id, () => invoke('subscription_action', { id: s.id, action: 'check' }), '已安排立即检查')}>立即检查</button><button disabled={!!busy} onClick={() => void command(s.id, () => invoke('subscription_action', { id: s.id, action: 'toggle' }), s.enabled ? '已暂停订阅' : '已恢复订阅')}>{s.enabled ? '暂停' : '恢复'}</button><button disabled={!!busy} onClick={() => { if (window.confirm(`移除“${s.name}”订阅？已收录和已下载的视频不会删除。`)) void command(s.id, () => invoke('subscription_action', { id: s.id, action: 'remove' }), '已移除订阅，已有视频保留') }}>移除订阅</button></div></article>) : <div className="automation-empty"><Rss /><h2>还没有订阅</h2><p>添加博主主页后，在这里查看检查状态和新增作品。</p></div> : snapshot.recordings.length ? snapshot.recordings.map(r => <article key={r.id}><div className="automation-record-title"><h2>{r.name}</h2><span className={recordingActive(r.status) ? 'enabled' : ''}>{statusLabel[r.status] || r.status}</span></div><p className="automation-source" title={r.url}>{r.url}</p><div className="recording-metrics"><strong>{Math.floor(r.elapsed / 60)}:{String(r.elapsed % 60).padStart(2, '0')}<small>录制时长</small></strong><strong>{(r.bytes / 1024 / 1024).toFixed(1)} MB<small>已写入文件</small></strong></div>{['failed', 'partial', 'interrupted'].includes(r.status) ? <details className="automation-record-detail"><summary>查看原因与处理提示</summary><p>{r.detail}</p></details> : <p className="automation-help">{r.detail}</p>}<p className="automation-source" title={r.output_dir}>{r.output_dir}</p><div className="automation-record-actions">{recordingActive(r.status) && <button disabled={!!busy} onClick={() => void command(r.id, () => invoke('live_stop', { id: r.id }), '停止请求已发送，正在保存录制文件')}>停止录制</button>}<button onClick={() => void command(r.id, () => invoke('open_directory', { path: r.output_dir }), '')}><FolderOpen size={16} />打开文件夹</button></div></article>) : <div className="automation-empty"><Radio /><h2>还没有录制任务</h2><p>添加一个正在开播的直播间，录制状态会出现在这里。</p></div>}
    </div>
  </section>
}
