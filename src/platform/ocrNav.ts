/**
 * platform/ocrNav.ts — OCR 盲导航原语（P6，饿了么 canvas 自绘专用）。
 * 层：strategy（平台共享原语，不含具体流程/坐标）。
 *
 * 背景：饿了么整 App 是 canvas/TMS 自绘，`uiautomator dump` 只能拿到少数原生壳节点，
 * 没有"搜索框/商品卡/按钮"这些控件 → 常规 `tap(selector)` 无锚点可用。唯一可行路径：
 *   截图 → tesseract OCR（bbox 是**屏幕像素绝对坐标**）→ 用文案/坐标定位目标 → `tapPoint` 盲点。
 *
 * 红线（AGENTS.md §0）：canvas 页面控件树为空，`tapPoint` 内部基于控件的 `assertTapSafe`
 * **抓不到** canvas 上的"立即支付/提交订单"等文字 —— 因此本模块在每次点击前，**额外用 OCR 结果**
 * 做一次支付/下单关键词拦截（`assertOcrTapSafe`）。这是 canvas 场景下支付红线的**唯一有效防线**。
 */
import type { Ocr, OcrBox, OcrWord } from '../ocr/reader.ts'
import type { Driver } from '../device/driver.ts'
import type { UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import { NeedsHumanError, ForbiddenActionError } from '../core/errors.ts'
import { FORBIDDEN_TEXTS } from '../core/safety.ts'

export type Point = { x: number; y: number }

export interface OcrNav {
  /** 截屏 + OCR，返回逐词（bbox 为屏幕像素绝对坐标）。 */
  look(): Promise<OcrWord[]>
  /** 当前界面控件树节点（canvas 上通常很少，仅用于截图前的页面粗判/兜底）。 */
  nodes(): Promise<UiNode[]>
  /** 找文案命中正则的 OCR 词；按 readDir 取最靠前/后一个（默认从前）。 */
  find(
    words: OcrWord[],
    re: RegExp,
    opts?: { dir?: 'ltr' | 'rtl'; minConf?: number },
  ): OcrWord | undefined
  /** 词中心点（屏幕坐标）。 */
  center(w: OcrWord): Point
  /**
   * 安全点击一个**屏幕坐标**：先 OCR 该点命中的词过支付红线，再 `tapPoint`
   * （device 层还会再按控件兜底 assertTapSafe + 坐标映射）。
   */
  tapAt(words: OcrWord[], p: Point, what: string): Promise<void>
  /** 滚动（屏幕坐标）。 */
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>
  /** 向当前焦点输入文本（canvas 已用 tapAt 聚焦输入框后调用）。 */
  typeText(text: string): Promise<void>
  /** 发送系统按键（如 66=ENTER 提交搜索）。 */
  key(code: number): Promise<void>
  /** 等待条件成立（反复 look，满足即返回；超时抛 StateAssertionError 语义的 Error）。 */
  waitFor(
    predicate: (words: OcrWord[]) => boolean,
    what: string,
    timeoutMs?: number,
  ): Promise<OcrWord[]>
}

/** 只在 OCR 能读到的文本里判"验证码/风控/登录"（canvas 场景必需，控件树无文字）。 */
const HUMAN_RE = /验证码|滑块|拖动|拼图|安全验证|身份核实|人机验证|登录后|请登录|账号登录/

/** 坐标为"屏幕绝对坐标"：取该点命中的**面积最小**的词（避免命中大框 banner）。 */
export function wordAtPoint(words: OcrWord[], x: number, y: number): OcrWord | undefined {
  let best: OcrWord | undefined
  for (const w of words) {
    const { x: bx, y: by, w: bw, h: bh } = w.bbox
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
      if (!best || bw * bh < best.bbox.w * best.bbox.h) best = w
    }
  }
  return best
}

/** 该点附近的词（含相邻近的，用于把"立即支付 ¥16.98"整体纳入红线判断）。 */
export function wordsNearPoint(words: OcrWord[], x: number, y: number, pad = 90): OcrWord[] {
  return words.filter(
    (w) =>
      x >= w.bbox.x - pad &&
      x <= w.bbox.x + w.bbox.w + pad &&
      y >= w.bbox.y - pad &&
      y <= w.bbox.y + w.bbox.h + pad,
  )
}

/** canvas 场景的支付红线：点击坐标邻近词若命中下单/支付关键词 → 拒绝。 */
export function assertOcrTapSafe(words: OcrWord[], p: Point): void {
  const near = wordsNearPoint(words, p.x, p.y)
  const hay = near.map((w) => w.t).join(' ')
  const hit = FORBIDDEN_TEXTS.find((t) => hay.includes(t))
  if (hit) {
    throw new ForbiddenActionError(hit)
  }
}

function assertNoHuman(words: OcrWord[]): void {
  const text = words.map((w) => w.t).join(' ')
  const m = HUMAN_RE.exec(text)
  if (m) {
    const reason = /登录/.test(m[0]) ? 'login' : 'captcha'
    throw new NeedsHumanError(reason, `canvas 页面检测到「${m[0]}」，按红线立即停止，请人工处理`)
  }
}

export function createOcrNav(driver: Driver, ocr: Ocr, opts: { timeoutMs?: number } = {}): OcrNav {
  const timeoutMs = opts.timeoutMs ?? 8000

  async function look(): Promise<OcrWord[]> {
    const png = await driver.screencap()
    const res = await ocr.read(png)
    assertNoHuman(res.words)
    return res.words.filter((w) => (w.t ?? '').trim().length > 0)
  }

  async function nodes(): Promise<UiNode[]> {
    try {
      return parseUiNodes(await driver.dump())
    } catch {
      return []
    }
  }

  function find(
    words: OcrWord[],
    re: RegExp,
    o: { dir?: 'ltr' | 'rtl'; minConf?: number } = {},
  ): OcrWord | undefined {
    const minConf = o.minConf ?? 0.3
    const hits = words.filter((w) => re.test(w.t) && w.c >= minConf)
    if (hits.length === 0) return undefined
    const sorted = [...hits].sort((a, b) =>
      o.dir === 'rtl' ? b.bbox.x - a.bbox.x : a.bbox.x - b.bbox.x,
    )
    return sorted[0]
  }

  function center(w: OcrWord): Point {
    return {
      x: Math.round(w.bbox.x + w.bbox.w / 2),
      y: Math.round(w.bbox.y + w.bbox.h / 2),
    }
  }

  async function tapAt(words: OcrWord[], p: Point, _what: string): Promise<void> {
    assertOcrTapSafe(words, p)
    if (!driver.tapPoint) throw new Error('驱动不支持 tapPoint（OCR 盲导航需真机）')
    await driver.tapPoint(p.x, p.y)
  }

  async function swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    if (driver.swipeRaw) return driver.swipeRaw(x1, y1, x2, y2, ms)
    // 退化：无原始滑动能力时用上下滑。
    await driver.swipe(y2 < y1 ? 'up' : 'down')
  }

  async function typeText(text: string): Promise<void> {
    if (driver.inputText) return driver.inputText(text)
    throw new Error('驱动不支持 inputText（OCR 盲导航需真机）')
  }

  async function key(code: number): Promise<void> {
    if (!driver.key) throw new Error('驱动不支持 key（OCR 盲导航需真机）')
    await driver.key(code)
  }

  async function waitFor(
    predicate: (words: OcrWord[]) => boolean,
    what: string,
    perTimeout = timeoutMs,
  ): Promise<OcrWord[]> {
    const start = Date.now()
    let last: OcrWord[] = []
    while (Date.now() - start < perTimeout) {
      last = await look()
      if (predicate(last)) return last
      await new Promise((r) => setTimeout(r, 400))
    }
    // 省上下文（AGENTS.md §2）：超时报错时把**最后读到的文本**（带坐标、截断）一并抛出。
    // 这样排查"卡在哪一页"只看异常文本即可，**不必**再去 read_image 读整屏截图。
    throw new Error(`OCR 等待超时：${what}（最后读到 ${last.length} 词）` + describeWords(last))
  }

  return { look, nodes, find, center, tapAt, swipe, typeText, key, waitFor }
}

/**
 * 把 OCR 词压缩成一行**诊断文本**（带行首坐标，最多 ~20 行/60 词），用于异常消息。
 * 目的是让"页面没对上"的失败**自解释**，避免开发者/模型再去读整屏图耗上下文。
 */
export function describeWords(words: OcrWord[], maxLines = 20, maxWords = 60): string {
  const lines: { cy: number; x: number; txt: string[] }[] = []
  for (const w of [...words].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const cy = w.bbox.y + w.bbox.h / 2
    let ln = lines.find((l) => Math.abs(l.cy - cy) <= Math.max(12, w.bbox.h * 0.6))
    if (!ln) {
      ln = { cy, x: w.bbox.x, txt: [] }
      lines.push(ln)
    }
    ln.txt.push(w.t)
    ln.x = Math.min(ln.x, w.bbox.x)
  }
  let budget = maxWords
  const out: string[] = []
  for (const ln of lines.sort((a, b) => a.cy - b.cy).slice(0, maxLines)) {
    if (budget <= 0) break
    const take = ln.txt.slice(0, Math.max(1, budget))
    budget -= take.length
    out.push(`y=${Math.round(ln.cy)}|${take.join(' ')}`)
  }
  return out.length ? `；末帧文本：${out.join(' / ')}` : '；末帧无可读文本'
}

export type { OcrBox }
