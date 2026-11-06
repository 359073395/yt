// Local/CI release gate. A successful build is not evidence of a usable release.
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const receipt = JSON.parse(readFileSync(resolve(root, 'qa/release-acceptance.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const fullScope = ['design', 'native-installer-migration', 'four-platform-downloads', 'local-and-api-transcription-translation', 'feishu-two-users-two-machines', 'cancel-resume-output-integrity', 'live-recording-replay', 'subscriptions-images-comments', 'models-engine-update-security']
// User explicitly approved the existing-feature scope on 2026-09-24. This is
// version-specific, not a blanket waiver for future releases or a false pass.
const scoped = manifest.version === '1.10.0' && receipt.scope === 'existing-features-20260924'
// This release has its own current maintenance request and fresh evidence; the
// September feature-scope approval is not reused for October's dependency update.
const maintenance = manifest.version === '1.10.1' && receipt.scope === 'upstream-maintenance-20261016'
// Current user-approved TikTok fix: test first, publish 1.10.2 for self-update.
const tiktokFix = manifest.version === '1.10.2' && receipt.scope === 'tiktok-free-fallback-20261019'
// Current request: update all upstreams and verify every implemented feature.
// Unimplemented historical roadmap items are not counted as existing features;
// live account-dependent checks remain required and must not be marked passed
// merely because offline tests or the installer build succeed.
const upstreamAll = manifest.version === '1.11.0' && receipt.scope === 'all-implemented-features-20261106'
const liveMonitor = manifest.version === '1.12.0' && receipt.scope === 'live-monitoring-20261106'
const required = liveMonitor
  ? ['automated-regressions', 'live-monitor-native', 'live-monitor-state-recovery', 'ui-workflows', 'live-manual-regression', 'native-installer-migration']
  : upstreamAll
  ? ['dependency-audit', 'runtime-integrity', 'automated-regressions', 'ui-workflows', 'supported-platform-downloads', 'asr-and-translation', 'personal-feishu-live', 'library-cancel-retry', 'subscriptions', 'live-recording-replay', 'native-installer-migration']
  : tiktokFix
  ? ['tiktok-target-download', 'free-provider-failover', 'public-provider-security', 'automated-regressions', 'upgrade-compatibility']
  : maintenance
  ? ['dependency-audit', 'runtime-integrity', 'media-engines', 'local-translation', 'automated-regressions', 'upgrade-compatibility']
  : scoped ? ['design', 'native-installer-migration', 'feishu-classification', 'download-regression', 'download-record-deletion', 'automated-regressions', 'live-recording-replay'] : fullScope
const failures = []
if (receipt.version !== manifest.version) failures.push('验收版本与安装包版本不一致')
if (scoped && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.10.0.md')))) failures.push('缺少本次范围批准或公开功能限制说明')
if (maintenance && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.10.1.md')))) failures.push('缺少本次维护请求或公开验证范围')
if (tiktokFix && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.10.2.md')))) failures.push('缺少本次修复发布批准或公开验证范围')
if (upstreamAll && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.11.0.md')))) failures.push('缺少本次完整维护请求或验证范围说明')
if (liveMonitor && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.12.0.md')))) failures.push('缺少本次开播监控请求或公开验证范围')
for (const name of required) {
  const check = receipt.checks[name]
  if (check?.status !== 'passed') { failures.push(`${name}: ${check?.status || 'missing'}`); continue }
  const path = resolve(root, check.evidence || '')
  const rel = relative(root, path)
  if (!check.evidence || isAbsolute(rel) || rel.startsWith('..') || !existsSync(path) || !readFileSync(path, 'utf8').trim()) failures.push(`${name}: 缺少项目内的实测证据`)
}
const sourcePaths = ['src', 'src-tauri/src', 'src-tauri/tauri.conf.json', 'package-lock.json', 'src-tauri/resources/bin/yt-dlp-plugins', ...((maintenance || tiktokFix || upstreamAll || liveMonitor) ? ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'scripts'] : []), ...(tiktokFix ? ['src-tauri/examples/tiktok-smoke.rs', 'src-tauri/build.rs'] : []), ...((upstreamAll || liveMonitor) ? ['src-tauri/examples', 'src-tauri/build.rs', 'vite.config.ts'] : [])]
for (const path of sourcePaths) {
  const tree = execFileSync('git', ['rev-parse', `HEAD:project/video-parser/desktop/${path}`], { cwd: root, encoding: 'utf8' }).trim()
  if (receipt.sourceTrees?.[path] !== tree) failures.push(`${path}: 验收未对应当前源码`)
}
if (execFileSync('git', ['status', '--porcelain', '--', ...sourcePaths], { cwd: root, encoding: 'utf8' }).trim()) failures.push('待发布源码尚有未提交改动')
if (failures.length) {
  console.error(`禁止发布正式升级包：\n${failures.map(item => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else console.log('版本、源码和所有必测项验收通过，可进入签名发布步骤。')
