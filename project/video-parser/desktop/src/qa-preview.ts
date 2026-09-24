// Development-only fixtures. Dynamic import is removed entirely from production builds.
// This bridge has no account/network/native access and cannot download real videos.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import type { DownloadResult } from './core'
import type { LibraryJournal } from './library'
import type { Snapshot } from './TeamInbox'
import { emptyAutomation, type AutomationSnapshot } from './automation'

export function setupPreview() {
  const titles = ['印尼防晒口播', '粉底液试用', '日常护肤步骤']
  const photos = ['sunscreen', 'foundation', 'skincare']
  let journal: LibraryJournal = {
    version: 1, categories: ['美妆口播', '家居好物'],
    items: titles.map((title, i) => ({ id: `sample-${i}`, url: `https://example.invalid/video/${i}`, title, platform: ['TikTok', 'YouTube', '抖音'][i], uploader: '', thumbnail: `/qa/fixtures/${photos[i]}.png`, duration: [58, 72, 85][i], selected: false, quality: '1080', loading: false, category: '美妆口播', note: ['卖点：清爽不油腻', '参考开场与产品展示', '日常护肤流程'][i], created: Date.now() })),
    tasks: titles.map((title, i) => ({ id: `task-${i}`, queueItemId: `sample-${i}`, url: `https://example.invalid/video/${i}`, title, platform: ['TikTok', 'YouTube', '抖音'][i], status: 'completed', percent: 100, message: 'UI 测试数据，不是真实下载', ...(i !== 2 ? { outputDir: `E:\\视频素材\\美妆口播\\${title}_[sample]` } : {}) })),
  }
  let snapshot: Snapshot = { config: { app_id: 'ui-fixture', device_name: '本地界面测试', root: 'E:\\视频素材', enabled: false, copy: true, provider: 'api', model_id: 'small', quality: '1080', language: 'auto', subtitle: true, transcript_mode: 'auto', onboarding: false, session: { device_id: 'ui-only', user_name: '测试用户', device_name: '本地界面测试' } }, jobs: [], error: '', busy: false, connection: '界面测试 · 无真实收件', pair: null, registration: null }
  let model = 'small', modelDir = 'E:\\model', downloadDir = 'E:\\视频素材'
  let settings = { base_url: 'https://example.invalid/v1', model: 'test-model', api_key_saved: false }
  const automation: AutomationSnapshot = structuredClone(emptyAutomation)
  mockWindows('main')
  mockIPC(async (command, raw) => {
    const args = (raw || {}) as Record<string, any>
    switch (command) {
      case 'runtime_info': return { version: '开发验收版', default_download_dir: downloadDir, yt_dlp_available: true, ffmpeg_available: true, whisper_available: true, selected_model: model, model_dir: modelDir, model_server_url: '', translation_model_installed: true, translation_model_size_bytes: 646109073, login_profile_available: false, models: [{ id: 'base', name: 'Base · 极速', size_bytes: 147000000, installed: false }, { id: 'small', name: 'Small · 推荐', size_bytes: 488000000, installed: true }, { id: 'medium', name: 'Medium · 高精度', size_bytes: 1500000000, installed: true }] }
      case 'account_statuses': return ['douyin', 'tiktok', 'youtube', 'bilibili', 'instagram', 'facebook', 'twitter'].map(platform => ({ platform, state: 'anonymous', detail: '仅界面预览：没有读取真实账号会话' }))
      case 'network_settings': return { mode: 'system', address: 'http://127.0.0.1:10808', overseas_only: true }
      case 'save_network_settings': return args.request
      case 'detect_local_proxy': return 'http://127.0.0.1:10808'
      case 'test_network_proxy': return 'UI 模拟：没有真实访问 TikTok'
      case 'launch_login': return '仅界面预览：请在安装版中使用官方登录'
      case 'get_ai_settings': return settings
      case 'save_ai_settings': settings = { base_url: args.request.base_url, model: args.request.model, api_key_saved: false }; return settings
      case 'list_ai_models': return ['test-model', 'test-multilingual']
      case 'test_ai_translation': return '仅界面测试：此处没有访问真实 AI 服务'
      case 'library_load': return journal
      case 'library_save': journal = structuredClone(args.data); return null
      case 'automation_snapshot': return structuredClone(automation)
      case 'automation_ack': automation.deliveries = automation.deliveries.filter(d => !args.ids.includes(d.id)); return null
      case 'subscription_add': {
        const request = args.request, id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000)
        automation.subscriptions.push({ ...request, id, enabled: true, initialized: true, checking: false, last_checked: now, next_check: now + request.interval_minutes * 60, detail: 'UI 模拟：已建立基线，没有访问真实平台' })
        if (request.include_existing) automation.deliveries.push({ id: crypto.randomUUID(), subscription_id: id, url: 'https://example.invalid/subscription/video/1', title: '订阅 UI 测试视频', category: request.category, note: `订阅：${request.name}`, auto_download: request.auto_download, created: now })
        return null
      }
      case 'subscription_action': {
        const s = automation.subscriptions.find(s => s.id === args.id)
        if (!s) throw new Error('订阅不存在')
        if (args.action === 'toggle') s.enabled = !s.enabled
        if (args.action === 'remove') automation.subscriptions = automation.subscriptions.filter(s => s.id !== args.id)
        if (args.action === 'check') { s.last_checked = Math.floor(Date.now() / 1000); s.detail = 'UI 模拟：检查完成，无新增' }
        return null
      }
      case 'live_start': {
        const request = args.request, id = crypto.randomUUID()
        automation.recordings.unshift({ id, url: request.url, name: request.name || '模拟直播', category: request.category, output_dir: `${request.root}\\${request.category}\\直播\\模拟录制`, status: 'recording', detail: 'UI 模拟录制状态，没有创建真实视频文件', created: Math.floor(Date.now()/1000), elapsed: 12, bytes: 5 * 1024 * 1024 })
        return id
      }
      case 'live_stop': {
        const r = automation.recordings.find(r => r.id === args.id)
        if (r) { r.status = 'completed'; r.detail = 'UI 模拟已停止，无真实录制文件' }
        return null
      }
      case 'team_snapshot': return snapshot
      case 'team_save': snapshot = { ...snapshot, config: args.config }; return null
      case 'choose_download_dir': downloadDir = 'E:\\验收视频'; return downloadDir
      case 'choose_model_dir': modelDir = 'E:\\验收模型'; return modelDir
      case 'plugin:updater|check': return null
      case 'inspect_items': return args.urls.map((url: string, i: number) => ({ url, title: `界面测试新视频 ${i + 1}`, platform: 'TikTok', uploader: 'QA 示例', thumbnail: '/qa/fixtures/sunscreen.png', duration: 58 }))
      case 'scan_profile': return Array.from({ length: 3 }, (_, i) => ({ url: `https://example.invalid/profile/video/${i}`, id: `profile-${i}`, title: `主页作品 ${i + 1}` }))
      case 'download_item': {
        const { job_id: id, options } = args.request
        await emit('job-progress', { job_id: id, phase: 'downloading', percent: 62, message: 'UI 模拟进度' })
        await new Promise(resolve => setTimeout(resolve, 800))
        return { title: '界面测试新视频', platform: 'TikTok', output_dir: `${options.download_dir}\\${options.category}\\测试_[ui]`, source_language: 'id', transcript_available: true, segments: [{ index: 1, start: '00:00:00,000', end: '00:00:02,000', text: 'Produk ini ringan.' }], thumbnail: '/qa/fixtures/sunscreen.png' } satisfies DownloadResult
      }
      case 'translate_with_ai': return args.request.texts.map(() => '这个产品很轻盈。')
      case 'save_translation': return null
      case 'read_bilingual': return 'Produk ini ringan.\n这个产品很轻盈。'
      case 'open_directory': throw new Error('界面预览不会打开本机文件夹；请在桌面验收版验证')
      case 'relocate_output': return `${args.root}\\${args.category}\\测试_[ui]`
      case 'cancel_job': return null
      default: throw new Error(`界面预览未模拟此命令：${command}`)
    }
  }, { shouldMockEvents: true })
  // Installed Tauri mock expects `id`, whereas event.ts sends `eventId` on
  // unlisten. Adapt that test-only mismatch instead of suppressing warnings.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
  const mockInvoke = internals.invoke
  internals.invoke = (command, args, options) => mockInvoke(command, command === 'plugin:event|unlisten' ? { ...args, id: args.eventId } : args, options)
  window.setTimeout(() => {
    void emit('job-progress', { job_id: 'task-0', phase: 'translating', percent: 40, message: '界面示例：翻译中' })
    void emit('job-progress', { job_id: 'task-2', phase: 'downloading', percent: 62, message: '界面示例：下载中' })
  }, 1000)
  document.title = '跑量影链工坊 · 界面测试（模拟数据）'
}
