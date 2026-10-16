import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadVerified, sha256 } from './runtime-download.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const binDir = join(root, 'src-tauri', 'resources', 'bin')
const cacheDir = join(root, '.runtime-download')
mkdirSync(binDir, { recursive: true })
mkdirSync(cacheDir, { recursive: true })
const stage = mkdtempSync(join(cacheDir, 'stage-'))
const lock = JSON.parse(readFileSync(new URL('./runtime-lock.json', import.meta.url), 'utf8'))

function psQuote(value) { return `'${value.replaceAll("'", "''")}'` }
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
function extract(zip, destination) {
  mkdirSync(destination, { recursive: true })
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(destination)} -Force`], { stdio: 'inherit' })
}
function copyRuntime(source, requiredNames) {
  const executable = files(source).find(path => basename(path).toLowerCase() === requiredNames[0])
  if (!executable) throw new Error(`Upstream archive missing ${requiredNames[0]}`)
  const sourceDir = dirname(executable)
  for (const name of requiredNames) {
    if (!statSync(join(sourceDir, name)).isFile()) throw new Error(`Missing ${name}`)
  }
  for (const name of readdirSync(sourceDir)) {
    if (name.endsWith('.dll') || requiredNames.includes(name.toLowerCase())) {
      if (!['llama.dll', 'parakeet.dll', 'SDL2.dll'].includes(name)) copyFileSync(join(sourceDir, name), join(stage, name))
    }
  }
  const licenses = files(source).filter(path => /^(licen[cs]e|copying|notice)/i.test(basename(path)))
  for (const [index, path] of licenses.entries()) {
    const dest = join(stage, 'licenses', `${requiredNames[0]}-${index}-${basename(path)}`)
    mkdirSync(dirname(dest), { recursive: true }); copyFileSync(path, dest)
  }
}

try {
  for (const [name, names] of [['ytDlp', ['yt-dlp.exe']], ['ffmpeg', ['ffmpeg.exe', 'ffprobe.exe']], ['whisper', ['whisper-cli.exe']]]) {
    const component = lock[name]
    const archive = join(cacheDir, `${component.sha256}-${basename(new URL(component.url).pathname)}`)
    console.log(`${name}: ${component.version} (${await downloadVerified(component.url, archive, component.sha256)})`)
    if (name === 'ytDlp') copyFileSync(archive, join(stage, 'yt-dlp.exe'))
    else {
      const extracted = join(stage, name)
      extract(archive, extracted)
      copyRuntime(extracted, names)
    }
  }
  // Probe all engines before replacing any packaged runtime.
  const probes = {
    ytDlp: execFileSync(join(stage, 'yt-dlp.exe'), ['--version'], { encoding: 'utf8' }).trim(),
    ffmpeg: execFileSync(join(stage, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0],
    whisper: execFileSync(join(stage, 'whisper-cli.exe'), ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  }
  if (probes.ytDlp !== lock.ytDlp.version || !probes.ffmpeg.includes(lock.ffmpeg.version)) throw new Error('Runtime version probe differs from lock')
  const manifest = { generatedAt: new Date().toISOString(), checkedAt: lock.checkedAt, components: {}, files: {} }
  for (const name of ['ytDlp', 'ffmpeg', 'whisper']) manifest.components[name] = { ...lock[name], probe: probes[name] || 'CLI help exited successfully' }
  const fresh = readdirSync(stage).filter(name => statSync(join(stage, name)).isFile())
  // Only obsolete runtime binaries in this project's bin directory are removed.
  // User models, plugins and installed application data are untouched.
  for (const name of readdirSync(binDir)) {
    if ((name.endsWith('.dll') || ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'whisper-cli.exe'].includes(name)) && !fresh.includes(name)) rmSync(join(binDir, name))
  }
  for (const name of fresh) {
    copyFileSync(join(stage, name), join(binDir, name))
    manifest.files[name] = { bytes: statSync(join(binDir, name)).size, sha256: await sha256(join(binDir, name)) }
  }
  const licenseDir = join(stage, 'licenses')
  for (const path of files(stage).filter(path => !relative(licenseDir, path).startsWith('..'))) {
    const dest = join(binDir, relative(stage, path)); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(path, dest)
  }
  writeFileSync(join(binDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Verified ${fresh.length} runtime files; local models and account data untouched`)
} finally {
  const rel = relative(resolve(cacheDir), resolve(stage))
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || !basename(stage).startsWith('stage-')) throw new Error('Unsafe staging cleanup path')
  rmSync(stage, { recursive: true, force: true })
}
