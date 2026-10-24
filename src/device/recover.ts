/**
 * device/recover.ts — 弹窗/授权/加载/登录/验证码的统一拦截层（§3.5.2）。
 * 层：capability（device）。**纯分类函数**可离线单测；`recoverOnce` 才驱动设备。
 *
 * 红线（AGENTS.md §0）：
 *  - 验证码 / 滑块 / 安全验证 / 风控 → **立即抛 NeedsHumanError，绝不尝试绕过**。
 *  - 登录态 → 抛 NeedsHumanError(login)，请用户本人登录，不代填凭证。
 * 其余已知干扰（升级/广告/定位/通知/加载）只做**可用性恢复**，不是安全风险。
 */
import { NeedsHumanError } from '../core/errors.ts'
import type { Driver, UiSelector } from './driver.ts'
import { findBySelector, parseUiNodes, visibleTexts, type UiNode } from './uixml.ts'

export type ObstructionKind =
  'none' | 'upgrade' | 'ad' | 'permission' | 'notification' | 'login' | 'loading' | 'captcha'

export interface Obstruction {
  kind: ObstructionKind
  /** 命中的文案（便于日志/取证）。 */
  matched?: string
}

/** 验证码/风控特征文案（命中即停）。 */
const CAPTCHA_HINTS = [
  '验证码',
  '安全验证',
  '滑块',
  '拖动滑块',
  '请完成验证',
  '人机验证',
  '风控',
  'captcha',
  'verify you are human',
]

const LOGIN_HINTS = ['登录', '手机号登录', '请先登录', '账号登录', 'sign in', 'log in']

/**
 * 真机实测（P3）：美团滑块验证是 **WebView canvas 渲染**，dump 里 **无 text / 无 content-desc**，
 * 仅靠文案匹配会判成 `none` → 等于漏掉红线 2（验证码即停）。
 * 因此补充"无字大 WebView 遮罩"的结构判据（保守，避免把普通无字加载壳误判为验证码）。
 */
const RESOURCE_ID_CAPTCHA_HINTS = ['captcha', 'verify', 'slider', 'nc_', 'geetest', 'aliyun']

/** 无字大 WebView 遮罩（验证码 canvas 特征）：几乎无文本 + 有占据可观面积的 WebView + 无列表。 */
function looksLikeTextlessCaptcha(nodes: UiNode[], texts: string[]): boolean {
  const hasWebview = nodes.some((n) => (n.className ?? '').toLowerCase().includes('webview'))
  if (!hasWebview) return false
  if (texts.length > 2) return false
  const hasListLike = nodes.some((n) => {
    const cls = (n.className ?? '').toLowerCase()
    return cls.includes('listview') || cls.includes('recyclerview')
  })
  if (hasListLike) return false
  return nodes.some((n) => {
    const cls = (n.className ?? '').toLowerCase()
    if (!cls.includes('webview') || !n.bounds) return false
    const [x1, y1, x2, y2] = n.bounds
    return (x2 - x1) * (y2 - y1) >= 200_000
  })
}

const UPGRADE_HINTS = ['立即更新', '以后再说', '版本升级', '新版本', '稍后再说']
const AD_HINTS = ['跳过', '跳过广告', '广告']
const PERMISSION_HINTS = ['是否允许', '允许', '定位', '位置信息']
const NOTIFICATION_HINTS = ['允许通知', '通知权限']
const LOADING_HINTS = ['加载中', '请稍候', 'loading']

function anyHit(texts: string[], hints: string[]): string | undefined {
  for (const t of texts) {
    const low = t.toLowerCase()
    for (const h of hints) if (low.includes(h.toLowerCase())) return t
  }
  return undefined
}

/**
 * 分类当前界面是否被干扰遮挡。优先级：验证码 > 登录 > 加载 > 升级 > 广告 > 权限。
 * 纯函数：只读 dump 文本，不碰设备。
 */
export function classifyObstruction(dump: string): Obstruction {
  const nodes = parseUiNodes(dump)
  const texts = visibleTexts(nodes)
  const hasWebview = nodes.some((n) => (n.className ?? '').toLowerCase().includes('webview'))
  const resIds = nodes.map((n) => n.resourceId ?? '').join(' ')

  // 验证码/风控：最高优先级（红线段）。
  const cap = anyHit(texts, CAPTCHA_HINTS) ?? matchIn(resIds, RESOURCE_ID_CAPTCHA_HINTS)
  if (cap) return { kind: 'captcha', matched: cap }

  // 无字 WebView 验证码（真机 canvas 滑块）：文案全空时靠结构判据兜底。
  if (looksLikeTextlessCaptcha(nodes, texts))
    return { kind: 'captcha', matched: 'textless-webview' }

  // 登录态：需人工。
  const login = anyHit(texts, LOGIN_HINTS)
  if (login && !anyHit(texts, ['退出登录', '我的'])) return { kind: 'login', matched: login }

  // 加载中：无文本节点或有明确的 loading 文案。
  if (anyHit(texts, LOADING_HINTS))
    return { kind: 'loading', matched: anyHit(texts, LOADING_HINTS) }

  const up = anyHit(texts, UPGRADE_HINTS)
  if (up) return { kind: 'upgrade', matched: up }

  if (hasWebview && anyHit(texts, AD_HINTS)) return { kind: 'ad', matched: anyHit(texts, AD_HINTS) }
  const ad = anyHit(texts, AD_HINTS)
  if (ad && texts.length <= 3) return { kind: 'ad', matched: ad }

  const noti = anyHit(texts, NOTIFICATION_HINTS)
  if (noti) return { kind: 'notification', matched: noti }
  const perm = anyHit(texts, PERMISSION_HINTS)
  if (perm) return { kind: 'permission', matched: perm }

  return { kind: 'none' }
}

function matchIn(hay: string, hints: string[]): string | undefined {
  const low = hay.toLowerCase()
  for (const h of hints) if (low.includes(h.toLowerCase())) return h
  return undefined
}

/** 若为验证码/风控/登录 → 立即抛 NeedsHumanError（供每步 dump 后调用）。 */
export function assertNoHumanRequired(dump: string): void {
  const o = classifyObstruction(dump)
  if (o.kind === 'captcha') throw new NeedsHumanError('captcha')
  if (o.kind === 'login') throw new NeedsHumanError('login')
}

/** 恢复动作选择：返回要点的选择器；无动作返回 undefined（含需人工的情形）。 */
export function recoverySelector(o: Obstruction): UiSelector | undefined {
  switch (o.kind) {
    case 'upgrade':
      return { text: '以后再说' }
    case 'ad':
      return { text: '跳过' }
    case 'permission':
    case 'notification':
      return { text: '允许' }
    default:
      return undefined
  }
}

export interface RecoverOptions {
  /** 最多尝试次数（避免死循环）。 */
  maxAttempts?: number
  /** 每次恢复后等待（毫秒）。 */
  waitMs?: number
  /** 轮询加载的最长时间（毫秒）。 */
  loadingTimeoutMs?: number
}

/**
 * 对一个已知干扰执行最多一次/几次恢复；验证码/登录直接抛错（不恢复）。
 * 返回处理后的最新 dump。
 */
export async function recoverOnce(
  driver: Driver,
  dump: string,
  opts: RecoverOptions = {},
): Promise<{ dump: string; recovered: boolean; kind: ObstructionKind }> {
  const maxAttempts = opts.maxAttempts ?? 2
  const waitMs = opts.waitMs ?? 800
  const loadingTimeoutMs = opts.loadingTimeoutMs ?? 5000

  let current = dump
  let recovered = false
  for (let i = 0; i < maxAttempts; i++) {
    const o = classifyObstruction(current)
    if (o.kind === 'none') return { dump: current, recovered, kind: 'none' }
    if (o.kind === 'captcha' || o.kind === 'login') {
      // 红线：不恢复，直接抛出让上层暂停并提示人工。
      assertNoHumanRequired(current)
    }
    if (o.kind === 'loading') {
      const started = Date.now()
      while (Date.now() - started < loadingTimeoutMs) {
        await sleep(waitMs)
        current = await driver.dump()
        if (classifyObstruction(current).kind !== 'loading') break
      }
      recovered = true
      continue
    }
    const sel = recoverySelector(o)
    if (!sel) return { dump: current, recovered, kind: o.kind }
    try {
      await driver.tap(sel)
      recovered = true
    } catch {
      // 恢复点击失败不应吞掉验证码判定；下一轮重新分类。
    }
    await sleep(waitMs)
    current = await driver.dump()
  }
  return { dump: current, recovered, kind: classifyObstruction(current).kind }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 便利：dump 中是否存在某文案（大小写/包含）。 */
export function dumpHasText(dump: string, needle: string): boolean {
  return visibleTexts(parseUiNodes(dump)).some((t) =>
    t.toLowerCase().includes(needle.toLowerCase()),
  )
}

/** 便利：按选择器是否可定位（供平台前置断言）。 */
export function dumpHas(dump: string, sel: UiSelector): boolean {
  return !!findBySelector(parseUiNodes(dump), sel)
}
