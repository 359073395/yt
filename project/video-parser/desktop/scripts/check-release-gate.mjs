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
const required = scoped ? ['design', 'native-installer-migration', 'feishu-classification', 'download-regression', 'download-record-deletion', 'automated-regressions', 'live-recording-replay'] : fullScope
const failures = []
if (receipt.version !== manifest.version) failures.push('验收版本与安装包版本不一致')
if (scoped && (!receipt.approval || !existsSync(resolve(root, 'RELEASE-1.10.0.md')))) failures.push('缺少本次范围批准或公开功能限制说明')
for (const name of required) {
  const check = receipt.checks[name]
  if (check?.status !== 'passed') { failures.push(`${name}: ${check?.status || 'missing'}`); continue }
  const path = resolve(root, check.evidence || '')
  const rel = relative(root, path)
  if (!check.evidence || isAbsolute(rel) || rel.startsWith('..') || !existsSync(path) || !readFileSync(path, 'utf8').trim()) failures.push(`${name}: 缺少项目内的实测证据`)
}
const sourcePaths = ['src', 'src-tauri/src', 'src-tauri/tauri.conf.json', 'package-lock.json', 'src-tauri/resources/bin/yt-dlp-plugins']
for (const path of sourcePaths) {
  const tree = execFileSync('git', ['rev-parse', `HEAD:project/video-parser/desktop/${path}`], { cwd: root, encoding: 'utf8' }).trim()
  if (receipt.sourceTrees?.[path] !== tree) failures.push(`${path}: 验收未对应当前源码`)
}
if (execFileSync('git', ['status', '--porcelain', '--', ...sourcePaths], { cwd: root, encoding: 'utf8' }).trim()) failures.push('待发布源码尚有未提交改动')
if (failures.length) {
  console.error(`禁止发布正式升级包：\n${failures.map(item => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else console.log('版本、源码和所有必测项验收通过，可进入签名发布步骤。')
