import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FeishuBinding, type Registration } from './FeishuBinding'

const base = { configured: false, ownerKnown: false, pair: null, connection: '', busy: false, onAction: () => undefined }
const waiting: Registration = { status: 'waiting', message: '等待确认', qr: 'data:image/svg+xml;base64,fixture', expires: Date.now() + 600_000 }
describe('official Feishu authorization states', () => {
  it('shows QR, remaining time, open-in-browser and cancel without exposing credentials', () => {
    const html = renderToStaticMarkup(<FeishuBinding {...base} registration={waiting} />)
    for (const text of ['官方创建机器人授权二维码', '剩余', '在浏览器打开官方授权页', '取消本次绑定']) expect(html).toContain(text)
    expect(html).not.toContain('client_secret')
  })
  it('never displays expired QR or stale open link', () => {
    const html = renderToStaticMarkup(<FeishuBinding {...base} registration={{ ...waiting, expires: 1 }} />)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('在浏览器打开官方授权页')
    expect(html).toContain('重新生成二维码')
  })
  it('shows errors and allows regeneration without claiming completion', () => {
    const html = renderToStaticMarkup(<FeishuBinding {...base} registration={{ ...waiting, status: 'failed', message: '你已拒绝授权', qr: '' }} />)
    expect(html).toContain('你已拒绝授权')
    expect(html).toContain('重新生成二维码')
    expect(html).not.toContain('绑定完成')
  })
  it('requires actual inbound verification after authorization, without an unnecessary pair code', () => {
    const html = renderToStaticMarkup(<FeishuBinding {...base} configured ownerKnown registration={null} connection="已连接飞书" />)
    expect(html).toContain('授权已保存 · 等待收件验证')
    expect(html).toContain('连接测试')
    expect(html).not.toContain('恢复配对码验证')
    expect(html).not.toContain('重新生成二维码')
  })
  it('provides secure recovery when authorization did not return an owner ID', () => {
    const html = renderToStaticMarkup(<FeishuBinding {...base} configured registration={null} />)
    expect(html).toContain('恢复配对码验证')
  })
})
