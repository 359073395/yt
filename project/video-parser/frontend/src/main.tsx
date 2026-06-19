import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  AlertTriangle,
  Activity,
  Ban,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Copy,
  Crown,
  Database,
  Download,
  FileVideo,
  Filter,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  TerminalSquare,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react'
import './styles.css'

type JobStatus =
  | 'queued'
  | 'parsing'
  | 'downloading'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'expired'

type Job = {
  job_id: string
  url: string
  status: JobStatus
  title?: string | null
  platform?: string | null
  thumbnail?: string | null
  duration?: number | null
  size_bytes?: number | null
  downloaded_bytes: number
  total_bytes?: number | null
  progress: number
  filename?: string | null
  download_url?: string | null
  error?: string | null
  created_at: number
  updated_at: number
  expires_at?: number | null
}

type UserRole = 'user' | 'member' | 'admin'

type User = {
  id: number
  username: string
  role: UserRole
  created_at: number
  status: 'active' | 'disabled'
  member_expires_at?: number | null
  daily_limit_override?: number | null
  daily_used: number
  daily_limit?: number | null
  unlimited: boolean
}

type Quota = {
  limit: number | null
  used: number
  remaining: number | null
  unlimited: boolean
}

type AuthResponse = {
  token: string
  user: User
  quota: Quota
}

type MeResponse = {
  user: User | null
  quota: Quota
}

type AdminOverview = {
  users_total: number
  users_regular: number
  users_member: number
  users_admin: number
  users_disabled: number
  api_keys_total: number
  api_keys_active: number
  today_downloads: number
  jobs_total: number
  jobs_running: number
  jobs_completed: number
  jobs_failed: number
  storage_bytes: number
}

type ApiKeyItem = {
  id: number
  name: string
  prefix: string
  status: 'active' | 'disabled'
  scopes: string[]
  daily_limit?: number | null
  daily_used: number
  created_at: number
  last_used_at?: number | null
  last_used_ip?: string | null
}

type ApiKeyCreateResponse = {
  key: string
  item: ApiKeyItem
}

type PlatformItem = {
  name: string
  extractor?: string | null
  region: 'china' | 'international'
  status: 'supported' | 'experimental'
  note?: string | null
}

type PlatformsResponse = {
  supported: PlatformItem[]
  experimental: PlatformItem[]
}

type AdminRequest = <T>(path: string, options?: RequestInit) => Promise<T>

const statusText: Record<JobStatus, string> = {
  queued: '排队中',
  parsing: '解析中',
  downloading: '下载中',
  merging: '合并中',
  completed: '完成',
  failed: '失败',
  expired: '已过期',
}

const roleText: Record<UserRole, string> = {
  user: '普通用户',
  member: '会员',
  admin: '管理员',
}

const statusOrder: JobStatus[] = ['queued', 'parsing', 'downloading', 'merging', 'completed']

const demoJob: Job = {
  job_id: 'preview',
  url: 'https://www.tiktok.com/@creator/video/0000000000000',
  status: 'queued',
  title: 'Sample creator video',
  platform: 'TikTok',
  thumbnail: null,
  duration: 42,
  size_bytes: 40265318,
  downloaded_bytes: 0,
  total_bytes: 40265318,
  progress: 0,
  created_at: Date.now() / 1000,
  updated_at: Date.now() / 1000,
  expires_at: Date.now() / 1000 + 3600,
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return '未知'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(value?: number | null) {
  if (!value) return '未知'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatDate(value?: number | null) {
  if (!value) return '永久'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value * 1000))
}

function isActiveStep(jobStatus: JobStatus, step: JobStatus) {
  if (jobStatus === 'failed' || jobStatus === 'expired') return false
  return statusOrder.indexOf(step) <= statusOrder.indexOf(jobStatus)
}

function quotaText(quota: Quota | null) {
  if (!quota) return '读取额度中'
  if (quota.unlimited) return '无限下载'
  return `今日剩余 ${quota.remaining ?? 0}/${quota.limit ?? 5}`
}

async function readError(response: Response) {
  const body = await response.json().catch(() => null)
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item
        const field = Array.isArray(item?.loc) ? item.loc.filter((part: unknown) => part !== 'body').join('.') : ''
        const message = item?.msg || item?.message || JSON.stringify(item)
        return field ? `${field}: ${message}` : message
      })
      .join('；')
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return '请求失败'
}

function App() {
  const [url, setUrl] = React.useState('')
  const [job, setJob] = React.useState<Job | null>(null)
  const [history, setHistory] = React.useState<Job[]>(() => {
    const raw = window.sessionStorage.getItem('video-parser-history')
    return raw ? (JSON.parse(raw) as Job[]) : []
  })
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [token, setToken] = React.useState(() => window.localStorage.getItem('video-parser-token') || '')
  const [user, setUser] = React.useState<User | null>(null)
  const [quota, setQuota] = React.useState<Quota | null>(null)

  React.useEffect(() => {
    window.sessionStorage.setItem('video-parser-history', JSON.stringify(history.slice(0, 8)))
  }, [history])

  React.useEffect(() => {
    void refreshMe(token)
  }, [token])

  React.useEffect(() => {
    if (!job || ['completed', 'failed', 'expired'].includes(job.status)) return
    const timer = window.setInterval(async () => {
      const next = await fetchJob(job.job_id)
      if (next) {
        setJob(next)
        setHistory((items) => [next, ...items.filter((item) => item.job_id !== next.job_id)].slice(0, 8))
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [job])

  async function apiFetch(path: string, options: RequestInit = {}, authToken = token) {
    const headers = new Headers(options.headers)
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
    return fetch(path, { ...options, headers })
  }

  async function adminRequest<T>(path: string, options: RequestInit = {}) {
    const response = await apiFetch(path, options)
    if (!response.ok) throw new Error(await readError(response))
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async function refreshMe(authToken = token) {
    try {
      const response = await apiFetch('/api/me', {}, authToken)
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as MeResponse
      setUser(body.user)
      setQuota(body.quota)
    } catch {
      if (authToken) {
        window.localStorage.removeItem('video-parser-token')
        setToken('')
      }
      setUser(null)
      setQuota(null)
    }
  }

  async function fetchJob(jobId: string) {
    try {
      const response = await apiFetch(`/api/jobs/${jobId}`)
      if (!response.ok) throw new Error(await readError(response))
      return (await response.json()) as Job
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务查询失败')
      return null
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setMessage(null)
    const value = url.trim()
    if (!value || !/^https?:\/\//i.test(value)) {
      setMessage('请输入有效的 http/https 视频链接。')
      return
    }
    setIsSubmitting(true)
    try {
      const response = await apiFetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const body = (await response.json()) as { job_id: string }
      void refreshMe()
      const next = await fetchJob(body.job_id)
      if (next) {
        setJob(next)
        setHistory((items) => [next, ...items].slice(0, 8))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleAuth(mode: 'login' | 'register', username: string, password: string) {
    setMessage(null)
    const response = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const body = (await response.json()) as AuthResponse
    window.localStorage.setItem('video-parser-token', body.token)
    setToken(body.token)
    setUser(body.user)
    setQuota(body.quota)
  }

  function logout() {
    window.localStorage.removeItem('video-parser-token')
    setToken('')
    setUser(null)
    void refreshMe('')
  }

  async function copyDownloadLink(downloadUrl?: string | null) {
    if (!downloadUrl) return
    await navigator.clipboard.writeText(new URL(downloadUrl, window.location.origin).toString())
    setMessage('下载链接已复制。')
  }

  const visibleJob = job ?? demoJob

  return (
    <main className="app-shell">
      <header className="top-nav">
        <a className="brand" href="#">
          <span className="brand-mark"><Play size={15} fill="currentColor" /></span>
          影链工坊
        </a>
        <nav>
          <a href="#platforms">支持平台</a>
          <a href="#limits">安全限制</a>
          <a href="#notice">免责声明</a>
        </nav>
        <HeaderAccount
          quota={quota}
          user={user}
          onAuth={handleAuth}
          adminRequest={adminRequest}
          onLogout={logout}
        />
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <h1>影链工坊</h1>
          <p>输入链接，自动完成平台识别、视频下载与音视频合并。</p>

          <form className="parser-form" onSubmit={submit}>
            <label htmlFor="video-url">视频链接</label>
            <div className="input-row">
              <Link2 size={20} />
              <input
                id="video-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="粘贴 YouTube / TikTok / Instagram / Bilibili 链接"
                autoComplete="off"
              />
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
                开始解析
              </button>
            </div>
          </form>

          {message && (
            <div className="inline-alert" role="status">
              <AlertTriangle size={16} />
              {message}
            </div>
          )}

          <p className="quota-line">{quotaText(quota)}，会员不受每日次数限制。</p>

        </div>

        <TaskPanel job={visibleJob} onCopy={copyDownloadLink} />
      </section>

      <section className="lower-grid">
        <HistoryPanel history={history.length ? history : [demoJob]} />
        <InfoPanel />
      </section>

      <FooterInfo quota={quota} />
    </main>
  )
}

function HeaderAccount({
  quota,
  user,
  onAuth,
  adminRequest,
  onLogout,
}: {
  quota: Quota | null
  user: User | null
  onAuth: (mode: 'login' | 'register', username: string, password: string) => Promise<void>
  adminRequest: AdminRequest
  onLogout: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [adminOpen, setAdminOpen] = React.useState(false)
  const [mode, setMode] = React.useState<'login' | 'register'>('login')
  const [username, setUsername] = React.useState('admin')
  const [password, setPassword] = React.useState('lhw111111')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onAuth(mode, username.trim(), password)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  if (user) {
    return (
      <div className="header-account">
        <button className="account-chip account-trigger" type="button" onClick={() => setOpen((value) => !value)}>
          <UserRound size={15} />
          {user.username} · {roleText[user.role]} · {quotaText(quota)}
        </button>
        <button className="nav-logout" type="button" onClick={onLogout}>
          <LogOut size={16} />
          退出
        </button>
        {open && (
          <section className="auth-popover account-menu">
            <span className="caption">Account</span>
            <h2>{user.username}</h2>
            <p>{roleText[user.role]} · {quotaText(quota)}</p>
            {user.role === 'admin' && (
              <button
                className="menu-action"
                type="button"
                onClick={() => {
                  setAdminOpen(true)
                }}
              >
                <UsersRound size={16} />
                管理后台
              </button>
            )}
          </section>
        )}
        {adminOpen && user.role === 'admin' && (
          <AdminDashboard
            adminRequest={adminRequest}
            onClose={() => setAdminOpen(false)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="header-account auth-popover-wrap">
      <button className="account-chip account-trigger" type="button" onClick={() => setOpen((value) => !value)}>
        <UserRound size={15} />
        登录 / 注册
      </button>
      {open && (
        <section className="auth-popover">
          <div className="auth-tabs">
            <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>
              登录
            </button>
            <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>
              注册
            </button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" type="password" />
            <button type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={16} /> : <UserRound size={16} />}
              {mode === 'login' ? '登录账号' : '创建账号'}
            </button>
          </form>
          <p className="quota-note">{quotaText(quota)}。会员可不受每日次数限制。</p>
          {error && <p className="auth-error">{error}</p>}
        </section>
      )}
    </div>
  )
}

function TaskPanel({ job, onCopy }: { job: Job; onCopy: (downloadUrl?: string | null) => void }) {
  const isPreview = job.job_id === 'preview'
  return (
    <section className="task-panel" aria-label="当前任务">
      <div className="panel-header">
        <div>
          <span className="caption">Current job</span>
          <h2>{isPreview ? '等待链接输入' : statusText[job.status]}</h2>
        </div>
        <StatusBadge status={job.status} />
      </div>

      <div className="steps">
        {statusOrder.map((step) => (
          <div className={`step ${isActiveStep(job.status, step) ? 'active' : ''}`} key={step}>
            <span />
            {statusText[step]}
          </div>
        ))}
      </div>

      <div className="progress-track">
        <div style={{ width: `${Math.max(0, Math.min(job.progress, 100))}%` }} />
      </div>

      <article className="result-row">
        <div className="thumb">
          {job.thumbnail ? <img src={job.thumbnail} alt="" /> : <FileVideo size={28} />}
        </div>
        <div className="result-main">
          <h3>{job.title || '链接提交后会显示视频标题'}</h3>
          <dl>
            <div><dt>平台</dt><dd>{job.platform || '自动识别'}</dd></div>
            <div><dt>时长</dt><dd>{formatDuration(job.duration)}</dd></div>
            <div><dt>大小</dt><dd>{formatBytes(job.size_bytes || job.total_bytes)}</dd></div>
          </dl>
          {job.error && <p className="error-text">{job.error}</p>}
        </div>
      </article>

      <div className="action-row">
        <a
          className={`download-button ${job.download_url ? '' : 'disabled'}`}
          href={job.download_url || '#'}
          aria-disabled={!job.download_url}
        >
          <Download size={17} />
          下载文件
        </a>
        <button className="secondary-button" type="button" disabled={!job.download_url} onClick={() => onCopy(job.download_url)}>
          <Copy size={16} />
          复制链接
        </button>
      </div>
    </section>
  )
}

function HistoryPanel({ history }: { history: Job[] }) {
  return (
    <section className="panel history-panel" aria-label="最近任务">
      <div className="panel-title">
        <History size={17} />
        <h2>最近任务</h2>
      </div>
      <div className="history-list">
        {history.slice(0, 4).map((item) => (
          <div className="history-item" key={item.job_id}>
            <div>
              <strong>{item.title || '未命名视频'}</strong>
              <span>{item.platform || new URL(item.url).hostname}</span>
            </div>
            <StatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </section>
  )
}

function InfoPanel() {
  const internationalPlatforms = [
    'YouTube',
    'TikTok',
    'Instagram',
    'Facebook',
    'X / Twitter',
    'Bilibili',
    'Vimeo',
    'SoundCloud',
    'Reddit',
    'Twitch',
    'Dailymotion',
    'Rumble',
  ]
  const chinaPlatforms = ['抖音', '小红书', '哔哩哔哩', '微博', 'AcFun', '优酷', '爱奇艺', '腾讯视频', '百度视频', '斗鱼', '虎牙']

  return (
    <section className="panel info-panel" id="platforms">
      <div className="info-block">
        <span className="caption">Platforms</span>
        <h2>支持平台</h2>
        <p>项目优先适配以下常用平台，其他公开视频链接会自动尝试解析。快手、Shopee 与 TikTok Shop 第一版暂不保证。</p>
      </div>
      <span className="platform-group-title">国内平台</span>
      <div className="platform-list" aria-label="支持平台列表">
        {chinaPlatforms.map((platform) => (
          <span key={platform}>{platform}</span>
        ))}
      </div>
      <span className="platform-group-title">国际平台</span>
      <div className="platform-list" aria-label="支持平台列表">
        {internationalPlatforms.map((platform) => (
          <span key={platform}>{platform}</span>
        ))}
      </div>
    </section>
  )
}

function FooterInfo({ quota }: { quota: Quota | null }) {
  return (
    <section className="footer-info" aria-label="安全限制与免责声明">
      <article className="footer-card" id="limits">
        <div className="panel-title">
          <Shield size={17} />
          <h2>安全限制</h2>
        </div>
        <div className="limit-grid">
          <span><Clock3 size={16} />{quotaText(quota)}</span>
          <span><UserRound size={16} />访客每日 3 个</span>
          <span><FileVideo size={16} />普通用户每日 10 个</span>
          <span><Crown size={16} />会员与管理员无限制</span>
          <span><Gauge size={16} />默认 512 MB 文件上限</span>
          <span><Shield size={16} />批量下载暂未开放</span>
        </div>
      </article>

      <article className="footer-card" id="notice">
        <div className="panel-title">
          <AlertTriangle size={17} />
          <h2>免责声明</h2>
        </div>
        <p className="notice">请只处理你拥有权利或已获授权的视频内容。本工具不承诺绕过登录、DRM、私密内容或平台反爬限制。</p>
      </article>
    </section>
  )
}

function AdminDashboard({ adminRequest, onClose }: { adminRequest: AdminRequest; onClose: () => void }) {
  const [tab, setTab] = React.useState('overview')
  const [overview, setOverview] = React.useState<AdminOverview | null>(null)
  const [users, setUsers] = React.useState<User[]>([])
  const [jobs, setJobs] = React.useState<Job[]>([])
  const [apiKeys, setApiKeys] = React.useState<ApiKeyItem[]>([])
  const [platforms, setPlatforms] = React.useState<PlatformsResponse | null>(null)
  const [query, setQuery] = React.useState('')
  const [roleFilter, setRoleFilter] = React.useState<'all' | UserRole>('all')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [newApiName, setNewApiName] = React.useState('Codex Agent')
  const [newApiLimit, setNewApiLimit] = React.useState('100')
  const [createdKey, setCreatedKey] = React.useState<string | null>(null)
  const [newUserName, setNewUserName] = React.useState('')
  const [newUserPassword, setNewUserPassword] = React.useState('')
  const [newUserRole, setNewUserRole] = React.useState<UserRole>('member')
  const [newUserMemberTerm, setNewUserMemberTerm] = React.useState<'forever' | '30d'>('forever')
  const [newUserLimit, setNewUserLimit] = React.useState('')

  const tabs = [
    ['overview', '总览', LayoutDashboard],
    ['users', '用户会员', UsersRound],
    ['api', 'API Key', KeyRound],
    ['jobs', '任务缓存', Database],
    ['platforms', '支持平台', Filter],
    ['docs', 'API 对接', TerminalSquare],
  ] as const

  const filteredUsers = users.filter((item) => {
    const matchesQuery = item.username.toLowerCase().includes(query.toLowerCase()) || String(item.id).includes(query)
    const matchesRole = roleFilter === 'all' || item.role === roleFilter
    return matchesQuery && matchesRole
  })

  React.useEffect(() => {
    void refreshAll()
  }, [])

  async function refreshAll() {
    setBusy(true)
    setError(null)
    try {
      const [overviewBody, usersBody, keysBody, jobsBody, platformsBody] = await Promise.all([
        adminRequest<AdminOverview>('/api/admin/overview'),
        adminRequest<User[]>('/api/admin/users'),
        adminRequest<ApiKeyItem[]>('/api/admin/api-keys'),
        adminRequest<Job[]>('/api/admin/jobs'),
        adminRequest<PlatformsResponse>('/api/v1/platforms'),
      ])
      setOverview(overviewBody)
      setUsers(usersBody)
      setApiKeys(keysBody)
      setJobs(jobsBody)
      setPlatforms(platformsBody)
    } catch (err) {
      setError(err instanceof Error ? err.message : '后台数据加载失败')
    } finally {
      setBusy(false)
    }
  }

  async function updateUser(userId: number, payload: Record<string, unknown>) {
    const next = await adminRequest<User>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setUsers((items) => items.map((item) => (item.id === userId ? next : item)))
    void refreshOverview()
  }

  async function deleteUser(userId: number) {
    await adminRequest<void>(`/api/admin/users/${userId}`, { method: 'DELETE' })
    setUsers((items) => items.filter((item) => item.id !== userId))
    void refreshOverview()
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const expires = newUserRole === 'member' && newUserMemberTerm === '30d'
      ? Math.floor(Date.now() / 1000) + 30 * 86400
      : null
    try {
      const created = await adminRequest<User>('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUserName.trim(),
          password: newUserPassword,
          role: newUserRole,
          status: 'active',
          member_expires_at: expires,
          daily_limit_override: newUserLimit.trim() ? Number(newUserLimit) : null,
        }),
      })
      setUsers((items) => [created, ...items])
      setNewUserName('')
      setNewUserPassword('')
      setNewUserRole('member')
      setNewUserMemberTerm('forever')
      setNewUserLimit('')
      void refreshOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : '用户创建失败')
    }
  }

  async function refreshOverview() {
    setOverview(await adminRequest<AdminOverview>('/api/admin/overview'))
  }

  async function createApiKey(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    const body = {
      name: newApiName.trim(),
      daily_limit: newApiLimit.trim() ? Number(newApiLimit) : null,
      scopes: ['jobs:create', 'jobs:read', 'files:download'],
    }
    try {
      const created = await adminRequest<ApiKeyCreateResponse>('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setCreatedKey(created.key)
      setApiKeys((items) => [created.item, ...items])
      void refreshOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API Key 创建失败')
    }
  }

  async function updateApiKey(id: number, payload: Record<string, unknown>) {
    const next = await adminRequest<ApiKeyItem>(`/api/admin/api-keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setApiKeys((items) => items.map((item) => (item.id === id ? next : item)))
    void refreshOverview()
  }

  async function deleteApiKey(id: number) {
    await adminRequest<void>(`/api/admin/api-keys/${id}`, { method: 'DELETE' })
    setApiKeys((items) => items.filter((item) => item.id !== id))
    void refreshOverview()
  }

  async function cleanupCache() {
    await adminRequest<{ removed: number; storage_bytes: number }>('/api/admin/cleanup', { method: 'POST' })
    await refreshAll()
  }

  return (
    <section className="admin-console" aria-label="管理后台">
      <div className="admin-backdrop" onClick={onClose} />
      <div className="admin-shell">
        <aside className="admin-sidebar">
          <div>
            <span className="caption">Admin Console</span>
            <h2>影链工坊后台</h2>
          </div>
          <nav>
            {tabs.map(([id, label, Icon]) => (
              <button className={tab === id ? 'active' : ''} key={id} type="button" onClick={() => setTab(id)}>
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
          <button className="secondary-button" type="button" onClick={onClose}>返回前台</button>
        </aside>

        <section className="admin-main">
          <header className="admin-main-header">
            <div>
              <span className="caption">Operations</span>
              <h2>{tabs.find(([id]) => id === tab)?.[1]}</h2>
            </div>
            <button className="secondary-button" type="button" onClick={refreshAll} disabled={busy}>
              {busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              刷新
            </button>
          </header>

          {error && <div className="inline-alert"><AlertTriangle size={16} />{error}</div>}

          {tab === 'overview' && overview && (
            <div className="admin-metrics">
              <Metric title="用户总数" value={overview.users_total} icon={<UsersRound size={18} />} />
              <Metric title="会员" value={overview.users_member} icon={<Crown size={18} />} />
              <Metric title="今日下载" value={overview.today_downloads} icon={<Download size={18} />} />
              <Metric title="API Key" value={`${overview.api_keys_active}/${overview.api_keys_total}`} icon={<KeyRound size={18} />} />
              <Metric title="运行任务" value={overview.jobs_running} icon={<Activity size={18} />} />
              <Metric title="缓存占用" value={formatBytes(overview.storage_bytes)} icon={<Database size={18} />} />
            </div>
          )}

          {tab === 'users' && (
            <div className="admin-section">
              <form className="user-create" onSubmit={createUser}>
                <input value={newUserName} onChange={(event) => setNewUserName(event.target.value)} placeholder="新用户名" autoComplete="off" />
                <input value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="初始密码，至少 8 位" type="password" autoComplete="new-password" />
                <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as UserRole)}>
                  <option value="member">会员</option>
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
                <select value={newUserMemberTerm} disabled={newUserRole !== 'member'} onChange={(event) => setNewUserMemberTerm(event.target.value as 'forever' | '30d')}>
                  <option value="forever">永久会员</option>
                  <option value="30d">30 天会员</option>
                </select>
                <input value={newUserLimit} onChange={(event) => setNewUserLimit(event.target.value)} placeholder="每日额度覆盖，可留空" inputMode="numeric" />
                <button type="submit"><UserRound size={16} />新开用户</button>
              </form>
              <div className="admin-toolbar">
                <label className="admin-search">
                  <Search size={15} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户名或 ID" />
                </label>
                <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as 'all' | UserRole)}>
                  <option value="all">全部身份</option>
                  <option value="user">普通用户</option>
                  <option value="member">会员</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              <div className="admin-table users-table">
                <div className="admin-row admin-row-head">
                  <span>用户</span><span>身份</span><span>今日额度</span><span>会员到期</span><span>状态</span><span>操作</span>
                </div>
                {filteredUsers.map((item) => (
                  <div className="admin-row" key={item.id}>
                    <div><strong>{item.username}</strong><small>#{item.id} · {formatDate(item.created_at)}</small></div>
                    <select value={item.role} onChange={(event) => updateUser(item.id, { role: event.target.value })}>
                      <option value="user">普通用户</option>
                      <option value="member">会员</option>
                      <option value="admin">管理员</option>
                    </select>
                    <div className="quota-edit">
                      <span>{item.unlimited ? '无限制' : `${item.daily_used}/${item.daily_limit ?? 10}`}</span>
                      <button type="button" onClick={() => updateUser(item.id, { daily_used: 0 })}>重置</button>
                    </div>
                    <select
                      value={item.member_expires_at ? '30d' : 'forever'}
                      disabled={item.role !== 'member'}
                      onChange={(event) => {
                        const expires = event.target.value === '30d' ? Math.floor(Date.now() / 1000) + 30 * 86400 : null
                        void updateUser(item.id, { member_expires_at: expires })
                      }}
                    >
                      <option value="forever">永久</option>
                      <option value="30d">30 天</option>
                    </select>
                    <button
                      className={`status-toggle ${item.status === 'disabled' ? 'danger' : ''}`}
                      type="button"
                      onClick={() => updateUser(item.id, { status: item.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {item.status === 'active' ? <CheckCircle2 size={15} /> : <Ban size={15} />}
                      {item.status === 'active' ? '启用' : '禁用'}
                    </button>
                    <button className="danger-button" type="button" onClick={() => deleteUser(item.id)}>
                      <Trash2 size={15} />
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'api' && (
            <div className="admin-section">
              <form className="api-create" onSubmit={createApiKey}>
                <input value={newApiName} onChange={(event) => setNewApiName(event.target.value)} placeholder="密钥名称，例如 Codex Agent" />
                <input value={newApiLimit} onChange={(event) => setNewApiLimit(event.target.value)} placeholder="每日额度，留空为无限" inputMode="numeric" />
                <button type="submit"><KeyRound size={16} />创建 API Key</button>
              </form>
              {createdKey && (
                <div className="created-key">
                  <span>密钥只显示一次</span>
                  <code>{createdKey}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(createdKey)}><ClipboardCopy size={15} />复制</button>
                </div>
              )}
              <div className="admin-table api-table">
                {apiKeys.map((item) => (
                  <div className="api-row" key={item.id}>
                    <div><strong>{item.name}</strong><small>{item.prefix}... · {item.scopes.join(', ')}</small></div>
                    <span>{item.daily_limit ? `${item.daily_used}/${item.daily_limit}` : '无限额度'}</span>
                    <span>{item.last_used_at ? `最近 ${formatDate(item.last_used_at)}` : '未使用'}</span>
                    <button type="button" onClick={() => updateApiKey(item.id, { status: item.status === 'active' ? 'disabled' : 'active' })}>
                      {item.status === 'active' ? '禁用' : '启用'}
                    </button>
                    <button className="danger-button" type="button" onClick={() => deleteApiKey(item.id)}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'jobs' && (
            <div className="admin-section">
              <div className="admin-toolbar">
                <p>当前显示运行时任务；重启服务后历史任务不会保留。</p>
                <button className="secondary-button" type="button" onClick={cleanupCache}><Trash2 size={16} />清理缓存</button>
              </div>
              <div className="admin-table jobs-table">
                {jobs.map((item) => (
                  <div className="job-admin-row" key={item.job_id}>
                    <div><strong>{item.title || item.job_id}</strong><small>{item.platform || '自动识别'} · {item.url}</small></div>
                    <StatusBadge status={item.status} />
                    <span>{Math.round(item.progress)}%</span>
                    <span>{formatBytes(item.size_bytes || item.total_bytes)}</span>
                  </div>
                ))}
                {!jobs.length && <p className="empty-admin">暂无任务。</p>}
              </div>
            </div>
          )}

          {tab === 'platforms' && platforms && (
            <div className="admin-section platform-admin">
              <h3>国内平台</h3>
              <div className="platform-list">
                {platforms.supported.filter((item) => item.region === 'china').map((item) => <span key={item.name}>{item.name}</span>)}
              </div>
              <h3>国际平台</h3>
              <div className="platform-list">
                {platforms.supported.filter((item) => item.region === 'international').map((item) => <span key={item.name}>{item.name}</span>)}
              </div>
              <h3>尝试解析，暂不保证</h3>
              <div className="platform-list">
                {platforms.experimental.map((item) => <span key={item.name}>{item.name}</span>)}
              </div>
            </div>
          )}

          {tab === 'docs' && (
            <div className="admin-section api-docs">
              <p>给智能体或 Codex 使用时，把 API Key 放在请求头里：<code>X-API-Key: ylg_xxx</code></p>
              <pre>{`POST /api/v1/jobs
Content-Type: application/json
X-API-Key: ylg_xxx

{"url":"https://www.douyin.com/video/..."}`}</pre>
              <pre>{`GET /api/v1/jobs/{jobId}
GET /api/v1/jobs/{jobId}/download
GET /api/v1/platforms
GET /api/v1/quota
GET /api/v1/openapi.json`}</pre>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

function Metric({ title, value, icon }: { title: string; value: React.ReactNode; icon: React.ReactNode }) {
  return (
    <article className="metric-card">
      <div>{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  )
}

function StatusBadge({ status }: { status: JobStatus }) {
  const icon = status === 'completed' ? <CheckCircle2 size={14} /> : status === 'failed' || status === 'expired' ? <AlertTriangle size={14} /> : <Loader2 size={14} className={status === 'queued' ? '' : 'spin'} />
  return <span className={`status status-${status}`}>{icon}{statusText[status]}</span>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
