import React from 'react'
import { CheckCircle2, CircleStop, Copy, Download, FolderOpen, ImageOff, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { LibraryRecord } from './library'
import { isActive, visibleStages } from './library'

export const MediaCard = React.memo(function MediaCard({ record, onSelect, onEdit, onOpen, onCopy, onCancel, onRetry, onRemove, removalBusy = false }: {
  record: LibraryRecord; onSelect: () => void; onEdit: () => void; onOpen: () => void; onCopy: () => void; onCancel: () => void; onRetry: () => void; onRemove: () => void; removalBusy?: boolean
}) {
  const { item, task, source } = record
  const [badImage, setBadImage] = React.useState(false)
  React.useEffect(() => setBadImage(false), [item.thumbnail])
  const stages = visibleStages(task)
  const done = task?.status === 'completed'
  const retry = ['partial', 'failed', 'cancelled'].includes(task?.status || '')
  const seconds = Math.round(item.duration || 0)
  return <article className={`asset-card ${task?.status || 'waiting'}`} aria-label={item.title}>
    <div className="asset-cover">
      {item.thumbnail && !badImage ? <img src={item.thumbnail} loading="lazy" alt={item.title} onError={() => setBadImage(true)} /> : <div className="cover-unavailable"><ImageOff size={28} /><span>{item.loading ? '正在读取封面' : '暂无可用封面'}</span></div>}
      {source === 'manual' && <input className="asset-selection" type="checkbox" checked={item.selected} disabled={isActive(task)} aria-label={`选择 ${item.title}`} onChange={onSelect} />}
      {!!seconds && <span className="asset-duration">{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</span>}
    </div>
    <div className="asset-content">
      <div className="asset-heading"><h3 title={item.title}>{item.title}</h3><button className="icon-button" aria-label={`修改 ${item.title} 的分类备注`} onClick={onEdit} disabled={isActive(task)}><Pencil size={17} /></button></div>
      <div className="asset-byline"><span>{item.platform}</span><span title={item.uploader}>{item.uploader}</span>{source === 'feishu' && <span>飞书收件</span>}</div>
      <p className="asset-note" title={item.note || item.category}>{item.note || `分类：${item.category}`}</p>
      <div className="asset-status" aria-live="polite">
        <span className={done || task?.outputDir ? 'stage-saved' : ''}>{(done || task?.outputDir) && <CheckCircle2 size={18} />}{stages.video}</span>
        {stages.text && <span className={task?.status === 'translating' ? 'stage-active' : ''}>{stages.text}</span>}
        {stages.progress !== undefined && <progress aria-label={`${item.title} ${task?.status === 'translating' ? '翻译' : '处理'}进度`} max={100} value={Math.max(0, Math.min(100, stages.progress))} />}
        {(retry || item.error) && <p className="asset-error">{task?.message || item.error}</p>}
      </div>
      <div className="asset-actions">
        {task?.outputDir && <button title={task.outputDir} onClick={onOpen}><FolderOpen size={17} />打开文件夹</button>}
        {done && <button onClick={onCopy}><Copy size={17} />复制文案</button>}
        {isActive(task) && source === 'manual' && <button onClick={onCancel}><CircleStop size={17} />取消</button>}
        {retry && <button onClick={onRetry}><RefreshCw size={17} />{task?.result?.segments.length ? '重试文案' : '重试'}</button>}
        {!task && source === 'manual' && <button onClick={onRetry}><Download size={17} />下载</button>}
        <button onClick={onRemove} disabled={removalBusy || item.loading || isActive(task)} title={isActive(task) || item.loading ? '任务正在处理中，结束后可删除记录' : '只删除记录，保留本地文件'}><Trash2 size={17} />删除记录</button>
      </div>
    </div>
  </article>
})
