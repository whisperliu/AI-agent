/**
 * ocr/mock.ts — MockOcr（§60）。层：capability。
 * 从预置的"截图→文本+置信"映射返回，用于 P1 与低置信样本测试。
 */
import type { Ocr, OcrBox, OcrResult } from './reader.ts'

export interface MockOcrEntry {
  text: string
  confidence: number
}

/** 用一组文本条目构造 MockOcr；read 依次返回下一个（或同一个）。 */
export function createMockOcr(entries: MockOcrEntry[]): Ocr {
  let i = 0
  return {
    async read(_png: Uint8Array, _roi?: OcrBox): Promise<OcrResult> {
      const e = entries[Math.min(i, entries.length - 1)]
      i++
      if (!e) return { text: '', words: [] }
      const words = e.text
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => ({
          t,
          c: e.confidence,
          bbox: { x: 0, y: 0, w: 0, h: 0 },
        }))
      return { text: e.text, words }
    },
  }
}
