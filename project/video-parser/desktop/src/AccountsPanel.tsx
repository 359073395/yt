import React from 'react'
import { RefreshCw, X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { NetworkPanel } from './NetworkPanel'

export interface AccountStatus { platform: string; state: 'detected' | 'anonymous' | 'cached' | 'pending'; detail: string }
export const platforms = [['douyin', '抖音'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['bilibili', '哔哩哔哩'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['twitter', 'X / Twitter']]
const labels = { detected: '已检测到登录会话', anonymous: '未检测到登录', cached: '已保存 · 待同步', pending: '等待同步' }

export function AccountRows({ statuses, opening, onLogin }: { statuses: AccountStatus[]; opening: string | null; onLogin: (platform: string) => void }) {
  return <div className="account-list">{platforms.map(([id, name]) => {
    const status = statuses.find(s => s.platform === id)
    return <div key={id}><strong>{name}</strong><div className="account-state"><b data-state={status?.state || 'checking'}>{status ? labels[status.state] : '正在检查…'}</b><small>{status?.detail || '正在读取本机保存的会话'}</small></div><button disabled={opening !== null} onClick={() => onLogin(id)}>{opening === id ? '正在打开…' : '官方登录'}</button></div>
  })}</div>
}

export function AccountsPanel({ onClose }: { onClose: () => void }) {
  const [statuses, setStatuses] = React.useState<AccountStatus[]>([])
  const [busy, setBusy] = React.useState(false)
  const [opening, setOpening] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState('')
  const inFlight = React.useRef(false)
  const alive = React.useRef(true)
  const refresh = React.useCallback(async (force = false) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try { const rows = await invoke<AccountStatus[]>('account_statuses', { refresh: force }); if (alive.current) setStatuses(rows) }
    catch (error) { if (alive.current) setMessage(`状态检查失败：${String(error)}`) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }, [])
  React.useEffect(() => {
    alive.current = true
    void refresh()
    const timer = window.setInterval(() => void refresh(), 6000)
    const focus = () => { void refresh(true) }
    window.addEventListener('focus', focus)
    return () => { alive.current = false; window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [refresh])
  const login = async (platform: string) => {
    setOpening(platform)
    try { const detail = await invoke<string>('launch_login', { platform }); if (alive.current) setMessage(detail) }
    catch (error) { if (alive.current) setMessage(String(error)) }
    finally { if (alive.current) { setOpening(null); void refresh(true) } }
  }
  return <div className="modal-backdrop"><section className="modal accounts-modal" aria-label="平台账号"><button className="modal-close" aria-label="关闭账号窗口" onClick={onClose}><X /></button><h2>平台账号</h2><p>在官方窗口完成登录后，请关闭该窗口。这里会自动同步并显示各平台状态，无需导入 Cookie。</p><NetworkPanel /><p className="account-note">会话仅加密保存在本机。“检测到登录”不代表平台已验证有效；视频权限和风控仍以平台响应为准。</p><button className="account-refresh" disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={16} />{busy ? '正在检查状态…' : '刷新状态'}</button>{message && <p role="status">{message}</p>}<AccountRows statuses={statuses} opening={opening} onLogin={id => void login(id)} /></section></div>
}
