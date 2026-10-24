/**
 * platform/elemeReal.ts — 饿了么**真机**结算页适配（P4 多平台）。
 * 层：strategy。三件事，严格分层：
 *   1) `extractElemeSettle`       —— **纯函数**：真机 dump(节点) → RawQuoteFacts（可离线回放、单测）。
 *   2) `runElemeReal`             —— 真机流程：搜索→选店→加购→进结算，每步走 navigator 的 `waitAny`
 *      （验证码/登录拦截 + 超时取证）。
 *   3) `elemeAnchors`             —— 结算页锚点（id + 文案，任一命中）。
 *
 * 红线：全程只读到最后一步「读实付」，**绝不点击提交订单/支付**（AGENTS.md §0）；
 *      `driver.tap/tapPoint` 内层仍有 `assertTapSafe` 兜底；命中验证码 → NeedsHumanError，不绕过。
 *
 * 复用：行/坐标原语在 platform/settleRows.ts；导航原语在 platform/navigator.ts（均平台共享）。
 */
import type { UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import type { UiSelector } from '../device/driver.ts'
import type { ComparisonConditions, DiscountKind, FeeKind, OptionalSaving } from '../price/model.ts'
import { itemScore } from '../price/similarity.ts'
import { ELEME_SELECTORS } from './selectors/eleme.ts'
import type { Navigator } from './navigator.ts'
import {
  amountFromRow,
  amountLeftOfAnchor,
  amountNearLabel,
  buildRows,
  parseMoneyText,
  PRICE_ONLY_RE,
  rowText,
} from './settleRows.ts'
import type { RawQuoteFacts } from './types.ts'

const FEE_LABEL_MAP: { key: string; kind: FeeKind }[] = [
  { key: '商品金额', kind: 'goods' },
  { key: '商品小计', kind: 'goods' },
  { key: '商品原价', kind: 'goods' },
  { key: '配送费', kind: 'delivery' },
  { key: '打包费', kind: 'packing' },
  { key: '餐盒费', kind: 'packing' },
  { key: '服务费', kind: 'service' },
]

const DISCOUNT_KIND_MAP: { key: string; kind: DiscountKind }[] = [
  { key: '满减', kind: 'promo' },
  { key: '立减', kind: 'promo' },
  { key: '红包', kind: 'coupon' },
  { key: '优惠券', kind: 'coupon' },
  { key: '折扣', kind: 'promo' },
]

function nodeByIdOrText(nodes: UiNode[], names: string[]): UiNode | undefined {
  for (const name of names) {
    const hit = nodes.find(
      (n) => n.resourceId && (n.resourceId === name || n.resourceId.endsWith('/' + name)),
    )
    if (hit) return hit
  }
  return undefined
}

/** 实付：优先「实付/合计/应付/待支付」标签右侧金额，其次"共减"左侧金额（变体 B）。 */
function payableFromRows(nodes: UiNode[]): number {
  const byLabel = amountNearLabel(nodes, ['实付', '合计', '应付', '待支付', '实付款', '小计'])
  if (Number.isFinite(byLabel)) return byLabel
  return amountLeftOfAnchor(nodes, '共减')
}

/** 定位门店 / 商品 / 规格 / 数量（id 优先，坐标相似度兜底）。 */
function locateStoreItemSpec(
  nodes: UiNode[],
  queryItem: string,
): { storeName?: string; itemName?: string; itemText?: string; itemSpec?: string; qty: number } {
  let best: { n: UiNode; s: number } | undefined
  for (const n of nodes) {
    const t = (n.text ?? '').trim()
    if (!t || t.length < 2 || PRICE_ONLY_RE.test(t) || !n.bounds) continue
    const s = itemScore(t, queryItem)
    if (!best || s > best.s) best = { n, s }
  }
  if (!best) return { qty: Number.NaN }
  const itemB = best.n.bounds!
  const itemYc = (itemB[1] + itemB[3]) / 2

  const above = nodes.filter((n) => {
    const t = (n.text ?? '').trim()
    if (!t || t.length < 2 || t.length > 25 || PRICE_ONLY_RE.test(t) || !n.bounds) return false
    const b = n.bounds
    const yc = (b[1] + b[3]) / 2
    const gap = itemYc - yc
    return gap > 15 && gap < 340 && b[0] <= itemB[0] + 40
  })
  above.sort((a, b) => {
    const ya = (a.bounds![1] + a.bounds![3]) / 2
    const yb = (b.bounds![1] + b.bounds![3]) / 2
    return Math.abs(itemYc - ya) - Math.abs(itemYc - yb)
  })

  let itemSpec: string | undefined
  let qty = Number.NaN
  for (const n of nodes) {
    const t = (n.text ?? '').trim()
    if (!t || !n.bounds) continue
    const yc = (n.bounds[1] + n.bounds[3]) / 2
    if (Math.abs(yc - itemYc) > 130) continue
    if (!itemSpec && /人份|不辣|微辣|中辣|重辣|份|规格|口味|大份|小份/.test(t) && t !== best.n.text)
      itemSpec = t
    const qm = /^[x×]\s*(\d+)$/.exec(t)
    if (qm) qty = Number.parseInt(qm[1] ?? '1', 10)
  }
  return {
    storeName: above[0]?.text?.trim(),
    itemName: best.n.text?.trim(),
    itemText: best.n.text?.trim(),
    itemSpec,
    qty,
  }
}

/** 已减优惠（配送费减免 / 满减 / 商家券），只有带减号才算已抵扣。 */
function discountsFromRows(
  nodes: UiNode[],
): { kind: DiscountKind; name: string; amount: number }[] {
  const out: { kind: DiscountKind; name: string; amount: number }[] = []
  for (const r of buildRows(nodes)) {
    const t = rowText(r)
    const dw = /活动减\s*¥?\s*([\d.]+)\s*元?\s*配送费/.exec(t)
    if (dw) {
      const amount = Number.parseFloat(dw[1] ?? '')
      if (Number.isFinite(amount) && amount > 0) {
        out.push({ kind: 'delivery_waiver', name: t, amount })
        continue
      }
    }
    if (/满减|立减|红包|优惠券|代金券/.test(t) && /[-−—]\s*¥/.test(t.replace(/\s+/g, ''))) {
      const amount = Math.abs(parseMoneyText(t))
      if (Number.isFinite(amount) && amount > 0) out.push({ kind: 'promo', name: t, amount })
    }
  }
  return out
}

/** 未纳入实付的"待使用/可用红包"→ presumed optionalSaving（不计入实付）。 */
function optionalSavingsFromRows(nodes: UiNode[]): OptionalSaving[] {
  const out: OptionalSaving[] = []
  for (const r of buildRows(nodes)) {
    const t = rowText(r)
    if (/红包|代金券|优惠券/.test(t) && /待使用|去使用|可使用|未使用/.test(t)) {
      const amount = Math.abs(parseMoneyText(t))
      if (Number.isFinite(amount) && amount > 0) {
        out.push({
          kind: /红包/.test(t) ? 'coupon' : 'promo',
          platform: 'eleme',
          id: `eleme-unused-${out.length}`,
          name: t,
          amount,
          scope: 'order',
          source: 'tree',
          autoApplied: false,
          alreadyIncludedInPayable: false,
          availability: 'presumed',
          availabilityReason: '结算页展示为待使用/可使用，尚未自动抵扣',
          sourceOfTruth: 'settle_screenshot',
        })
      }
    }
  }
  return out
}

/** 结算页锚点（id + 文案，任一命中即认"在结算页"）。 */
export function elemeAnchors(): UiSelector[] {
  return [
    ...ELEME_SELECTORS.settleAnchors.map((id) => ({ resourceId: id })),
    ...ELEME_SELECTORS.settleTextAnchors.map((text) => ({ text })),
  ]
}

/** 真机结算页 → RawQuoteFacts（纯函数；算术是否自洽交 price/engine，不在此硬凑）。 */
export function extractElemeSettle(
  nodes: UiNode[],
  cond: ComparisonConditions,
  dump: string,
): RawQuoteFacts {
  let payable = Number.NaN
  const payableNode = nodeByIdOrText(nodes, ELEME_SELECTORS.payable)
  if (payableNode) payable = parseMoneyText(payableNode.text)
  if (!Number.isFinite(payable)) payable = payableFromRows(nodes)

  const storeNode = nodeByIdOrText(nodes, ELEME_SELECTORS.storeName)
  const itemNode = nodeByIdOrText(nodes, ELEME_SELECTORS.itemName)
  const specNode = nodeByIdOrText(nodes, ELEME_SELECTORS.itemSpec)
  const qtyNode = nodeByIdOrText(nodes, ELEME_SELECTORS.itemQty)

  const located = locateStoreItemSpec(nodes, cond.item)
  const storeName = storeNode?.text ?? located.storeName
  const itemName = itemNode?.text ?? located.itemName

  let qty = Number.NaN
  if (qtyNode?.text) qty = Number.parseInt(qtyNode.text.replace(/[^\d]/g, ''), 10)
  if (!Number.isFinite(qty) || qty <= 0) {
    const m =
      /[x×]\s*(\d+)/.exec(itemNode?.text ?? '') ?? /[x×]\s*(\d+)/.exec(located.itemText ?? '')
    qty = m ? Number.parseInt(m[1] ?? '1', 10) : located.qty
  }
  if (!Number.isFinite(qty) || qty <= 0) qty = cond.qty

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
    const hit = amountFromRow(nodes, [f.key])
    if (Number.isFinite(hit)) {
      fees.push({ kind: f.kind, label: f.key, amount: Math.abs(hit), source: 'tree' })
      feeKindsSeen.add(f.kind)
    }
  }

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
          platform: 'eleme',
          id: `eleme-${kind}`,
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
  for (const dd of discountsFromRows(nodes)) {
    if (discountKindsSeen.has(dd.kind)) continue
    discounts.push({
      kind: dd.kind,
      platform: 'eleme',
      id: `eleme-${dd.kind}`,
      name: dd.name,
      amount: dd.amount,
      scope: dd.kind === 'delivery_waiver' ? 'delivery' : 'order',
      source: 'tree',
      autoApplied: true,
      alreadyIncludedInPayable: true,
    })
    discountKindsSeen.add(dd.kind)
  }
  // 仅"明确已减"的文案若未被上一步覆盖，再用关键词兜底（带 -¥/已减/共减）。
  for (const d of DISCOUNT_KIND_MAP) {
    if (discountKindsSeen.has(d.kind)) continue
    const hit = nodes.find((n) => {
      const t = (n.text ?? '').trim()
      return (
        t.includes(d.key) && /[-−—]\s*[¥￥]|已减|共减/.test(t) && !/待使用|去使用|可使用/.test(t)
      )
    })
    if (hit?.text) {
      const amount = Math.abs(parseMoneyText(hit.text))
      if (Number.isFinite(amount) && amount > 0) {
        discounts.push({
          kind: d.kind,
          platform: 'eleme',
          id: `eleme-${d.kind}`,
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
  }

  // 去重：同一笔优惠可能被"关键词兜底 + 行兜底"各命中一次（按归一化文案去重，保留首条）。
  const uniqDiscounts: RawQuoteFacts['discounts'] = []
  const seenNames = new Set<string>()
  for (const d of discounts) {
    const key = d.name.replace(/\s+/g, '')
    if (seenNames.has(key)) continue
    seenNames.add(key)
    uniqDiscounts.push(d)
  }

  const optionalSavings = optionalSavingsFromRows(nodes)

  const byField: Record<string, 'tree' | 'ocr'> = {}
  if (Number.isFinite(payable)) byField.payable = 'tree'
  if (storeName) byField.storeName = 'tree'
  if (itemName) byField.itemName = 'tree'

  return {
    storeName: storeName ?? cond.item,
    storeAmapId: undefined,
    itemName: itemName ?? cond.item,
    itemSpec: specNode?.text ?? located.itemSpec,
    qty,
    composition: undefined,
    fees,
    discounts: uniqDiscounts,
    optionalSavings,
    payable,
    confidence: Number.isFinite(payable) ? 'high' : 'low',
    byField,
    dump,
  }
}

/** 便利：从 dump 文本直接抽取（供离线回放测试）。 */
export function extractElemeSettleFromDump(
  dump: string,
  cond: ComparisonConditions,
): RawQuoteFacts {
  return extractElemeSettle(parseUiNodes(dump), cond, dump)
}

/**
 * 真机走查：首页 → 搜索 item → 选第一家店 → 加购 → 进结算 → 读实付。
 * 与美团同构（复用 navigator 原语）；超时 → StateAssertionError；验证码/登录 → NeedsHumanError。
 */
export async function runElemeReal(
  nav: Navigator,
  cond: ComparisonConditions,
): Promise<RawQuoteFacts> {
  const byId = (ids: string[]): UiSelector[] => ids.map((id) => ({ resourceId: id }))
  const byTextAny = (texts: string[]): UiSelector[] => texts.map((text) => ({ text }))
  const settle = elemeAnchors()

  // 0) 已在结算页 → 直接读实付，零点击（最安全路径）。
  try {
    const { nodes, dump } = await nav.waitAny(settle, '结算页(已在)', 1500)
    return extractElemeSettle(nodes, cond, dump)
  } catch {
    // 不在结算页 → 走完整导航。
  }

  await nav.waitAny(byId(ELEME_SELECTORS.homeAnchors), '首页')
  await nav.tap({ resourceId: ELEME_SELECTORS.searchEntry[0]! }, '搜索入口')
  await nav.waitAny(byId([ELEME_SELECTORS.searchInput[0]!]), '搜索页')
  await nav.input({ resourceId: ELEME_SELECTORS.searchInput[0]! }, cond.item, '搜索输入')
  await nav.tap({ resourceId: ELEME_SELECTORS.searchSubmit[0]! }, '搜索按钮')

  await nav.waitAny(byTextAny(ELEME_SELECTORS.searchResultTexts), '搜索结果', 12000)
  const first = await nav.firstResultCard?.()
  if (first && nav.tapPoint) await nav.tapPoint(first.x, first.y, '第一家店铺')

  for (let i = 0; i < 2; i++) {
    await nav.swipeUp()
    await nav.repaint?.()
  }
  await nav.waitAny(byTextAny(ELEME_SELECTORS.storePageTexts), '店铺页', 20000)

  let hasDish = await nav.hasAny?.(ELEME_SELECTORS.dishOpen)
  for (let i = 0; i < 3 && !hasDish; i++) {
    await nav.swipeUp()
    await nav.repaint?.()
    hasDish = await nav.hasAny?.(ELEME_SELECTORS.dishOpen)
  }
  if (hasDish) await nav.tap({ text: ELEME_SELECTORS.dishOpen[0]! }, '选规格')
  else await nav.tap({ text: ELEME_SELECTORS.addToCart[0]! }, '加入购物车')

  let hasAdd = await nav.hasAny?.(['加入购物车'])
  for (let i = 0; i < 6 && !hasAdd; i++) {
    await nav.repaint?.()
    hasAdd = await nav.hasAny?.(['加入购物车'])
  }
  if (hasAdd) await nav.tap({ text: '加入购物车' }, '加入购物车')

  for (let attempt = 0; attempt < 3; attempt++) {
    const hasCart = await nav.hasAny?.(['去结算'])
    if (!hasCart) {
      await nav.repaint?.()
      continue
    }
    await nav.tap({ text: '去结算' }, '去结算')
    try {
      const ok = await nav.waitAny(settle, '结算页', 6000)
      return extractElemeSettle(ok.nodes, cond, ok.dump)
    } catch {
      await nav.repaint?.()
    }
  }

  const { nodes, dump } = await nav.waitAny(settle, '结算页', 12000)
  return extractElemeSettle(nodes, cond, dump)
}
