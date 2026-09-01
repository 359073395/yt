import { describe, expect, it } from 'vitest'
import { extractSharedUrls, platformName } from './core'

describe('extractSharedUrls', () => {
  it('extracts links from Chinese share text and removes duplicates', () => {
    expect(extractSharedUrls('长按复制 https://v.douyin.com/demo/，再次 https://v.douyin.com/demo/')).toEqual([
      'https://v.douyin.com/demo/',
    ])
  })

  it('extracts mixed-platform batches', () => {
    expect(extractSharedUrls('A https://youtu.be/a\nB https://www.tiktok.com/@x/video/1')).toHaveLength(2)
  })
})

describe('platformName', () => {
  it('recognizes short Douyin URLs', () => {
    expect(platformName('https://v.douyin.com/demo/')).toBe('抖音')
  })
})
