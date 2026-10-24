/**
 * platform/navigator.ts — 真机导航原语（平台共享，无平台知识）。
 * 层：strategy。把 `Driver` 包装成"节点/等待/点击/滚动"的 Navigator，并用
 * `device/steps.waitForAnyState` 提供 OR 语义的锚点等待（验证码/登录即停 + 超时取证）。
 *
 * 本文件只做通用能力；各平台"首页→搜索→选店→加购→结算"的具体文案/顺序在各 *Real.ts。
 */
import type { UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import { waitForAnyState } from '../device/steps.ts'
import type { Driver, UiSelector } from '../device/driver.ts'
import { firstActionableCenter, firstResultCardCenter } from './settleRows.ts'

export interface Navigator {
  /** 当前界面节点。 */
  nodes(): Promise<UiNode[]>
  /** 当前界面原始 dump（写证据）。 */
  dump(): Promise<string>
  /** 截屏（PNG 字节），用于 canvas 自绘 App 的 OCR 兜底。可选。 */
  screencap?(): Promise<Uint8Array>
  /** 按选择器点击（安全护栏在 driver.tap 内部）。 */
  tap(sel: UiSelector, what: string): Promise<void>
  /** 按屏幕坐标点击（安全：driver.tapPoint 内部会解析命中节点并过 assertTapSafe）。可选（Mock 无）。 */
  tapPoint?(x: number, y: number, what: string): Promise<void>
  /** 按选择器输入文本。 */
  input(sel: UiSelector, text: string, what: string): Promise<void>
  /** 等待锚点（任一命中），返回最新节点与 dump；命中验证码/登录抛 NeedsHumanError。 */
  waitAny(
    anchors: UiSelector[],
    what: string,
    timeoutMs?: number,
  ): Promise<{ nodes: UiNode[]; dump: string }>
  /** 向上滚动一屏。 */
  swipeUp(): Promise<void>
  /** 第一个"可点击结果卡"中心点（搜索结果页进入店铺用）。无则 undefined。 */
  firstResultCard?(): Promise<{ x: number; y: number } | undefined>
  /** 第一个"文案命中任一关键词且可点"的控件中心点（加购/去结算等用）。 */
  firstActionable?(keywords: string[]): Promise<{ x: number; y: number } | undefined>
  /** 轻量重取一帧（让 UI 稳定后重新定位；实现通常是一次 dump）。 */
  repaint?(): Promise<void>
  /** 当前界面是否存在文案命中任一关键词的节点（用于"滚动后再找"）。 */
  hasAny?(keywords: string[]): Promise<boolean>
}

/** 由 Driver 构造 Navigator（在 platform 内成型，避免把"具体实现"下沉到 task）。 */
export function createNavigator(driver: Driver, timeoutMs = 8000): Navigator {
  return {
    nodes: async () => parseUiNodes(await driver.dump()),
    dump: () => driver.dump(),
    screencap: () => driver.screencap(),
    tap: (sel, _what) => driver.tap(sel),
    tapPoint: async (x, y, _what) => {
      if (driver.tapPoint) return driver.tapPoint(x, y)
      // 退化：无 tapPoint 能力的驱动（如 Mock）在真实导航里不会被用到；这里仅兜底。
      throw new Error('driver 不支持 tapPoint')
    },
    input: (sel, text, _what) => driver.input(sel, text),
    swipeUp: () => driver.swipe('up'),
    waitAny: async (anchors, _what, perCallTimeoutMs) => {
      const assertions = anchors.map((a) => ({
        presentResourceIds: a.resourceId ? [a.resourceId] : undefined,
        presentTexts: a.text ? [textAnchorRegex(a.text)] : undefined,
      }))
      const xml = await waitForAnyState(driver, assertions, {
        timeoutMs: perCallTimeoutMs ?? timeoutMs,
      })
      return { nodes: parseUiNodes(xml), dump: xml }
    },
    firstResultCard: async () => {
      const nodes = parseUiNodes(await driver.dump())
      return firstResultCardCenter(nodes)
    },
    firstActionable: async (keywords) => {
      const nodes = parseUiNodes(await driver.dump())
      return firstActionableCenter(nodes, keywords)
    },
    repaint: async () => {
      await driver.dump()
    },
    hasAny: async (keywords) => {
      const nodes = parseUiNodes(await driver.dump())
      return nodes.some((n) =>
        keywords.some((k) => (n.text ?? '').includes(k) || (n.label ?? '').includes(k)),
      )
    },
  }
}

/** 文案锚点 → 正则（包含匹配；转义特殊字符）。 */
export function textAnchorRegex(text: string): RegExp {
  return new RegExp(text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
}
