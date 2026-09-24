import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('three-size desktop typography', () => {
  for (const file of ['styles.css', 'workbench.css', 'team.css', 'automation.css']) {
    it(`${file} only uses the agreed 14/16/20 px text sizes`, () => {
      const css = readFileSync(new URL(file, import.meta.url), 'utf8')
      const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
      expect(sizes.length).toBeGreaterThan(0)
      expect(sizes.every(size => [14, 16, 20].includes(size))).toBe(true)
    })
  }
})
