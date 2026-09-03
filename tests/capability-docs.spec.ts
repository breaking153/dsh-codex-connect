import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('capability documentation', () => {
  it('keeps the bilingual command and evidence terminology synchronized', async () => {
    const pairing = await readFile(new URL('../README.i18n.yaml', import.meta.url), 'utf8')
    for (const path of ['README.md', 'docs/README.zh.md']) {
      const bytes = Buffer.from((await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n?/gu, '\n'))
      const text = bytes.toString('utf8')
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      expect(pairing).toContain(`${path}: ${hash}`)
      for (const term of ['capabilities --model gpt-5.6-sol --json', 'capabilities --model gpt-5.6-sol --probe --json', 'auto-review-probe --json', '--timeout-ms <1..60000>', '--proxy <http(s)-origin>', 'supported', 'rejected', 'unknown', '64 KiB']) expect(text).toContain(term)
    }

    const designPairing = await readFile(new URL('../docs/design.i18n.yaml', import.meta.url), 'utf8')
    for (const path of ['docs/design.md', 'docs/design.zh.md']) {
      const bytes = Buffer.from((await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n?/gu, '\n'))
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      expect(designPairing).toContain(`${path.slice('docs/'.length)}: ${hash}`)
    }
  })
})
