import { invoke } from '@tauri-apps/api/core'
import { Radio } from 'lucide-react'
import { recordingActive, type AutomationSnapshot } from './automation'

const time = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleString() : '尚未检查'

export function LiveMonitors({ snapshot, busy, command }: {
  snapshot: AutomationSnapshot
  busy: boolean
  command: (key: string, operation: () => Promise<unknown>, message: string) => Promise<void>
}) {
  const active = new Set(snapshot.recordings.filter(r => recordingActive(r.status)).map(r => r.id))
  return <section aria-label="开播监控列表">
    <h2 className="automation-section-title">开播监控 · {snapshot.monitors.length}</h2>
    <div className="automation-records">
      {snapshot.monitors.length === 0 ? <div className="automation-empty"><Radio /><h2>还没有开播监控</h2><p>添加 TikTok 或抖音主页后，无需手动守候开播。</p></div> : snapshot.monitors.map(m => {
        const recording = active.has(m.recording_id)
        return <article key={m.id}>
          <div className="automation-record-title"><h2>{m.request.name}</h2><span className={m.enabled ? 'enabled' : ''}>{!m.enabled ? '已暂停' : recording ? '自动录制中' : m.checking ? '检查中' : '监控中'}</span></div>
          <p className="automation-source" title={m.request.url}>{m.request.url}</p>
          <p>{m.request.category} · 每 {m.interval_seconds / 60} 分钟检查<br />每场最多 {m.request.minutes} 分钟 / {m.request.max_gb} GB</p>
          <p>{recording ? '正在录制，进度和文件见下方录制记录。' : m.detail}</p>
          <small>上次检查：{time(m.last_checked)}{m.enabled && !recording && !m.checking && m.next_check > 0 ? ` · 下次：${time(m.next_check)}` : ''}</small>
          <p className="automation-source" title={m.request.root}>保存到：{m.request.root}</p>
          <div className="automation-record-actions">
            <button disabled={busy || !m.enabled || m.checking || recording} onClick={() => void command(m.id, () => invoke('live_monitor_action', { id: m.id, action: 'check' }), '已安排立即检查')}>立即检查</button>
            <button disabled={busy} onClick={() => void command(m.id, () => invoke('live_monitor_action', { id: m.id, action: 'toggle' }), m.enabled ? '监控已暂停，本次录制会停止并保留文件' : '已恢复监控')}>{m.enabled ? '暂停监控' : '恢复监控'}</button>
            <button disabled={busy} onClick={() => {
              if (window.confirm(`移除“${m.request.name}”开播监控？正在录制的任务会停止，已有文件和记录会保留。`)) void command(m.id, () => invoke('live_monitor_action', { id: m.id, action: 'remove' }), '监控已移除，已有文件保留')
            }}>移除监控</button>
          </div>
        </article>
      })}
    </div>
  </section>
}
