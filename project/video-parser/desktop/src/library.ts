import type { DownloadTask, MediaPreview, TaskStatus } from './core'

export interface PendingItem extends MediaPreview {
  id: string
  selected: boolean
  quality: string
  loading: boolean
  downloaded?: boolean
  category: string
  note: string
  created: number
  automationId?: string
  autoDownload?: boolean
}
export interface LibraryRecord {
  item: PendingItem
  task?: DownloadTask
  source: 'manual' | 'feishu'
}
export interface LibraryJournal {
  version: 1
  items: PendingItem[]
  tasks: DownloadTask[]
  categories: string[]
}
export const activeStatuses: TaskStatus[] = ['queued', 'scanning', 'downloading', 'transcribing', 'translating']
export function isActive(task?: DownloadTask) { return !!task && activeStatuses.includes(task.status) }

// The native directory layer repeats these checks. Never allow a category to escape the chosen root.
export function normalizeCategory(value: string): string {
  const parts = value.trim().replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length) return '待分类'
  if (parts.length > 5) throw new Error('分类最多 5 层')
  for (const part of parts) {
    if (part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error('分类包含不能用于文件夹的字符')
    if (part.length > 60) throw new Error('每层分类不超过 60 字')
  }
  return parts.join('/')
}
export function categoryDirectory(root: string, category: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${normalizeCategory(category).split('/').join(separator)}`
}
export function restoreLibrary(value: unknown): LibraryJournal {
  const empty: LibraryJournal = { version: 1, items: [], tasks: [], categories: [] }
  if (!value || typeof value !== 'object') return empty
  const data = value as Partial<LibraryJournal>
  if (data.version !== 1) throw new Error('素材库版本不兼容；已停止写入，原数据未改动')
  if (!Array.isArray(data.items) || !Array.isArray(data.tasks) || !Array.isArray(data.categories)) throw new Error('素材库格式损坏；原数据未改动')
  if (data.items.some(item => !item || typeof item.id !== 'string' || typeof item.url !== 'string' || (item.category != null && typeof item.category !== 'string')) || data.categories.some(category => typeof category !== 'string')) throw new Error('素材库记录损坏；已停止写入，原数据未改动')
  const items = data.items.map(item => ({ ...item, loading: false, category: normalizeCategory(item.category || '待分类'), note: typeof item.note === 'string' ? item.note : '', created: Number(item.created) || 0 }))
  const ids = new Set(items.map(item => item.id))
  const tasks = data.tasks.filter(task => task && ids.has(task.queueItemId)).map(task => isActive(task)
    ? { ...task, status: task.outputDir ? 'partial' as const : 'cancelled' as const, message: task.outputDir ? '上次处理已中断；已保存文件保留，可重试文案' : '上次任务已中断，请重新开始' }
    : task)
  return { version: 1, items, tasks, categories: data.categories.map(normalizeCategory) }
}
export function filterRecords(records: LibraryRecord[], category: string, search: string, status: string, view: string) {
  const term = search.trim().toLocaleLowerCase()
  return records.filter(({ item, task }) => {
    if (view === 'tasks' && task?.status === 'completed') return false
    if (category !== '*' && item.category !== category && !item.category.startsWith(`${category}/`)) return false
    if (status === 'active' && !isActive(task)) return false
    if (status === 'completed' && task?.status !== 'completed') return false
    if (status === 'issues' && !['partial', 'failed', 'cancelled'].includes(task?.status || '')) return false
    return `${item.title} ${item.uploader} ${item.note} ${item.platform} ${item.category}`.toLocaleLowerCase().includes(term)
  })
}
export function visibleStages(task?: DownloadTask) {
  if (!task) return { video: '等待下载', text: '', progress: undefined }
  if (task.status === 'completed') return { video: '所选内容已完成', text: '', progress: undefined }
  if (task.status === 'partial') return { video: '已有文件已保存', text: '部分内容待重试', progress: undefined }
  if (task.status === 'failed') return { video: '下载失败', text: '', progress: undefined }
  if (task.status === 'cancelled') return { video: task.outputDir ? '已有文件已保存' : '已取消', text: task.outputDir ? '后续处理已取消' : '', progress: undefined }
  if (task.status === 'translating') return { video: '已有文件已保存', text: `文案翻译 ${Math.round(task.percent)}%`, progress: task.percent }
  if (task.status === 'transcribing') return { video: '视频处理中', text: `提取文案 ${Math.round(task.percent)}%`, progress: task.percent }
  return { video: task.status === 'queued' ? '排队中' : `下载中 ${Math.round(task.percent)}%`, text: '', progress: task.status === 'queued' ? undefined : task.percent }
}
