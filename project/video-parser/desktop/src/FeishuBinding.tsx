import React from 'react'
import { Check, ExternalLink, LoaderCircle, QrCode, RefreshCw, X } from 'lucide-react'

export interface Registration {
  status: 'starting' | 'waiting' | 'authorized' | 'expired' | 'cancelled' | 'failed'
  message: string; qr: string; expires: number
}
export interface Pair { code: string; expires: number; expired: boolean; pending_owner?: string }

export function FeishuBinding({ registration, configured, ownerKnown, pair, connection, busy, onAction }: {
  registration: Registration | null; configured: boolean; ownerKnown: boolean; pair: Pair | null; connection: string; busy: boolean;
  onAction: (action: 'start' | 'cancel' | 'open' | 'disconnect' | 'renew_pair' | 'confirm_pair') => void;
}) {
  const [now, setNow] = React.useState(Date.now)
  const waiting = registration?.status === 'waiting' || registration?.status === 'starting'
  React.useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])
  const seconds = Math.max(0, Math.ceil(((registration?.expires || 0) - now) / 1000))
  const expired = waiting && seconds === 0
  if (configured) return <>
    <Check className="team-paired-icon" /><h2>授权已保存 · 等待收件验证</h2>
    <p role="status">{connection || '正在连接飞书…'}</p>
    {pair ? <>
      <p>飞书未返回扫码人的账号信息，需要一次配对确认。在新机器人私聊中发送：</p>
      <code>配对 {pair.code}</code>
      <small>{pair.expired ? '配对码已过期，请重新生成。' : '配对码有效期 10 分钟，仅使用一次。'}</small>
      {pair.pending_owner && !pair.expired ? <><p>已收到账号 {pair.pending_owner} 的配对消息。</p><button className="team-primary" disabled={busy} onClick={() => onAction('confirm_pair')}>确认是我的账号</button></> : null}
      <button disabled={busy} onClick={() => onAction('renew_pair')}>重新生成配对码</button>
    </> : <>
      <p>在飞书打开刚创建的“你的视频助手”，回复<strong>连接测试</strong>或发送视频链接。收到你的消息后，电脑才显示绑定完成。</p>
      <small>机器人会主动发连接提示；没有收到时，可以在飞书搜索它。企业要求审批时，需先完成审批。无需重复创建。</small>
      {!ownerKnown && <button disabled={busy} onClick={() => onAction('renew_pair')}>恢复配对码验证</button>}
    </>}
    <button disabled={busy} onClick={() => onAction('disconnect')}>解除本机配置（不删除飞书机器人）</button>
  </>
  return <>
    <h2><QrCode size={24} />飞书扫码，一次绑定</h2>
    {!waiting && <p>创建你自己的视频助手，无需查找任何 ID，也无需安装额外助手。</p>}
    {waiting && !expired ? <>
      {registration?.qr ? <img className="team-auth-qr" src={registration.qr} alt="飞书官方创建机器人授权二维码" /> : <div className="team-qr-loading"><LoaderCircle className="spin" size={28} /><span>正在获取官方二维码…</span></div>}
      <p role="status" aria-live="polite">{registration?.message}</p>
      {registration?.qr ? <small>剩余 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒 · 用飞书扫一扫</small> : null}
      <div className="team-bind-actions">{registration?.qr ? <button disabled={busy} onClick={() => onAction('open')}><ExternalLink size={16} />在浏览器打开官方授权页</button> : null}<button disabled={busy} onClick={() => onAction('cancel')}><X size={16} />取消本次绑定</button></div>
    </> : registration ? <>
      <p role="status">{expired ? '二维码已过期，请重新生成' : registration.message}</p>
      <button disabled={busy} onClick={() => onAction('start')}><RefreshCw size={16} />重新生成二维码</button>
    </> : <ol className="team-guide"><li>点击左侧“一键绑定飞书”。</li><li>手机飞书扫码，在官方页面确认创建及授权。</li><li>回复机器人验证收件，选好保存位置后开启自动下载。</li></ol>}
    <details className="team-auth-info"><summary>授权范围与使用说明</summary><p>只申请机器人收发消息和补收历史消息所需权限，不申请通讯录、文档或员工表格权限。企业限制创建应用时，仍需管理员批准。</p><p>每人独立机器人；不能多台电脑共用同一个应用。当前支持国内飞书，不支持国际版 Lark。</p><p>电脑离线时不会下载。重启后会尝试补收绑定后仍可读取的私聊；已删除的历史或已失效的视频无法保证补回。</p></details>
  </>
}
