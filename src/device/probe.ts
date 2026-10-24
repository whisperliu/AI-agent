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

/**
 * 窗口几何（真机坐标映射必需，P5 修复）。
 * `uiautomator dump` 的 `bounds` 是**当前 App 窗口内**坐标；`input tap` 用的是**屏幕**坐标。
 * 当 App 被 letterbox（横屏跑竖屏 App）或处于分屏/自由窗口时，两者存在偏移与尺寸差异，
 * 不补偿就会"每一下都点偏"（真机踩坑：偏移 641px，全部点击无效）。
 */
export interface WindowGeometry {
  /** 屏幕真实尺寸（来自 `dumpsys window displays` 的 mBounds，非 wm size 的物理值）。 */
  screenW: number
  screenH: number
  /** 当前 App 窗口在屏幕上的位置（`dumpsys activity` 的 mAppBounds）。 */
  appX: number
  appY: number
  appW: number
  appH: number
  /** 是否处于非全屏（分屏/自由窗口/画中画）。 */
  multiWindow: boolean
  /** 是否 letterbox（横屏下跑竖屏 App，两侧黑边）。 */
  letterboxed: boolean
}

/**
 * 从 **聚焦窗口** 的实际配置解析窗口几何（纯函数，P5）。
 *
 * 输入：
 *  - `screenBounds`：`dumpsys window displays` 里的 display `mBounds=Rect(...)`（真实屏幕尺寸）。
 *  - `focusedWindowBlock`：`dumpsys window windows` 中**聚焦窗口**那一段（含 `mFullConfiguration`）。
 *
 * 依据：`uiautomator dump` 只 dump **聚焦窗口**，其 bounds 是**窗口内坐标**；
 * 而 `input tap` 用**屏幕坐标**，故必须取该窗口的 `winConfig.mBounds` 作偏移。
 * 真机踩坑（联想平板 PC 模式）：App 以浮窗开在右半屏，dump bounds 从 0 起算 → 全部点偏。
 */
export function parseWindowGeometry(
  screenBounds: string,
  focusedWindowBlock: string,
): WindowGeometry | undefined {
  const sb = /mBounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/.exec(screenBounds)
  const fb = /mBounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/.exec(focusedWindowBlock)
  if (!sb || !fb) return undefined
  const screenW = Number(sb[3]) - Number(sb[1])
  const screenH = Number(sb[4]) - Number(sb[2])
  const appX = Number(fb[1])
  const appY = Number(fb[2])
  const appW = Number(fb[3]) - appX
  const appH = Number(fb[4]) - appY
  if (!(screenW > 0 && screenH > 0 && appW > 0 && appH > 0)) return undefined

  const smallerThanScreen = appW < screenW - 2 || appH < screenH - 2
  const letterboxFlag = /mAreBoundsLetterboxed=true/.test(focusedWindowBlock)
  const multiWindowMode = /mWindowingMode=multi-window/.test(focusedWindowBlock)
  return {
    screenW,
    screenH,
    appX,
    appY,
    appW,
    appH,
    multiWindow: multiWindowMode || (smallerThanScreen && !letterboxFlag),
    letterboxed: smallerThanScreen && letterboxFlag,
  }
}

/** 从 `dumpsys window` 提取聚焦窗口的 token（如 `d3d2a47`），用于在 window windows 里定位其段。 */
export function parseFocusToken(windowDump: string): string | undefined {
  const m = /mCurrentFocus=Window\{([0-9a-f]+)\s/.exec(windowDump)
  return m ? m[1] : undefined
}

/** 从 `dumpsys window windows` 里截出指定 token 的窗口段（到下一个 `Window #` 为止）。 */
export function sliceWindowBlock(windowWindows: string, token: string): string | undefined {
  const marker = new RegExp(`Window\\{[0-9a-f]*${token}[^}]*\\}:`)
  const m = marker.exec(windowWindows)
  if (!m) return undefined
  const startIdx = m.index
  const rest = windowWindows.slice(startIdx + m[0].length)
  const nextIdx = rest.search(/\n\s*Window #\d+ /)
  return nextIdx >= 0 ? rest.slice(0, nextIdx) : rest
}

/**
 * 把 dump 坐标映射为 `input tap` 需要的**屏幕坐标**（纯函数）。
 *
 * ⚠️ 真机实测：`uiautomator dump` 的 bounds **不总是同一坐标系**——
 *  - 多数情况是**屏幕绝对坐标**（窗口在 x=641 时，bounds 也从 669 起算）；
 *  - 少数情况（浮窗/刚切窗口）返回**窗口内坐标**（从 0 起算）。
 * 因此**不能无脑加偏移**（否则偏移两次）。用 dump 的实际边界自动判定：
 *   dump 坐标上限 ≈ 窗口尺寸（且窗口有偏移）→ 判为"窗口内坐标"，加偏移；
 *   否则判为"屏幕坐标"，原样返回。
 *
 * @param extent dump 中节点的最大右/下边界（判定坐标系用；缺省视为屏幕坐标）。
 */
export function toScreenPoint(
  geo: WindowGeometry,
  x: number,
  y: number,
  extent?: { maxRight?: number; maxBottom?: number },
): { x: number; y: number } {
  const hasOffset = geo.appX > 0 || geo.appY > 0
  const looksWindowLocal =
    !!extent &&
    typeof extent.maxRight === 'number' &&
    typeof extent.maxBottom === 'number' &&
    extent.maxRight <= geo.appW + 2 &&
    extent.maxBottom <= geo.appH + 2
  if (hasOffset && looksWindowLocal) {
    return { x: Math.round(geo.appX + x), y: Math.round(geo.appY + y) }
  }
  return { x: Math.round(x), y: Math.round(y) }
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
  /** 窗口几何（P5：坐标映射与"分屏/letterbox 不可自动化"判定）。 */
  geometry?: WindowGeometry
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
