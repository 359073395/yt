import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1')
const binDir = join(root, 'src-tauri', 'resources', 'bin')
const tempDir = join(root, '.runtime-download')
mkdirSync(binDir, { recursive: true })
mkdirSync(tempDir, { recursive: true })

async function json(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'yinglian-desktop-build' } })
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return response.json()
}

async function download(url, destination) {
  if (existsSync(destination) && statSync(destination).size > 1024 * 1024) return
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'yinglian-desktop-build' } })
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`)
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(destination)))
}

function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function extract(zip, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(destination)} -Force`], { stdio: 'inherit' })
}

function findFiles(directory, predicate, found = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) findFiles(path, predicate, found)
    else if (predicate(name, path)) found.push(path)
  }
  return found
}

function copyRuntimeFolder(sourceFile, requiredNames) {
  const sourceDir = dirname(sourceFile)
  for (const name of readdirSync(sourceDir)) {
    const source = join(sourceDir, name)
    if (statSync(source).isFile() && (name.toLowerCase().endsWith('.dll') || requiredNames.includes(name.toLowerCase()))) {
      copyFileSync(source, join(binDir, name))
    }
  }
}

const manifest = { generatedAt: new Date().toISOString(), components: {} }

const ytDlpPath = join(binDir, 'yt-dlp.exe')
await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', ytDlpPath)
manifest.components.ytDlp = { source: 'https://github.com/yt-dlp/yt-dlp/releases/latest', bytes: statSync(ytDlpPath).size }

const ffmpegRelease = await json('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest')
const ffmpegAsset = ffmpegRelease.assets.find((asset) => asset.name === 'ffmpeg-master-latest-win64-lgpl-shared.zip')
  ?? ffmpegRelease.assets.find((asset) => /win64-lgpl-shared\.zip$/i.test(asset.name))
if (!ffmpegAsset) throw new Error('没有找到 Windows x64 FFmpeg LGPL shared 构建')
const ffmpegZip = join(tempDir, basename(ffmpegAsset.name))
await download(ffmpegAsset.browser_download_url, ffmpegZip)
const ffmpegExtracted = join(tempDir, 'ffmpeg')
extract(ffmpegZip, ffmpegExtracted)
const ffmpegExe = findFiles(ffmpegExtracted, (name) => name.toLowerCase() === 'ffmpeg.exe')[0]
if (!ffmpegExe) throw new Error('FFmpeg 压缩包中缺少 ffmpeg.exe')
copyRuntimeFolder(ffmpegExe, ['ffmpeg.exe', 'ffprobe.exe'])
manifest.components.ffmpeg = { tag: ffmpegRelease.tag_name, asset: ffmpegAsset.name }

const whisperRelease = await json('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest')
const whisperAsset = whisperRelease.assets.find((asset) => /^whisper-bin-x64\.zip$/i.test(asset.name))
  ?? whisperRelease.assets.find((asset) => /bin.*x64.*\.zip$/i.test(asset.name))
if (!whisperAsset) throw new Error('没有找到 Windows x64 whisper.cpp 构建')
const whisperZip = join(tempDir, basename(whisperAsset.name))
await download(whisperAsset.browser_download_url, whisperZip)
const whisperExtracted = join(tempDir, 'whisper')
extract(whisperZip, whisperExtracted)
const whisperExe = findFiles(whisperExtracted, (name) => name.toLowerCase() === 'whisper-cli.exe')[0]
if (!whisperExe) throw new Error('whisper.cpp 压缩包中缺少 whisper-cli.exe')
copyRuntimeFolder(whisperExe, ['whisper-cli.exe'])
for (const unused of ['llama.dll', 'parakeet.dll', 'SDL2.dll']) {
  rmSync(join(binDir, unused), { force: true })
}
manifest.components.whisper = { tag: whisperRelease.tag_name, asset: whisperAsset.name }

writeFileSync(join(binDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
rmSync(tempDir, { recursive: true, force: true })

const files = readdirSync(binDir).filter((name) => name !== 'README.txt')
console.log(`Runtime ready: ${files.join(', ')}`)
