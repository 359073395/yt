import React from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface NetworkConfig { mode: 'system' | 'direct' | 'manual'; address: string; overseas_only: boolean }
export const defaultNetwork: NetworkConfig = { mode: 'system', address: 'http://127.0.0.1:10808', overseas_only: true }

export function NetworkFields({ value, disabled, onChange }: { value: NetworkConfig; disabled: boolean; onChange: (value: NetworkConfig) => void }) {
  return <fieldset disabled={disabled} className="network-fields"><label>连接方式<select aria-label="代理连接方式" value={value.mode} onChange={e => onChange({ ...value, mode: e.target.value as NetworkConfig['mode'] })}><option value="system">跟随本机系统代理</option><option value="manual">手动连接 v2rayN / 本机代理</option><option value="direct">关闭代理（直连）</option></select></label>
    {value.mode === 'manual' && <label>HTTP / 混合代理地址<input aria-label="本机 HTTP 代理地址" value={value.address} onChange={e => onChange({ ...value, address: e.target.value })} placeholder="http://127.0.0.1:10808" spellCheck={false} /></label>}
    <label className="network-scope"><input type="checkbox" checked={value.overseas_only} onChange={e => onChange({ ...value, overseas_only: e.target.checked })} />仅海外平台使用代理，抖音 / 哔哩哔哩直连</label>
  </fieldset>
}

export function NetworkPanel() {
  const [value, setValue] = React.useState(defaultNetwork)
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')
  const alive = React.useRef(true)
  const inFlight = React.useRef(false)
  React.useEffect(() => {
    alive.current = true
    void invoke<NetworkConfig>('network_settings').then(v => { if (alive.current) { setValue(v); setReady(true) } }).catch(e => { if (alive.current) setMessage(`代理配置读取失败：${String(e)}`) })
    return () => { alive.current = false }
  }, [])
  const run = async (name: string, work: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(name); setMessage('')
    try { await work() } catch (e) { if (alive.current) setMessage(String(e)) }
    finally { inFlight.current = false; if (alive.current) setBusy('') }
  }
  const disabled = !ready || !!busy
  return <details className="network-panel"><summary>网络代理 · v2rayN</summary><p>解析、视频下载和直播录制使用同一网络配置；只影响工坊新任务，不修改系统设置、飞书连接或 AI 接口。官方登录窗口需关闭后重新打开。</p>
    <NetworkFields value={value} disabled={disabled} onChange={v => { setValue(v); setMessage('配置已修改，尚未保存') }} />
    <p>使用 v2rayN 的 HTTP / 混合端口，不是 SOCKS 专用端口。默认示例为 10808，请以你的软件显示为准。系统模式仅识别本机 HTTP 代理，不支持 PAC。</p>
    <div className="network-actions"><button disabled={disabled} onClick={() => void run('detect', async () => { const address = await invoke<string>('detect_local_proxy'); if (alive.current) { setValue(v => ({ ...v, mode: 'manual', address })); setMessage('已读取本机地址，请测试并保存') } })}>{busy === 'detect' ? '读取中…' : '读取本机代理'}</button><button disabled={disabled} onClick={() => void run('test', async () => { const result = await invoke<string>('test_network_proxy', { request: value }); if (alive.current) setMessage(result) })}>{busy === 'test' ? '测试中（最多约 12 秒）…' : '测试 TikTok 连接'}</button><button disabled={disabled} onClick={() => void run('save', async () => { const saved = await invoke<NetworkConfig>('save_network_settings', { request: value }); if (alive.current) { setValue(saved); setMessage('代理已保存，对下一次解析、下载和录制生效') } })}>{busy === 'save' ? '保存中…' : '保存代理'}</button></div>
    {message && <p role="status">{message}</p>}
  </details>
}
