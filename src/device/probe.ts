/**
 * device/probe.ts — 设备能力探测与页面识别降级判据（§3.5.4）。
 * 层：capability（device）。**分析函数是纯函数**（喂 dump 文本即可离线单测）；
 * 真机采集（getprop / wm size / dumpsys）在 `adb.ts` 的 `probe()` 里完成。
 */

import { countResourceIds, countTextNodes, hasWebview, parseUiNodes } from './uixml.ts'

/** 单个页面的识别质量（决定"控件树优先 / 降级 OCR"）。 */
export interface DumpQuality {
  /** 可读文本节点数（text + content-desc）。 */
  textNodes: number
  /** 带 resource-id 的节点数。 */
  resourceIds: number
  /** 是否出现 WebView 迹象（H5 页面 dump 常为空壳）。 */
  hasWebview: boolean
  /** 综合树丰富度 0..1（文本与资源 id 兼顾）。 */
  treeRichness: number
  /** 识别建议：tree 可靠 / 建议 OCR 兜底 / 需人工。 */
  recommend: 'tree' | 'ocr' | 'human'
}

/** 从 dump 文本评估页面识别质量（纯函数）。 */
export function analyzeDump(xml: string): DumpQuality {
  const nodes = parseUiNodes(xml)
  const textNodes = countTextNodes(nodes)
  const resourceIds = countResourceIds(nodes)
  const webview = hasWebview(nodes)
  // 归一化：文本节点给主要权重；resourceId 反映控件可定位性。
  const richness = Math.max(
    0,
    Math.min(1, textNodes / 40) * 0.6 + Math.min(1, resourceIds / 30) * 0.4,
  )
  let recommend: DumpQuality['recommend'] = 'tree'
  if (webview && textNodes < 5) recommend = 'ocr'
  else if (textNodes === 0 && resourceIds === 0) recommend = 'human'
  else if (richness < 0.15) recommend = 'ocr'
  return {
    textNodes,
    resourceIds,
    hasWebview: webview,
    treeRichness: Number(richness.toFixed(3)),
    recommend,
  }
}

/** 设备能力探测结果（每次任务开始跑一次，结果可缓存，§3.5.4(1)）。 */
export interface DeviceProbe {
  /** dump 是否可用。 */
  canDump: boolean
  /** dump 耗时（毫秒）。 */
  dumpLatencyMs: number
  /** 屏幕分辨率（来自 `wm size`，如 "1080x2400"）。 */
  resolution?: string
  /** 屏幕密度（来自 `wm density`）。 */
  density?: string
  /** 当前前台包名/Activity（来自 dumpsys window）。 */
  foreground?: string
  /** 当前页面的识别质量。 */
  quality: DumpQuality
  /** 截屏是否可用（PNG 魔数校验）。 */
  canScreenshot: boolean
  /** 对设备型号（`getprop ro.product.model`）。 */
  model?: string
  /** Android 版本（`getprop ro.build.version.release`）。 */
  androidVersion?: string
}

/** 判断 PNG 字节是否有效（魔数 89 50 4E 47）。 */
export function isValidPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
}

/** 从 `wm size` 输出解析分辨率。 */
export function parseWmSize(out: string): string | undefined {
  const m = /Override size:\s*(\d+x\d+)/i.exec(out) ?? /Physical size:\s*(\d+x\d+)/i.exec(out)
  return m ? m[1] : undefined
}

/** 从 dumpsys window 输出解析前台包名（mCurrentFocus / mFocusedApp）。 */
export function parseForeground(out: string): string | undefined {
  const m =
    /mCurrentFocus=.*?\s([\w.]+)\/[\w.$]+/.exec(out) ?? /mFocusedApp=.*?\s([\w.]+)\//.exec(out)
  return m ? m[1] : undefined
}
