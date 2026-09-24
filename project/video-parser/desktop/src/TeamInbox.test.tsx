import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AutoDownloadControl, TeamInbox } from './TeamInbox'

describe('personal Feishu onboarding', () => {
  it('shows one-click official binding without manual credentials or a relay URL', () => {
    const html = renderToStaticMarkup(<TeamInbox open onClose={() => undefined} runtime={null} defaultDir={'E:\\视频'} provider="api" modelId="small" />)
    expect(html).toContain('连接我的飞书机器人')
    expect(html).toContain('一键绑定飞书')
    expect(html).not.toContain('App ID')
    expect(html).not.toContain('type="password"')
    expect(html).toContain('E:\\视频')
    expect(html).not.toContain('公司收件服务地址')
    expect(html).not.toContain('扫码登录')
    expect(html).toContain('官方页面确认创建及授权')
  })
  it('keeps advanced options collapsed for first-time setup and explains offline limitations', () => {
    const html = renderToStaticMarkup(<TeamInbox open onClose={() => undefined} runtime={null} defaultDir={'E:\\视频'} provider="api" modelId="small" />)
    expect(html).toContain('<details class="team-download-options">')
    expect(html).toContain('电脑离线时不会下载')
    expect(html).toContain('不能多台电脑共用同一个应用')
    expect(html).toContain('不是模型目录')
  })
  it('keeps the automatic download control explicit and accessible when paused', () => {
    const html = renderToStaticMarkup(<AutoDownloadControl enabled={false} busy={false} onToggle={() => undefined} />)
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('开启自动下载')
    expect(html).not.toContain('disabled')
  })
  it('shows how to pause, and blocks repeated requests during a save', () => {
    const html = renderToStaticMarkup(<AutoDownloadControl enabled busy onToggle={() => undefined} />)
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('点击暂停')
    expect(html).toContain('disabled')
  })
})
