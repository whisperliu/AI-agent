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
import type { UiNode } from '../device/uixml.ts'
import { parseUiNodes } from '../device/uixml.ts'
import type { UiSelector } from '../device/driver.ts'
import type { ComparisonConditions, DiscountKind, FeeKind, OptionalSaving } from '../price/model.ts'
import { itemScore } from '../price/similarity.ts'
import { MEITUAN_SELECTORS } from './selectors/meituan.ts'
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

// 行/坐标原语已抽到 platform/settleRows.ts（平台共享）；此处 re-export 保持对外 API 不变。
export {
  buildRows,
  describeBounds,
  firstActionableCenter,
  firstResultCardCenter,
  parseMoneyText,
  rowText,
} from './settleRows.ts'
export type { Row } from './settleRows.ts'
export { createNavigator } from './navigator.ts'
export type { Navigator } from './navigator.ts'

// ────────────────────────────── 纯提取（可离线测） ──────────────────────────────

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
  { key: '商品原价', kind: 'goods', label: '商品原价' },
  { key: '用户配送费', kind: 'delivery', label: '用户配送费' },
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
 *
 * 两层策略（真机实测结论，2026-10 美团结算页）：
 *  1) **resource-id 路径**（mock / 老版本 / 有稳定 id 的页面）：`payable` / `fee_<kind>` / `discount_<kind>`。
 *  2) **坐标/行路径**（真机默认：美团结算页**几乎全无 resource-id**，值靠右、标签靠左、同 y 同一行）：
 *     按 y 聚行 → 行内按 x 排序 → 标签前缀定位行 → 取该行最右/最右含 ¥ 的金额节点 → 解析。
 *     这是本次 P3 真机校准的核心：用"空间布局"替代缺失的 resource-id。
 */
export function extractMeituanSettle(
  nodes: UiNode[],
  cond: ComparisonConditions,
  dump: string,
): RawQuoteFacts {
  // 实付：优先按 resource-id 候选，回退"坐标/行"路径。
  let payable = Number.NaN
  const payableNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.payable)
  if (payableNode) payable = parseMoneyText(payableNode.text)
  if (!Number.isFinite(payable)) payable = payableFromRows(nodes)
  if (!Number.isFinite(payable)) {
    const byText = textOfKeyword(nodes, ['实付', '实际支付', '合计', '应付'])
    if (byText) payable = byText.amount
  }

  // 门店 / 商品 / 规格 / 数量（id 优先，坐标兜底）。
  const storeNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.storeName)
  const itemNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemName)
  const specNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemSpec)
  const qtyNode = nodeByIdOrText(nodes, MEITUAN_SELECTORS.itemQty)

  const located = locateStoreItemSpec(nodes, cond.item)
  const storeName = storeNode?.text ?? located.storeName
  const itemName = itemNode?.text ?? located.itemName

  let qty = Number.NaN
  if (qtyNode?.text) qty = Number.parseInt(qtyNode.text.replace(/[^\d]/g, ''), 10)
  if (!Number.isFinite(qty) || qty <= 0) {
    // 回退：商品行 "… x2" 里抠数量。
    const m =
      /[x×]\s*(\d+)/.exec(itemNode?.text ?? '') ?? /[x×]\s*(\d+)/.exec(located.itemText ?? '')
    qty = m ? Number.parseInt(m[1] ?? '1', 10) : located.qty
  }
  if (!Number.isFinite(qty) || qty <= 0) qty = cond.qty

  // 费用明细：id 优先（fee_<kind>），再"坐标/行"兜底（真机 id 几乎没有）。
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
  // 行路径补齐：对仍未取到的费用类型，用"标签行 + 该行金额"再试一次。
  for (const f of FEE_LABEL_MAP) {
    if (feeKindsSeen.has(f.kind)) continue
    const rowAmount = amountFromRow(nodes, [f.key])
    if (Number.isFinite(rowAmount)) {
      fees.push({ kind: f.kind, label: f.label, amount: Math.abs(rowAmount), source: 'tree' })
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
      // 只认**明确已减**的文案（带 -¥ / 已减 / 共减）；"待使用/去使用"红包、纯"15元红包"不算入账，
      // 否则会把未抵扣的可用红包当已减，导致实付被算低（真机 2026-10 教训）。
      if (!/[-−—]\s*[¥￥]|已减|共减/.test(hit.text)) continue
      if (/待使用|去使用|可使用|未使用|已过期/.test(hit.text)) continue
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
  // 行路径补齐优惠：配送费减免 + 商家代金券/满减（真机无 id）。
  for (const dd of discountsFromRows(nodes)) {
    if (discountKindsSeen.has(dd.kind)) continue
    discounts.push({
      kind: dd.kind,
      platform: 'meituan',
      id: `meituan-${dd.kind}`,
      name: dd.name,
      amount: dd.amount,
      scope: dd.kind === 'delivery_waiver' ? 'delivery' : 'order',
      source: 'tree',
      autoApplied: true,
      alreadyIncludedInPayable: true,
    })
    discountKindsSeen.add(dd.kind)
  }

  // 未纳入实付的"可得优惠"（待使用红包等）→ optionalSaving（presumed，不夸大抵扣）。
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
    discounts,
    optionalSavings,
    payable,
    // 实付能用控件树读到 → high；读不到 → low（上层会据此判 needsConfirm 并走 OCR 兜底）。
    confidence: Number.isFinite(payable) ? 'high' : 'low',
    byField,
    dump,
  }
}

// ─────────────────────── 坐标/行助手（真机无 resource-id 时用） ───────────────────────

/**
 * 实付金额：优先找「券前/实付/合计/应付/待支付/实付款」标签，取同一行右侧最近金额。
 * 美团结算页底部有两种变体：
 *   A) 「券前 ¥X 共减¥Y [极速支付]」——直接取"券前"右侧金额；
 *   B) 神抢手/一口价店：「¥X 共减¥Y [极速支付]」——**没有"券前"标签**，此时取"共减"左侧最近的金额（即券前实付）。
 * 均排除"极速支付"按钮旁可能含未使用红包的金额。
 */
function payableFromRows(nodes: UiNode[]): number {
  const byLabel = amountNearLabel(nodes, [
    '券前',
    '实付',
    '实际支付',
    '合计',
    '应付',
    '待支付',
    '实付款',
  ])
  if (Number.isFinite(byLabel)) return byLabel

  // 变体 B：无"券前"标签时，取"共减¥Y"左侧最近金额（即券前实付）。
  return amountLeftOfAnchor(nodes, '共减')
}

/** 从行里抽取已应用的优惠（配送费减免 / 商家代金券、满减 / 立减）。 */
function discountsFromRows(
  nodes: UiNode[],
): { kind: DiscountKind; name: string; amount: number }[] {
  const out: { kind: DiscountKind; name: string; amount: number }[] = []
  const rows = buildRows(nodes)
  for (const r of rows) {
    const t = rowText(r)
    // 配送费减免："活动减3.9元配送费"（金额紧跟"减"，取 ¥ 前缀或 减X元）。
    const dw = /活动减\s*¥?\s*([\d.]+)\s*元?\s*配送费/.exec(t)
    if (dw) {
      const amount = Number.parseFloat(dw[1] ?? '')
      if (Number.isFinite(amount) && amount > 0) {
        out.push({ kind: 'delivery_waiver', name: t, amount })
        continue
      }
    }
    // 商家代金券、满减：需带减号（-）才是"已减"，否则是"可用"入口不算入账。
    if (/商家代金券|满减|立减/.test(t) && /[-−—]\s*¥/.test(t.replace(/\s+/g, ''))) {
      const amount = Math.abs(parseMoneyText(t))
      if (Number.isFinite(amount) && amount > 0) out.push({ kind: 'promo', name: t, amount })
    }
  }
  return out
}

/** 未纳入实付的可得优惠（"美团红包…待使用/去使用"）→ presumed optionalSaving。 */
function optionalSavingsFromRows(nodes: UiNode[]): OptionalSaving[] {
  const out: OptionalSaving[] = []
  const rows = buildRows(nodes)
  for (const r of rows) {
    const t = rowText(r)
    if (/红包|代金券|优惠券/.test(t) && /待使用|去使用|可使用|未使用/.test(t)) {
      const amount = Math.abs(parseMoneyText(t))
      if (Number.isFinite(amount) && amount > 0) {
        out.push({
          kind: /红包/.test(t) ? 'coupon' : 'promo',
          platform: 'meituan',
          id: `meituan-unused-${out.length}`,
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

/**
 * 定位门店 / 商品 / 规格 / 数量（无 resource-id 时按与商品名的相似度 + 相对坐标）：
 *  - 商品名：与查询 item 相似度最高、非纯价格、长度≥2 的文本；
 *  - 门店名：商品行**上方**、左对齐、距离 20–220px、长度 2–25 的最近文本；
 *  - 规格：与商品同一区块、含"人份/辣/份/规格"的文本；
 *  - 数量：同区块 "x1"/"×1" 文本。
 */
function locateStoreItemSpec(
  nodes: UiNode[],
  queryItem: string,
): {
  storeName?: string
  itemName?: string
  itemText?: string
  itemSpec?: string
  qty: number
} {
  let best: { n: UiNode; s: number } | undefined
  for (const n of nodes) {
    const t = (n.text ?? '').trim()
    if (!t || t.length < 2 || PRICE_ONLY_RE.test(t)) continue
    if (!n.bounds) continue
    const s = itemScore(t, queryItem)
    if (!best || s > best.s) best = { n, s }
  }
  if (!best) return { qty: Number.NaN }

  const itemB = best.n.bounds!
  const itemYc = (itemB[1] + itemB[3]) / 2

  // 门店：商品行上方最近、左对齐、非价格的文本。
  const above = nodes.filter((n) => {
    const t = (n.text ?? '').trim()
    if (!t || t.length < 2 || t.length > 25 || PRICE_ONLY_RE.test(t) || !n.bounds) return false
    const b = n.bounds
    const yc = (b[1] + b[3]) / 2
    const gap = itemYc - yc
    return gap > 15 && gap < 220 && b[0] <= itemB[0] + 40
  })
  above.sort((a, b) => {
    const ya = (a.bounds![1] + a.bounds![3]) / 2
    const yb = (b.bounds![1] + b.bounds![3]) / 2
    return Math.abs(itemYc - ya) - Math.abs(itemYc - yb)
  })

  // 规格 / 数量：与商品同区块（|Δy| < 130）的邻近文本。
  let itemSpec: string | undefined
  let qty = Number.NaN
  for (const n of nodes) {
    const t = (n.text ?? '').trim()
    if (!t || !n.bounds) continue
    const yc = (n.bounds[1] + n.bounds[3]) / 2
    if (Math.abs(yc - itemYc) > 130) continue
    if (
      !itemSpec &&
      /人份|不辣|微辣|中辣|重辣|份|规格|口味|大份|小份/.test(t) &&
      t !== best.n.text
    ) {
      itemSpec = t
    }
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

/** 结算页 anchor 断言（任一命中即认"在结算页"）：resource-id 候选 + 真机文案锚点。 */
export function settleAnchors(): UiSelector[] {
  return [
    ...MEITUAN_SELECTORS.settleAnchors.map((id) => ({ resourceId: id })),
    ...MEITUAN_SELECTORS.settleTextAnchors.map((text) => ({ text })),
  ]
}

// ────────────────────────────── 真机流程（走 steps 原语） ──────────────────────────────

/**
 * 真机走查：首页 → 搜索 item → 选第一家店 → 加购 → 进结算 → 读实付。
 * 任一步 anchor 超时 → StateAssertionError（含证据）；命中验证码/登录 → NeedsHumanError。
 */
export async function runMeituanReal(
  nav: Navigator,
  cond: ComparisonConditions,
): Promise<RawQuoteFacts> {
  const byId = (ids: string[]): UiSelector[] => ids.map((id) => ({ resourceId: id }))
  const byTextAny = (texts: string[]): UiSelector[] => texts.map((text) => ({ text }))
  const settle = settleAnchors()

  // 0) 若当前**已在结算页**（用户已手动走到结算/复用上次会话）→ 直接读实付，不重复导航。
  //    这是真机最省事、最安全（点击最少）的路径，避免在已验证的结算页上误点。
  try {
    const { nodes, dump } = await nav.waitAny(settle, '结算页(已在)', 1500)
    return withShot(extractMeituanSettle(nodes, cond, dump), nav)
  } catch {
    // 不在结算页 → 走完整导航（下一段）。
  }

  // 1) 等首页就绪。
  await nav.waitAny(byId(MEITUAN_SELECTORS.homeAnchors), '首页')

  // 2) 搜索：点**首页搜索入口**（search_layout_area）→ 等搜索页 → 输入 → 提交。
  await nav.tap({ resourceId: MEITUAN_SELECTORS.searchEntry[0]! }, '搜索入口')
  await nav.waitAny(byId([MEITUAN_SELECTORS.searchInput[0]!]), '搜索页')
  await nav.input({ resourceId: MEITUAN_SELECTORS.searchInput[0]! }, cond.item, '搜索输入')
  await nav.tap({ resourceId: MEITUAN_SELECTORS.searchSubmit[0]! }, '搜索按钮')

  // 3) 等搜索结果（真机结果卡无稳定 id；以"出现店铺/评价/起送等结果特征"判定）。
  await nav.waitAny(byTextAny(MEITUAN_SELECTORS.searchResultTexts), '搜索结果', 12000)
  // 点第一张结果卡（真机无 id/文案钩子，用安全的坐标点按：内部会解析命中节点过红线）。
  const first = await nav.firstResultCard?.()
  if (first && nav.tapPoint) await nav.tapPoint(first.x, first.y, '第一家店铺')

  // 4) 店铺页首屏是**大图 banner**，会让 uiautomator 无法 idle（dump 返回空/陈旧）。
  //    先下滚 1–2 屏越过 banner（同时让菜单进入视口），再等店铺页锚点（点菜/选规格…）。
  for (let i = 0; i < 2; i++) {
    await nav.swipeUp()
    await nav.repaint?.()
  }
  await nav.waitAny(byTextAny(MEITUAN_SELECTORS.storePageTexts), '店铺页', 20000)

  // 5) 选第一个菜品：优先"选规格"（真机加购入口）；首屏 banner 常把菜单顶到屏外 → 先下滚再找。
  //    **用最新 dump 重新用文案点击**（滚动后坐标会失效，文案点击每次重新定位才稳）。
  let hasDish = await nav.hasAny?.(MEITUAN_SELECTORS.dishOpen)
  for (let i = 0; i < 3 && !hasDish; i++) {
    await nav.swipeUp()
    await nav.repaint?.()
    hasDish = await nav.hasAny?.(MEITUAN_SELECTORS.dishOpen)
  }
  if (hasDish) await nav.tap({ text: MEITUAN_SELECTORS.dishOpen[0]! }, '选规格')
  else await nav.tap({ text: MEITUAN_SELECTORS.addToCart[0]! }, '加入购物车')

  // 6) 规格弹层 → 加入购物车（等弹层出现；用文案点击，UI 不稳时最多重取数帧）。
  let hasAdd = await nav.hasAny?.(['加入购物车'])
  for (let i = 0; i < 6 && !hasAdd; i++) {
    await nav.repaint?.()
    hasAdd = await nav.hasAny?.(['加入购物车'])
  }
  if (hasAdd) await nav.tap({ text: '加入购物车' }, '加入购物车')

  // 7) 底部 → 去结算（不含"支付"字样，安全；用文案点击）。点后校验是否进入结算页，未进则重试。
  //    真机上"去结算"偶发点不中（浮层/抖动），故最多重试 3 次，每次点后短等结算锚点。
  for (let attempt = 0; attempt < 3; attempt++) {
    const hasCart = await nav.hasAny?.(['去结算'])
    if (!hasCart) {
      await nav.repaint?.()
      continue
    }
    await nav.tap({ text: '去结算' }, '去结算')
    try {
      const ok = await nav.waitAny(settle, '结算页', 6000)
      return withShot(extractMeituanSettle(ok.nodes, cond, ok.dump), nav)
    } catch {
      // 未进入结算页 → 重取一帧再试。
      await nav.repaint?.()
    }
  }

  // 8) 最后一次机会：直接等结算页（若已进入）。
  const { nodes, dump } = await nav.waitAny(settle, '结算页', 12000)
  return withShot(extractMeituanSettle(nodes, cond, dump), nav)
}

/**
 * 给抽取事实补一张结算页截图（证据用，P5）。截图**尽力而为**：失败不影响读价；
 * 落盘前的脱敏由 task/runner.bindEvidence 统一处理（无法脱敏则不会保存原图）。
 */
async function withShot(facts: RawQuoteFacts, nav: Navigator): Promise<RawQuoteFacts> {
  if (!nav.screencap) return facts
  try {
    facts.screenshot = await nav.screencap()
  } catch {
    // 截图失败：保留 facts（无截图证据），由上层降级。
  }
  return facts
}

/** 供测试/排障：判定某节点是否是"提交订单/支付"类危险控件（只读，不点击）。 */
export function isDangerNode(n: UiNode): boolean {
  const t = `${n.text ?? ''}${n.label ?? ''}${n.resourceId ?? ''}`
  return /提交订单|去支付|立即支付|确认支付|付款|极速支付|submit_order|pay_now|confirm_order/.test(
    t,
  )
}

/** 便利：从 dump 文本直接抽取（供离线回放测试）。 */
export function extractMeituanSettleFromDump(
  dump: string,
  cond: ComparisonConditions,
): RawQuoteFacts {
  return extractMeituanSettle(parseUiNodes(dump), cond, dump)
}
