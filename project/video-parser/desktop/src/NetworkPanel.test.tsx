import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { NetworkFields, defaultNetwork } from './NetworkPanel'
describe('local proxy UI', () => {
  it('shows the entire HTTP address in manual mode and allows domestic direct routing', () => {
    const html = renderToStaticMarkup(<NetworkFields value={{ ...defaultNetwork, mode: 'manual' }} disabled={false} onChange={() => {}} />)
    expect(html).toContain('http://127.0.0.1:10808')
    expect(html).toContain('本机 HTTP 代理地址')
    expect(html).toContain('抖音 / 哔哩哔哩直连')
  })
  it('has explicit system/direct modes and prevents changes during requests', () => {
    const html = renderToStaticMarkup(<NetworkFields value={defaultNetwork} disabled onChange={() => {}} />)
    expect(html).toContain('跟随本机系统代理')
    expect(html).toContain('关闭代理（直连）')
    expect(html).toContain('disabled')
    expect(html).not.toContain('placeholder=')
  })
})
