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
import type { OcrWord } from '../ocr/reader.ts'
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
import type { PlatformEnterContext, RawQuoteFacts } from './types.ts'

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

// ────────────────────────── OCR 抽取（饿了么 canvas 自绘，控件树不可读） ──────────────────────────
//
// 真机实测（TB321FU / 饿了么 12.9.78，2026-10）：饿了么**整个 App 是 canvas/TMS 自绘**，
// uiautomator dump 全页只有 1 个 `water_mark_view` 节点（无任何文本/金额节点）。
// 因此饿了么结算页**只能截图 OCR**：对右侧结算面板 ROI 裁剪后 OCR，逐词取"标签→金额"。
// OCR 路径 `confidence` 永不 `high`（§6.3.4：OCR 命中即降级），低置信直接 needsConfirm。

/** OCR 金额归一：`Y3.9`/`y35.9`/`¥20.8`/`xy20.8`/`￥1` 等 → 数值。取第一个带小数的数字或整数。 */
export function ocrMoney(t: string | undefined): number {
  if (!t) return Number.NaN
  const m = /(\d+(?:\.\d{1,2})?)/.exec(t)
  if (!m) return Number.NaN
  const n = Number.parseFloat(m[1] ?? '')
  return Number.isFinite(n) ? n : Number.NaN
}

/** 在一组 OCR 词里找"标签词"右侧同一行最近的金额词（OCR 无精确 bounds，按 y 与 x 就近）。 */
function ocrAmountRightOf(words: OcrWord[], labelRe: RegExp): { amount: number; conf: number } {
  const labels = words.filter((w) => labelRe.test(w.t))
  for (const lab of labels) {
    const ly = lab.bbox.y + lab.bbox.h / 2
    const lx1 = lab.bbox.x + lab.bbox.w
    const cands = words
      .filter((w) => {
        if (w === lab) return false
        if (!/\d/.test(w.t)) return false
        const y = w.bbox.y + w.bbox.h / 2
        return Math.abs(y - ly) <= 26 && w.bbox.x >= lx1 - 10
      })
      .sort((a, b) => a.bbox.x - b.bbox.x)
    for (const c of cands) {
      const v = ocrMoney(c.t)
      if (Number.isFinite(v)) return { amount: v, conf: c.c }
    }
    // 有的标签与金额在同一 token（"打包费 Y1"）：尝试从标签词本身抠金额。
    const inline = ocrMoney(lab.t)
    if (
      Number.isFinite(inline) &&
      /\d/.test(lab.t.replace(/^(打包|配送|商品|服务|小计|实付|合计)/, ''))
    ) {
      return { amount: inline, conf: lab.c }
    }
  }
  return { amount: Number.NaN, conf: 0 }
}

interface OcrRow {
  text: string
  money: number
}
/** 按 y 中心把 OCR 词聚成视觉行，行内按 x 排序拼接；money 取行内最靠右的金额。 */
export function clusterOcrRows(words: OcrWord[], tolY = 16): OcrRow[] {
  const groups: { y: number; items: OcrWord[] }[] = []
  for (const w of words) {
    const yc = w.bbox.y + w.bbox.h / 2
    let g = groups.find((it) => Math.abs(it.y - yc) <= tolY)
    if (!g) {
      g = { y: yc, items: [] }
      groups.push(g)
    }
    g.items.push(w)
  }
  return groups.map((g) => {
    g.items.sort((a, b) => a.bbox.x - b.bbox.x)
    const text = g.items.map((w) => w.t).join('')
    let money = Number.NaN
    for (let i = g.items.length - 1; i >= 0; i--) {
      const v = ocrMoney(g.items[i]!.t)
      if (Number.isFinite(v) && /\d/.test(g.items[i]!.t)) {
        money = v
        break
      }
    }
    return { text, money }
  })
}

/**
 * 由 OCR 逐词结果构造 RawQuoteFacts（纯函数，可离线回放）。
 * 只读取"事实"；算术是否自洽交 price/engine。OCR 可信度取各关键字段最低置信。
 */
export function extractElemeSettleFromOcr(
  words: OcrWord[],
  cond: ComparisonConditions,
  ocrText = '',
): RawQuoteFacts {
  // 实付：优先「实付/合计/应付/立即支付」，其次"共减"左侧金额。
  let pay = ocrAmountRightOf(words, /^(实付|合计|应付|待支付|实付款)$/)
  if (!Number.isFinite(pay.amount)) pay = ocrAmountRightOf(words, /支付$/)
  if (!Number.isFinite(pay.amount)) {
    // 变体 B：找"共减"左侧最近金额。
    const gong = words.find((w) => w.t.includes('共减') || w.t === '减')
    if (gong) {
      const gy = gong.bbox.y + gong.bbox.h / 2
      const left = words
        .filter(
          (w) =>
            /\d/.test(w.t) &&
            Math.abs(w.bbox.y + w.bbox.h / 2 - gy) <= 26 &&
            w.bbox.x < gong.bbox.x,
        )
        .sort((a, b) => b.bbox.x - a.bbox.x)
      if (left[0]) pay = { amount: ocrMoney(left[0].t), conf: left[0].c }
    }
  }

  // 行级抽取：OCR 会把中文标签拆成多 token（"优惠"+"后"、"免"+"配送"），
  // 故按 y 聚成"视觉行"、拼成行文本，再在行内取最右金额。比整词匹配稳。
  const rows = clusterOcrRows(words)

  const fees: RawQuoteFacts['fees'] = []
  const feeMap: { kw: RegExp; kind: FeeKind; label: string }[] = [
    { kw: /打包|餐盒/, kind: 'packing', label: '打包费' },
    { kw: /配送费/, kind: 'delivery', label: '配送费' },
    { kw: /优惠后|商品金额|商品小计|商品原价/, kind: 'goods', label: '商品金额' },
    { kw: /服务费/, kind: 'service', label: '服务费' },
  ]
  const seenFee = new Set<string>()
  for (const f of feeMap) {
    const hit = rows.find((r) => f.kw.test(r.text) && Number.isFinite(r.money))
    if (hit && !seenFee.has(f.kind) && Number.isFinite(hit.money)) {
      fees.push({ kind: f.kind, label: f.label, amount: Math.abs(hit.money), source: 'ocr' })
      seenFee.add(f.kind)
    }
  }

  const discounts: RawQuoteFacts['discounts'] = []
  // 运费减免："免配送费/惊喜免配送费" 行（含配送费金额）→ delivery_waiver（金额=该行配送费；已含在实付）。
  const waiverRow = rows.find((r) => /免配送|惊喜免/.test(r.text) && Number.isFinite(r.money))
  const deliveryFee = fees.find((f) => f.kind === 'delivery')?.amount
  const waiverAmount = waiverRow && Number.isFinite(waiverRow.money) ? waiverRow.money : deliveryFee
  if (waiverAmount && waiverAmount > 0) {
    discounts.push({
      kind: 'delivery_waiver',
      platform: 'eleme',
      id: 'eleme-delivery-waiver',
      name: '免配送费（OCR）',
      amount: Math.abs(waiverAmount),
      scope: 'delivery',
      source: 'ocr',
      autoApplied: true,
      alreadyIncludedInPayable: true,
    })
  }
  // 说明：结算页底部"已优惠 ¥X"是**整单已减汇总**（已含在 payable 与"优惠后"商品价里），
  // **绝不**作为独立 discount 叠加——否则与"优惠后价"重复计算（§5.3）。仅在 needConfirm 说明里体现。

  // 关键字段最低 OCR 置信（0–1）→ confidence 永不 high。
  const confs = [pay.conf, ...fees.map(() => 100), ...discounts.map(() => 100)].filter((c) => c > 0)
  const minConf = confs.length ? Math.min(...confs) : 0
  // OCR 命中：payable 读到且 minConf≥0.6 → medium；否则 low（→ needsConfirm）。
  const confidence: 'high' | 'medium' | 'low' = Number.isFinite(pay.amount)
    ? minConf >= 0.6
      ? 'medium'
      : 'low'
    : 'low'

  const byField: Record<string, 'tree' | 'ocr'> = {}
  if (Number.isFinite(pay.amount)) byField.payable = 'ocr'
  for (const f of fees) byField[f.kind] = 'ocr'

  return {
    storeName: cond.item,
    storeAmapId: undefined,
    itemName: cond.item,
    itemSpec: undefined,
    qty: cond.qty,
    composition: undefined,
    fees,
    discounts,
    optionalSavings: [],
    payable: Number.isFinite(pay.amount) ? Math.abs(pay.amount) : Number.NaN,
    confidence,
    byField,
    dump: ocrText,
    screenshot: undefined,
  }
}

/**
 * 真机走查：首页 → 搜索 item → 选第一家店 → 加购 → 进结算 → 读实付。
 * 与美团同构（复用 navigator 原语）；超时 → StateAssertionError；验证码/登录 → NeedsHumanError。
 */
export async function runElemeReal(
  nav: Navigator,
  cond: ComparisonConditions,
  ctx?: PlatformEnterContext,
): Promise<RawQuoteFacts> {
  const byId = (ids: string[]): UiSelector[] => ids.map((id) => ({ resourceId: id }))
  const settle = elemeAnchors()
  const settleRightPanel = [...settle, { resourceId: 'tms_fragment_container' }]

  // 已在结算页 → 直接读（控件树优先，读不到则 OCR），零点击（最安全路径）。
  const already = await tryReadSettle(nav, cond, ctx, settleRightPanel, 1500)
  if (already) return already

  // 导航（饿了么为 canvas 自绘，按 resourceId 锚点 + 坐标点击；文案锚点在 dump 里通常不存在）。
  await nav.waitAny(byId(ELEME_SELECTORS.homeAnchors), '首页')
  await nav.tap({ resourceId: ELEME_SELECTORS.searchEntry[0]! }, '搜索入口')
  await nav.waitAny(byId([ELEME_SELECTORS.searchInput[0]!]), '搜索页')
  await nav.input({ resourceId: ELEME_SELECTORS.searchInput[0]! }, cond.item, '搜索输入')
  await nav.tap({ resourceId: ELEME_SELECTORS.searchSubmit[0]! }, '搜索按钮')

  // 搜索结果页（canvas）：等结算面板之外，用坐标点第一张结果卡。
  await sleep(nav, 2500)
  const first = await nav.firstResultCard?.()
  if (first && nav.tapPoint) await nav.tapPoint(first.x, first.y, '第一家店铺')

  for (let i = 0; i < 2; i++) {
    await nav.swipeUp()
    await nav.repaint?.()
  }
  await sleep(nav, 1500)

  // 加购（canvas：用 firstActionable 找"去结算/加入购物车"可点区域 → 坐标点）。
  let added = false
  for (let attempt = 0; attempt < 4 && !added; attempt++) {
    const target =
      (await nav.firstActionable?.(['去结算'])) ??
      (await nav.firstActionable?.(['加入购物车', '选规格']))
    if (target && nav.tapPoint) {
      await nav.tapPoint(target.x, target.y, '加购/去结算')
      await sleep(nav, 1500)
      added = true
    } else {
      await nav.repaint?.()
      await sleep(nav, 800)
    }
  }

  // 去结算并读（最多试 3 次；每次读控件树 / OCR）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await tryReadSettle(nav, cond, ctx, settleRightPanel, 6000)
    if (read) return read
    const cart = await nav.firstActionable?.(['去结算'])
    if (cart && nav.tapPoint) {
      await nav.tapPoint(cart.x, cart.y, '去结算')
      await sleep(nav, 1800)
    }
  }

  // 最后一次：等结算页（控件树读不到时也会尝试 OCR）。
  const finalRead = await tryReadSettle(nav, cond, ctx, settleRightPanel, 12000)
  if (finalRead) return finalRead
  // 兜底：返回低置信（payable=NaN）→ 上层 needsConfirm。
  const nodes = await nav.nodes()
  return extractElemeSettle(nodes, cond, await nav.dump())
}

/**
 * 尝试读取结算页：控件树优先；若控件树读不到实付（canvas 自绘）且注入了 OCR，则截图 ROI OCR。
 * 返回 undefined 表示"当前不在结算页/读不到"，调用方继续导航。
 */
async function tryReadSettle(
  nav: Navigator,
  cond: ComparisonConditions,
  ctx: PlatformEnterContext | undefined,
  settleAnchors: UiSelector[],
  timeoutMs: number,
): Promise<RawQuoteFacts | undefined> {
  let r: { nodes: UiNode[]; dump: string }
  try {
    r = await nav.waitAny(settleAnchors, '结算页', timeoutMs)
  } catch {
    // 结算页锚点（含 tms_fragment_container）未等到 → 不在结算页。
    return undefined
  }
  const nodes: UiNode[] = r.nodes
  const dump = r.dump

  const byTree = extractElemeSettle(nodes, cond, dump)
  if (Number.isFinite(byTree.payable)) return byTree

  // 控件树读不到 → OCR 兜底（饿了么 canvas 自绘）。
  if (!ctx?.ocr || !nav.screencap) return byTree // 无 OCR 端口/截屏能力：返回低置信供上层提示
  const roi = settlePanelRoi(nodes)
  const png = await nav.screencap()
  const result = await ctx.ocr.read(png, roi)
  const byOcr = extractElemeSettleFromOcr(result.words, cond, result.text)
  // 保留这张结算页截图作为证据（canvas 自绘没有控件树）；脱敏在 task 层统一处理。
  byOcr.screenshot = png
  // 保留 OCR 逐词框（evidence.rawExtraction.ocrBoxes），便于人工复核金额定位。
  byOcr.ocrWords = result.words
  return byOcr
}

/**
 * 结算面板 ROI：从控件树里的 `tms_fragment_container`（右侧结算容器）bounds 取矩形；
 * 没有则用右半屏（很多平板分栏布局右侧为结算）。避免整屏 OCR 把左侧首页内容混入。
 */
export function settlePanelRoi(
  nodes: UiNode[],
): { x: number; y: number; w: number; h: number } | undefined {
  const panel = nodes.find(
    (n) => n.resourceId && n.resourceId.endsWith('/tms_fragment_container') && n.bounds,
  )
  if (!panel?.bounds) {
    const sb = nodes.find((n) => n.bounds && n.bounds[2] - n.bounds[0] > 0)
    void sb
    return undefined
  }
  const b = panel.bounds
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }
}

function sleep(nav: Navigator, ms: number): Promise<void> {
  void nav
  return new Promise((r) => setTimeout(r, ms))
}
