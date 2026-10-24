/**
 * platform/navigator.ts — 真机导航原语（平台共享，无平台知识）。
 * 层：strategy。把 `Driver` 包装成"节点/等待/点击/滚动"的 Navigator，并用
 * `device/steps.waitForAnyState` 提供 OR 语义的锚点等待（验证码/登录即停 + 超时取证）。
 *
 * 本文件只做通用能力；各平台"首页→搜索→选店→加购→结算"的具体文案/顺序在各 *Real.ts。
 */
import type { UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import { NeedsHumanError } from '../core/errors.ts'
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
  /** 系统返回键（仅导航回退）。可选（Mock 无）。 */
  back?(): Promise<void>
  /** 当前前台包名（判断"是否还在本 App 内"，避免返回键把 App 退回桌面）。可选（Mock 无）。 */
  foreground?(): Promise<string | undefined>
  /** 把 App 拉到前台（仅等价点桌面图标）；`force` 先 force-stop 再启动以稳定回首页。可选（Mock 无）。 */
  launchApp?(appId: string, opts?: { force?: boolean }): Promise<void>
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
    back: driver.back ? () => driver.back!() : undefined,
    foreground: driver.foreground ? () => driver.foreground!() : undefined,
    launchApp: driver.launchApp
      ? (appId: string, o?: { force?: boolean }) => driver.launchApp!(appId, o)
      : undefined,
    hasAny: async (keywords) => {
      const nodes = parseUiNodes(await driver.dump())
      return nodes.some((n) =>
        keywords.some((k) => (n.text ?? '').includes(k) || (n.label ?? '').includes(k)),
      )
    },
  }
}

/**
 * 确保目标 App 在前台（P5 修复：此前真机流程**从不启动 App**，前台是别的 App/桌面时必然超时失败）。
 * 只做"点桌面图标"等价动作，不做登录/授权/支付；已在目标 App 内则不动（保留结算页等既有状态）。
 * 驱动不实现 launchApp（如 Mock）→ 直接跳过。
 */
export async function ensureAppForeground(driver: Driver, appId: string): Promise<void> {
  if (!driver.launchApp) return
  try {
    const fg = await driver.foreground?.()
    if (fg && fg === appId) return
  } catch {
    // 查不到前台就照常启动（保守：宁可多点一次图标，也不让流程卡死）。
  }
  await driver.launchApp(appId)
}

/**
 * 前置环境守卫（P5）：真机踩坑——手机处于**分屏/多窗口**时，`uiautomator dump` 只返回聚焦窗格、
 * 而 `input tap` 作用于整屏，无法可靠判定两窗格谁是我们操作的目标 → 坐标必错。
 * 这类**窗口布局**问题不属于验证码/支付红线，但**不能自动纠正**（改布局=模拟用户操作，易误点），
 * 因此抛 `NeedsHumanError('environment')`，附确切处置建议，交用户手动恢复全屏。
 *
 * 注意：**单纯 letterbox（横屏下跑竖屏 App，单窗口全屏）不阻止**——此时 dump 坐标是窗口内 1:1，
 * 只要加窗口偏移即可精准点按（`adb.ts` 的 `screenPoint` 已处理），实测可用。
 */
export async function assertUsableWindow(driver: Driver): Promise<void> {
  const d = driver as { geometry?: () => Promise<unknown> }
  if (typeof d.geometry !== 'function') return // Mock / 无几何能力 → 跳过
  let geo: { multiWindow?: boolean } | undefined
  try {
    geo = (await d.geometry()) as typeof geo
  } catch {
    return
  }
  if (geo?.multiWindow) {
    throw new NeedsHumanError(
      'environment',
      '检测到手机处于**分屏/多窗口**，无法可靠判定操作目标、坐标会错位。请退出分屏（回到全屏）后重试',
    )
  }
}

/**
 * 确保处于**首页**：App 被重新拉起时可能恢复到上次页面（搜索页/店铺页），
 * 此时直接点首页搜索入口会因"找不到控件"失败。这里先等首页，等不到就逐次返回键回退。
 *
 * ⚠️ 真机踩坑：**盲目连按返回键会把 App 退回桌面**（搜索页→首页→桌面），之后再等首页必然超时。
 * 因此每次回退前先查前台包名：一旦不在本 App 内，就**重新拉起 App** 而不是继续按返回。
 * 返回键只用于导航回退，绝不用于关闭支付/确认类对话（红线 §0）。
 */
export async function ensureHome(
  nav: Navigator,
  homeAnchors: UiSelector[],
  opts: { appId?: string; maxBack?: number } = {},
): Promise<{ nodes: unknown[]; dump: string }> {
  const maxBack = opts.maxBack ?? 3
  const appId = opts.appId

  try {
    return await nav.waitAny(homeAnchors, '首页', 1500)
  } catch {
    // 不在首页 → 逐步回退。
  }

  for (let i = 0; i < maxBack; i++) {
    // 先确认还在本 App 内；已退回桌面/别的 App → 重新拉起（而不是继续按返回）。
    let fg: string | undefined
    try {
      fg = await nav.foreground?.()
    } catch {
      fg = undefined
    }
    if (appId && fg && fg !== appId) {
      await nav.launchApp?.(appId)
      await sleepMs(1500)
    } else if (nav.back) {
      await nav.back()
      await sleepMs(900)
    } else {
      break
    }
    try {
      return await nav.waitAny(homeAnchors, '首页', 1800)
    } catch {
      // 继续
    }
  }

  // 最后一搏：**force-stop 后重启**（真机实测这是唯一能稳定离开"上次页面"回到首页的方式），
  // 再等一次首页；仍失败则抛 StateAssertionError 并留证。
  if (appId) {
    try {
      await nav.launchApp?.(appId, { force: true })
      await sleepMs(2500)
    } catch {
      /* ignore：交给下面的 waitAny 报错 */
    }
  }
  return nav.waitAny(homeAnchors, '首页', 8000)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 文案锚点 → 正则（包含匹配；转义特殊字符）。 */
export function textAnchorRegex(text: string): RegExp {
  return new RegExp(text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
}
