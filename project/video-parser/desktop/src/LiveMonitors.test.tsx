import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveMonitors } from './LiveMonitors'
import { emptyAutomation, type AutomationSnapshot } from './automation'

describe('live monitor status and controls', () => {
  it('shows waiting, limits and an accessible list without claiming a recording', () => {
    const snapshot: AutomationSnapshot = { ...emptyAutomation, monitors: [{ id: 'm', request: { url: 'https://www.tiktok.com/@sample', name: '样本', root: 'E:\\视频', category: '参考', minutes: 60, max_gb: 4 }, interval_seconds: 60, enabled: true, checking: false, last_checked: 0, next_check: 0, detail: '当前未开播，继续监控', recording_id: '' }] }
    const html = renderToStaticMarkup(<LiveMonitors snapshot={snapshot} busy={false} command={async () => {}} />)
    expect(html).toContain('开播监控列表')
    expect(html).toContain('当前未开播，继续监控')
    expect(html).toContain('每场最多 60 分钟 / 4 GB')
    expect(html).toContain('暂停监控')
    expect(html).not.toContain('自动录制中')
    snapshot.monitors[0].enabled = false
    const paused = renderToStaticMarkup(<LiveMonitors snapshot={snapshot} busy={false} command={async () => {}} />)
    expect(paused).toContain('已暂停'); expect(paused).toContain('恢复监控')
  })
})
