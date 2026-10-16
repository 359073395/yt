import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function publicChannel(manifest, version, repository) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.version !== version) throw new Error('Update version differs from package')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository')
  if (!manifest.platforms?.['windows-x86_64'] && !manifest.platforms?.['windows-x86_64-nsis']) throw new Error('Windows updater platform missing')
  const platforms = Object.fromEntries(Object.entries(manifest.platforms).map(([key, platform]) => {
    if (!key.startsWith('windows-x86_64') || !platform.signature?.trim()) throw new Error('Unexpected or unsigned update platform')
    return [key, { ...platform, url: `https://github.com/${repository}/releases/download/video-parser-desktop-v${version}/Paoliang-YingLian_${version}_x64-setup.exe` }]
  }))
  return { ...manifest, platforms }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, repository] = process.argv.slice(2)
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''))
  writeFileSync(output, JSON.stringify(publicChannel(manifest, version, repository), null, 2) + '\n')
}
