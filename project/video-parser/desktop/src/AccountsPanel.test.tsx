import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountRows } from './AccountsPanel'

describe('platform account status', () => {
  it('shows real per-platform state instead of assuming every account is logged in', () => {
    const html = renderToStaticMarkup(<AccountRows statuses={[{ platform: 'douyin', state: 'detected', detail: '本机已有会话' }, { platform: 'tiktok', state: 'anonymous', detail: '未检测到会话' }]} opening={null} onLogin={() => {}} />)
    expect(html).toContain('已检测到登录会话')
    expect(html).toContain('未检测到登录')
    expect(html).not.toContain('登录验证成功')
    expect(html.match(/官方登录/g)?.length).toBe(7)
  })
  it('shows pending synchronization with actionable details', () => {
    const html = renderToStaticMarkup(<AccountRows statuses={[{ platform: 'douyin', state: 'pending', detail: '请关闭官方登录窗口' }]} opening="douyin" onLogin={() => {}} />)
    expect(html).toContain('等待同步')
    expect(html).toContain('请关闭官方登录窗口')
    expect(html).toContain('正在打开…')
    expect(html).toContain('disabled')
  })
})
