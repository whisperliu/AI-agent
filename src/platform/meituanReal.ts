/**
 * platform/meituanReal.ts — 美团**真机**结算页适配（P3）。
 * 层：strategy。两件事，严格分开：
 *   1) `extractMeituanSettle` —— **纯函数**：真机 dump(节点) → RawQuoteFacts（可离线回放、单测）。
 *   2) `runMeituanReal`       —— 真机流程：搜索→选店→加购→进结算，每步走 device/steps 的
 *      `waitForAnyState`（含验证码/登录拦截 + 弹窗恢复 + 超时取证）。
 *
 * 红线：全程只读到最后一步「读实付」，**绝不点击提交订单/支付**（AGENTS.md §0）；
 *      `tap()` 内层还有 `assertTapSafe` 兜底。命中验证码 → NeedsHumanError，不绕过。
 *
 * 复用：`device/steps.ts` 是 §30 明确允许平台使用的"动作+断言+恢复"能力原语（非设备实现）。
 */
import type { Bounds, UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import { waitForAnyState } from '../device/steps.ts'
import type { Driver, UiSelector } from '../device/driver.ts'
import type { ComparisonConditions, DiscountKind, FeeKind } from '../price/model.ts'
import { MEITUAN_SELECTORS } from './selectors/meituan.ts'
import type { RawQuoteFacts } from './types.ts'

// ────────────────────────────── 纯提取（可离线测） ──────────────────────────────

const MONEY_YEN_RE = /[¥￥]\s*(-?\d+(?:\.\d{1,2})?)/
const MONEY_ANY_RE = /-?\d+(?:\.\d{1,2})?/

/**
 * 从一段文案里取金额（元）；取不到返回 NaN。
 * 优先取 **¥/￥ 前缀** 的数（避免 "满30减5 -¥5.00" 误取 30），无 ¥ 时退回第一个数字。
 */
export function parseMoneyText(s: string | undefined): number {
  if (!s) return Number.NaN
  const yen = MONEY_YEN_RE.exec(s)
  const m = yen ? yen : MONEY_ANY_RE.exec(s)
  if (!m) return Number.NaN
  const n = Number.parseFloat(m[1] ?? m[0] ?? '')
  return Number.isFinite(n) ? n : Number.NaN
}

/** 按短名（resource-id 后缀）找第一个有 text 的节点。 */
function nodeByIdOrText(nodes: UiNode[], names: string[]): UiNode | undefined {
  for (const name of names) {
    const hit = nodes.find(
      (n) => n.resourceId && (n.resourceId === name || n.resourceId.endsWith('/' + name)),
    )
    if (hit) return hit
  }
  return undefined
}

/** 在若干候选里，找文案包含某个关键词且有金额的节点（用于费用/优惠行）。 */
function textOfKeyword(
  nodes: UiNode[],
  keywords: string[],
): { text: string; amount: number } | undefined {
  for (const n of nodes) {
    const t = n.text ?? ''
    if (!t) continue
    if (keywords.some((k) => t.includes(k))) {
      const amount = parseMoneyText(t)
      if (Number.isFinite(amount)) return { text: t, amount }
    }
  }
  return undefined
}

const FEE_LABEL_MAP: { key: string; kind: FeeKind; label: string }[] = [
  { key: '配送费', kind: 'delivery', label: '配送费' },
  { key: '打包费', kind: 'packing', label: '打包费' },
  { key: '餐盒费', kind: 'packing', label: '餐盒费' },
  { key: '服务费', kind: 'service', label: '服务费' },
  { key: '配送', kind: 'delivery', label: '配送' },
  { key: '小计', kind: 'goods', label: '小计' },
  { key: '商品金额', kind: 'goods', label: '商品金额' },
]

const DISCOUNT_KIND_MAP: { key: string; kind: DiscountKind }[] = [
  { key: '满减', kind: 'promo' },
  { key: '立减', kind: 'promo' },
  { key: '折扣', kind: 'promo' },
  { key: '红包', kind: 'coupon' },
  { key: '券', kind: 'coupon' },
  { key: '优惠', kind: 'promo' },
]

/**
 * 真机结算页 → RawQuoteFacts（纯函数）。
 * 只读取控件树里的**事实**；算术是否自洽交给 price/engine 判定（不在此硬凑）。
 */
export function extractMeituanSettle(
  nodes: UiNode[],
  cond: ComparisonConditions,
  dump: string,
): RawQuoteFacts {
  // 实付：优先按 resource-id 候选，回退按"实付/合计"文案。
  let payable = Number.NaN
  const payableNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.payable)
  if (payableNode) payable = parseMoneyText(payableNode.text)
  if (!Number.isFinite(payable)) {
    const byText = textOfKeyword(nodes, ['实付', '实际支付', '合计', '应付'])
    if (byText) payable = byText.amount
  }

  // 门店 / 商品 / 规格 / 数量。
  const storeNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.storeName)
  const itemNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemName)
  const specNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemSpec)
  const qtyNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemQty)

  let qty = Number.NaN
  if (qtyNode?.text) qty = Number.parseInt(qtyNode.text.replace(/[^\d]/g, ''), 10)
  if (!Number.isFinite(qty) || qty <= 0) {
    // 回退：从商品行 "… x2" 里抠数量。
    const m = /[x×]\s*(\d+)/.exec(itemNode?.text ?? '')
    qty = m ? Number.parseInt(m[1] ?? '1', 10) : cond.qty
  }

  // 费用明细：优先按 resource-id（fee_<kind>），再按文案标签兜底（真机 id 常为通用名）。
  const fees: RawQuoteFacts['fees'] = []
  const feeKindsSeen = new Set<string>()
  for (const n of nodes) {
    const id = n.resourceId ?? ''
    const m = /fee[_-]([a-z_]+)$/i.exec(id)
    if (m && n.text) {
      const raw = (m[1] ?? '').toLowerCase()
      const kind = (
        ['goods', 'delivery', 'packing', 'service', 'small_order', 'tip'].includes(raw)
          ? raw
          : 'other'
      ) as FeeKind
      const amount = parseMoneyText(n.text)
      if (Number.isFinite(amount)) {
        fees.push({ kind, label: raw, amount: Math.abs(amount), source: 'tree' })
        feeKindsSeen.add(kind)
      }
    }
  }
  for (const f of FEE_LABEL_MAP) {
    if (feeKindsSeen.has(f.kind)) continue
    const hit = textOfKeyword(nodes, [f.key])
    if (hit && Number.isFinite(hit.amount)) {
      fees.push({ kind: f.kind, label: f.label, amount: Math.abs(hit.amount), source: 'tree' })
      feeKindsSeen.add(f.kind)
    }
  }

  // 优惠明细（已含在实付里 → alreadyIncludedInPayable=true，防重复扣）。
  const discounts: RawQuoteFacts['discounts'] = []
  const discountKindsSeen = new Set<string>()
  for (const n of nodes) {
    const id = n.resourceId ?? ''
    const m = /discount[_-]([a-z_]+)$/i.exec(id)
    if (m && n.text) {
      const raw = (m[1] ?? '').toLowerCase()
      const kind = (
        ['coupon', 'membership', 'credit_card', 'promo', 'delivery_waiver'].includes(raw)
          ? raw
          : 'promo'
      ) as DiscountKind
      const amount = Math.abs(parseMoneyText(n.text))
      if (Number.isFinite(amount) && amount > 0) {
        discounts.push({
          kind,
          platform: 'meituan',
          id: `meituan-${kind}`,
          name: n.text,
          amount,
          scope: 'order',
          source: 'tree',
          autoApplied: true,
          alreadyIncludedInPayable: true,
        })
        discountKindsSeen.add(kind)
      }
    }
  }
  for (const d of DISCOUNT_KIND_MAP) {
    if (discountKindsSeen.has(d.kind)) continue
    const hit = textOfKeyword(nodes, [d.key])
    if (hit && Number.isFinite(hit.amount)) {
      const amount = Math.abs(hit.amount)
      if (amount === 0) continue
      discounts.push({
        kind: d.kind,
        platform: 'meituan',
        id: `meituan-${d.kind}`,
        name: hit.text,
        amount,
        scope: 'order',
        source: 'tree',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      })
      discountKindsSeen.add(d.kind)
    }
  }

  const byField: Record<string, 'tree' | 'ocr'> = {}
  if (Number.isFinite(payable)) byField.payable = 'tree'
  if (storeNode) byField.storeName = 'tree'
  if (itemNode) byField.itemName = 'tree'

  return {
    storeName: storeNode?.text ?? cond.item,
    storeAmapId: undefined,
    itemName: itemNode?.text ?? cond.item,
    itemSpec: specNode?.text,
    qty: Number.isFinite(qty) && qty > 0 ? qty : cond.qty,
    composition: undefined,
    fees,
    discounts,
    payable,
    // 实付能用控件树读到 → high；读不到 → low（上层会据此判 needsConfirm 并走 OCR 兜底）。
    confidence: Number.isFinite(payable) ? 'high' : 'low',
    byField,
    dump,
  }
}

/** 结算页 anchor 断言（任一命中即认"在结算页"）。 */
export function settleAnchors(): UiSelector[] {
  return MEITUAN_SELECTORS.settleAnchors.map((id) => ({ resourceId: id }))
}

// ────────────────────────────── 真机流程（走 steps 原语） ──────────────────────────────

export interface Navigator {
  /** 当前界面节点。 */
  nodes(): Promise<UiNode[]>
  /** 当前界面原始 dump（写证据）。 */
  dump(): Promise<string>
  /** 按选择器点击（安全护栏在 driver.tap 内部）。 */
  tap(sel: UiSelector, what: string): Promise<void>
  /** 按选择器输入文本。 */
  input(sel: UiSelector, text: string, what: string): Promise<void>
  /** 等待锚点（任一命中），返回最新节点与 dump；命中验证码/登录抛 NeedsHumanError。 */
  waitAny(anchors: UiSelector[], what: string): Promise<{ nodes: UiNode[]; dump: string }>
  /** 向上滚动一屏。 */
  swipeUp(): Promise<void>
}

/**
 * 真机走查：首页 → 搜索 item → 选第一家店 → 加购 → 进结算 → 读实付。
 * 任一步 anchor 超时 → StateAssertionError（含证据）；命中验证码/登录 → NeedsHumanError。
 */
export async function runMeituanReal(
  nav: Navigator,
  cond: ComparisonConditions,
): Promise<RawQuoteFacts> {
  const byId = (ids: string[]): UiSelector[] => ids.map((id) => ({ resourceId: id }))

  // 1) 等首页就绪。
  await nav.waitAny(byId(MEITUAN_SELECTORS.homeAnchors), '首页')

  // 2) 搜索：点搜索框 → 输入 → 提交。
  await nav.tap({ resourceId: MEITUAN_SELECTORS.searchInput[0]! }, '搜索框')
  await nav.input({ resourceId: MEITUAN_SELECTORS.searchInput[0]! }, cond.item, '搜索输入')
  await nav.tap({ resourceId: MEITUAN_SELECTORS.searchSubmit[0]! }, '搜索按钮')

  // 3) 等店铺结果 → 选第一家。
  await nav.waitAny(byId(MEITUAN_SELECTORS.storeRow), '店铺列表')
  await nav.tap({ resourceId: MEITUAN_SELECTORS.storeRow[0]! }, '第一家店铺')

  // 4) 等店铺页 → 加购。
  await nav.waitAny(byId(MEITUAN_SELECTORS.addToCart), '店铺页')
  await nav.tap({ resourceId: MEITUAN_SELECTORS.addToCart[0]! }, '加入购物车')

  // 5) 打开购物车 / 去结算。
  await nav.tap({ resourceId: MEITUAN_SELECTORS.viewCart[0]! }, '购物车/去结算')

  // 6) 等结算页 → 读事实。
  const { nodes, dump } = await nav.waitAny(settleAnchors(), '结算页')
  return extractMeituanSettle(nodes, cond, dump)
}

/** 由 Driver 构造 Navigator（在 platform 内成型，避免把"具体实现"下沉到 task）。 */
export function createNavigator(driver: Driver, timeoutMs = 8000): Navigator {
  return {
    nodes: async () => parseUiNodes(await driver.dump()),
    dump: () => driver.dump(),
    tap: (sel, _what) => driver.tap(sel),
    input: (sel, text, _what) => driver.input(sel, text),
    swipeUp: () => driver.swipe('up'),
    waitAny: async (anchors, _what) => {
      const xml = await waitForAnyState(
        driver,
        anchors.map((a) => ({ presentResourceIds: a.resourceId ? [a.resourceId] : undefined })),
        { timeoutMs },
      )
      return { nodes: parseUiNodes(xml), dump: xml }
    },
  }
}

// bounds 仅用于调试打印，避免未使用告警。
export function describeBounds(b: Bounds | undefined): string {
  return b ? `[${b.join(',')}]` : 'n/a'
}

/** 供测试/排障：判定某节点是否是"提交订单/支付"类危险控件（只读，不点击）。 */
export function isDangerNode(n: UiNode): boolean {
  const t = `${n.text ?? ''}${n.label ?? ''}${n.resourceId ?? ''}`
  return /提交订单|去支付|立即支付|确认支付|付款|submit_order|pay_now|confirm_order/.test(t)
}

/** 便利：从 dump 文本直接抽取（供离线回放测试）。 */
export function extractMeituanSettleFromDump(
  dump: string,
  cond: ComparisonConditions,
): RawQuoteFacts {
  return extractMeituanSettle(parseUiNodes(dump), cond, dump)
}
