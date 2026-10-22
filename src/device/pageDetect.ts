/**
 * device/pageDetect.ts — 页面识别（多信号融合，§3.5.4(2)(3)）。
 * 层：capability（device）。**纯函数**：喂 dump 文本 + 页面契约即可判定"当前在哪一页"。
 *
 * 三路信号：① 稳定 resource-id / 文案（首选）② 结构特征（tree 丰富度）③ 页面契约 anchor。
 * 无截图基线（P2 不做 pHash，避免引入图像库）；截图相似度作为 P3 的可选增强。
 */
import type { UiSelector } from './driver.ts'
import { analyzeDump } from './probe.ts'
import { findBySelector, parseUiNodes } from './uixml.ts'

/** 单页识别契约（写进 platform strategies，§3.5.3）。 */
export interface PageContract {
  page: string
  /** 任一 anchor 命中即视为该页（resource-id / 文案）。 */
  anchors: UiSelector[]
  /** 必须同时满足的文案（可选）。 */
  requireTexts?: string[]
}

export interface PageSignal {
  page: string
  confidence: 'high' | 'medium' | 'low'
  matchedBy: string[]
  /** 建议：tree 可靠 / 建议 OCR / 需人工（来自页面 dump 质量）。 */
  recommend: 'tree' | 'ocr' | 'human'
}

/**
 * 判定当前页面。命中 anchor 且 dump 质量好 → high；仅命中 anchor 但质量差 → medium + 建议 OCR；
 * 未命中任何契约 → page='unknown' + recommend 依据质量。
 */
export function detectPage(dump: string, contracts: PageContract[]): PageSignal {
  const nodes = parseUiNodes(dump)
  const quality = analyzeDump(dump)
  for (const c of contracts) {
    const matched: string[] = []
    let anchorHit = false
    for (const a of c.anchors) {
      if (findBySelector(nodes, a)) {
        anchorHit = true
        matched.push(a.resourceId ?? a.label ?? a.text ?? '?')
      }
    }
    const textsOk =
      !c.requireTexts ||
      c.requireTexts.every((t) =>
        nodes.some((n) => (n.text ?? '').includes(t) || (n.label ?? '').includes(t)),
      )
    if (anchorHit && textsOk) {
      const confidence: PageSignal['confidence'] =
        quality.recommend === 'tree' ? 'high' : quality.recommend === 'ocr' ? 'medium' : 'low'
      return { page: c.page, confidence, matchedBy: matched, recommend: quality.recommend }
    }
  }
  return { page: 'unknown', confidence: 'low', matchedBy: [], recommend: quality.recommend }
}
