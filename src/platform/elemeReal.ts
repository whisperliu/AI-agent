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
import type { Driver } from '../device/driver.ts'
import type { ComparisonConditions, DiscountKind, FeeKind, OptionalSaving } from '../price/model.ts'
import type { Ocr, OcrWord } from '../ocr/reader.ts'
import { itemScore } from '../price/similarity.ts'
import { ELEME_SELECTORS } from './selectors/eleme.ts'
import type { Navigator } from './navigator.ts'
import { createNavigator, ensureHome } from './navigator.ts'
import { createOcrNav } from './ocrNav.ts'
import { NeedsHumanError, ForbiddenActionError } from '../core/errors.ts'
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

/**
 * 在一组 OCR 词里找"标签词"右侧同一行的金额词（OCR 无精确 bounds，按 y 与 x 就近）。
 *
 * `prefer='right'`：取行内**最右**金额 —— 用于「实付/合计」这类**汇总行**。饿了么真机实测：
 * `合计  已优惠¥25.92  ¥16.98`，最左是"已优惠"金额（**不是实付**）、最右才是实付。
 * 早期实现取最左，把 ¥16.98 的实付误读成 ¥25.92（真机复测抓到的 bug）。
 */
function ocrAmountRightOf(
  words: OcrWord[],
  labelRe: RegExp,
  prefer: 'left' | 'right' = 'left',
): { amount: number; conf: number } {
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
      .sort((a, b) => (prefer === 'right' ? b.bbox.x - a.bbox.x : a.bbox.x - b.bbox.x))
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
  // 实付：优先「实付/合计/应付/待支付」，其次"立即支付 ¥"。汇总行取**最右**金额（避开"已优惠¥X"）。
  let pay = ocrAmountRightOf(words, /^(实付|合计|应付|待支付|实付款)$/, 'right')
  if (!Number.isFinite(pay.amount)) pay = ocrAmountRightOf(words, /支付$/, 'right')
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
 * 饿了么真机**布局参数**（固定 1600×2560 竖屏平板校准，2026-10-26 真机实测）。
 * 纯数据、可被测试覆盖；换机型需按 `.price-agent/evidence/auto-*.png` 重新校准。
 */
export const ELEME_LAYOUT = {
  homeSearch: { x: 800, y: 312 }, // 首页顶部搜索框
  searchInput: { x: 735, y: 128 }, // 搜索页输入框
  storeFirstDishSpec: { x: 1490, y: 1242 }, // 店铺页首个菜「选规格」按钮
  pickDone: { x: 800, y: 2432 }, // 规格弹窗底部「选好了」
  goSettle: { x: 1453, y: 2432 }, // 店铺页底部「去结算」
  enterKey: 66, // ENTER：提交搜索
} as const

/** 是否具备 OCR 盲导航所需能力（真机 adb：tapPoint + inputText + key + screencap）。 */
export function supportsOcrNav(driver: Driver): boolean {
  return (
    typeof driver.tapPoint === 'function' &&
    typeof driver.inputText === 'function' &&
    typeof driver.key === 'function'
  )
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 菜单区（店铺页菜品列表）的屏幕 y 范围，用于把促销/顶部元素挡在外面。 */
const MENU_Y_MIN = 850
const MENU_Y_MAX = 2400

/**
 * 在店铺页 OCR 词里，定位"首个菜品价格行"的屏幕 y（价格形态如 `¥29.88`）。
 * ⚠️ 只在**菜单列表区**取（y>850，跳过顶部"超级吃货卡¥15/满减券¥20"等促销价——它们在 y<700）。
 * 历史上把下界写成 1150，会漏掉**前两道菜**（首个菜价常在 y≈950）、误取第三道菜（2026-10-26 真机踩到）。
 */
export function locateFirstDishY(words: OcrWord[], fallback: number): number {
  const priceRe = /[¥￥]\s*\d+(?:\.\d{1,2})?|^\d+\.\d{2}$/
  const cands = words
    .filter((w) => priceRe.test(w.t.replace(/\s/g, '')) && w.bbox.y > MENU_Y_MIN && w.bbox.y < 2350)
    .map((w) => Math.round(w.bbox.y + w.bbox.h / 2))
    .sort((a, b) => a - b)
  return cands[0] ?? fallback
}

/**
 * 定位首个菜品「选规格」按钮的屏幕 y。**优先用"选规格"文案本身**（比价格行更准：价格行常带
 * 「预估到手 ¥xx」副行易漂移；「选规格」按钮与菜品行垂直居中，命中即对）。找不到时退回价格行定位。
 */
export function locateFirstDishSpecY(words: OcrWord[], fallbackY: number): number {
  const specs = words
    .filter((w) => /^选规格$/.test((w.t || '').trim()))
    .map((w) => Math.round(w.bbox.y + w.bbox.h / 2))
    .filter((y) => y > MENU_Y_MIN && y < MENU_Y_MAX)
    .sort((a, b) => a - b)
  if (specs.length > 0) return specs[0]!
  return locateFirstDishY(words, fallbackY)
}

/**
 * 判定当前是否落在「拼单详情」页（饿了么拼单）。
 *
 * 背景（2026-10-26 真机定位）：当某商品已存在**进行中的拼单**时，在店铺页点该菜的「选规格」
 * 不会弹规格弹窗，而是直接进「拼单详情」（`拼单 / 邀请好友 / 发起 / 取消拼单`，且**没有**
 * `份量 / 辣度 / 选好了`）。此时绝不能继续盲点：一直重试只会反复进拼单页、甚至把更多菜加进拼单
 * （真机曾一次误加 3 个菜）。识别到即如实交人工（NeedsHuman），不自动取消他人拼单。
 */
export function isGroupOrderPage(words: OcrWord[]): boolean {
  const t = words.map((w) => w.t || '').join('')
  // 用**拼单详情页独有**的强标记；注意**不能**用"拼单进行中"——它是店铺页的入口按钮，店铺页常有。
  const hasGroupPage = /邀请好友|取消拼单|一号发起人|拼单专属|修改商品|帮好友点/.test(t)
  const hasSpec = /份量|辣度|选好了|数量/.test(t)
  return hasGroupPage && !hasSpec
}

/**
 * 饿了么 OCR 盲导航**单次尝试**（一次完整走查）。任何一步 OCR 等待超时即抛出，
 * 由 `runElemeOcrNav` 捕获后**整条重试**（比"等待失败仍盲点"稳：一旦某步错位，后面全乱）。
 * 每次 `look()` 内以 OCR 文本拦验证码/登录（canvas 控件树无文字，这是唯一有效防线）。
 */
async function runElemeOcrOnce(
  driver: Driver,
  ocr: Ocr,
  cond: ComparisonConditions,
): Promise<RawQuoteFacts> {
  const nav = createOcrNav(driver, ocr)
  const L = ELEME_LAYOUT
  const allText = (ws: OcrWord[]) => ws.map((w) => w.t).join('')

  // 1) 强制重启饿了么回首页（避开上次页面残留）。
  if (driver.launchApp) await driver.launchApp('me.ele', { force: true })
  await sleepMs(3500)
  let words = await nav.waitFor(
    (ws) => /推荐|美食外卖|搜索|点外卖/.test(allText(ws)),
    '饿了么首页',
    10000,
  )

  // 2) 首页 → 点搜索框 → 搜索页。
  await nav.tapAt(words, L.homeSearch, '首页搜索框')
  await sleepMs(2000)
  words = await nav.waitFor((ws) => /历史搜索|搜索发现|搜索/.test(allText(ws)), '搜索页', 6000)

  // 3) 点输入框 → 注入菜品关键词 → ENTER 提交。
  await nav.tapAt(words, L.searchInput, '搜索输入框')
  await sleepMs(800)
  await nav.typeText(cond.item)
  await sleepMs(1200)
  await nav.key(L.enterKey)
  await sleepMs(3500)
  words = await nav.waitFor(
    (ws) => /销量|综合|起送|预估|月售|木桶|小炒|店/.test(allText(ws)),
    '搜索结果页',
    8000,
  )

  // 4) 点第一家店（店铺标题坐标）。
  await nav.tapAt(words, { x: 342, y: 400 }, '第一家店')
  await sleepMs(3500)
  words = await nav.waitFor(
    (ws) => /点餐|公告|选规格|预估|去结算/.test(allText(ws)),
    '店铺页',
    8000,
  )

  // 4.5) 店铺页状态守卫：若该商品已存在**进行中的拼单**，点「选规格」会直接进「拼单详情」而非规格弹窗；
  //      此时继续盲点只会反复进拼单页、甚至把更多菜加进拼单（真机曾误加 3 个菜）。识别到即交人工，不自动取消拼单。
  //      （注：配送方式「外送/自取」仅靠 OCR 文本无法可靠区分——两 tab 文案一直都在，高亮色不在 OCR 内，
  //        故不做 OCR 层面的自取拦截；改为在**结算页**按实际费用（配送费/打包费）自然反映。）
  if (isGroupOrderPage(words)) {
    throw new NeedsHumanError(
      'environment',
      '该商品存在进行中的拼单，点「选规格」会进入拼单详情而非规格弹窗；请先在饿了么取消/完成该拼单后重试',
    )
  }

  // 5) 加购：点首个菜「选规格」→ 弹窗「选好了」。
  //    ⚠️ 红线：**只点一次**。点多个候选 y 会把不同菜品逐个加进购物车（真机踩过：一次误加 3 个菜）——
  //    加购是有副作用、非幂等的操作。故这里只按"首个菜品行"点一次，且**必须等到规格弹窗**，
  //    否则如实失败（宁可返回低置信/让他人复核，也绝不乱加菜）。
  const specY = locateFirstDishSpecY(words, L.storeFirstDishSpec.y)
  await nav.tapAt(words, { x: L.storeFirstDishSpec.x, y: specY }, '首个菜-选规格')
  await sleepMs(2200)
  // 点完「选规格」若落到拼单详情页（无规格弹窗、有「拼单/邀请好友」）→ 立即交人工，绝不重试盲点。
  words = await nav.look()
  if (isGroupOrderPage(words)) {
    throw new NeedsHumanError(
      'environment',
      '点「选规格」后进入「拼单详情」而非规格弹窗（该菜已在拼单中）；请先在饿了么取消/完成该拼单后重试',
    )
  }
  words = await nav.waitFor((ws) => /份量|辣度|选好了|数量/.test(allText(ws)), '规格弹窗', 6000)
  await nav.tapAt(words, L.pickDone, '选好了')
  await sleepMs(2200)

  // 6) 去结算（按钮文案在真机上是「领券结算 / 去结算」，都有"结算"）。
  words = await nav.waitFor((ws) => /结算|购物车|券后/.test(allText(ws)), '购物车栏', 6000)
  await nav.tapAt(words, L.goSettle, '去结算')
  await sleepMs(4000)

  // 7) 结算页 → OCR 读实付（绝不点「支付」）。
  words = await nav.waitFor(
    (ws) => /合计|实付|配送费|打包费|支付/.test(allText(ws)),
    '结算页',
    8000,
  )
  // 守卫：「拼单详情」页同样有「合计/去结算」，若误入会把这**整单拼单总额**当成本菜实付 → 必须拦住不读。
  if (isGroupOrderPage(words)) {
    throw new NeedsHumanError(
      'environment',
      '进入了「拼单详情」页（合计为整单拼单金额，非本菜实付）；请先在饿了么取消/完成该拼单后重试',
    )
  }
  const facts = extractElemeSettleFromOcr(words, cond, allText(words))
  if (!Number.isFinite(facts.payable)) throw new Error('结算页 OCR 未读到实付')
  try {
    facts.screenshot = await driver.screencap()
  } catch {
    /* 截屏失败不影响读数 */
  }
  facts.ocrWords = words
  return facts
}

/**
 * 饿了么 OCR 盲导航主流程：整体最多尝试 `attempts` 次（每次都是完整走查）。
 * 验证码/登录/支付红线**立即上抛**（绝不重试）；其它失败（OCR 抖动/页面未就绪）改进程内重试。
 */
export async function runElemeOcrNav(
  driver: Driver,
  ocr: Ocr,
  cond: ComparisonConditions,
  attempts = 3,
): Promise<RawQuoteFacts> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await runElemeOcrOnce(driver, ocr, cond)
    } catch (err) {
      if (err instanceof NeedsHumanError || err instanceof ForbiddenActionError) throw err
      lastErr = err
      await sleepMs(500)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('饿了么 OCR 盲导航失败')
}

/**
 * 真机走查：首页 → 搜索 item → 选第一家店 → 加购 → 进结算 → 读实付。
 *
 * 饿了么整 App 为 canvas/TMS 自绘，`uiautomator` 无控件可点 → 真机优先走 **OCR 盲导航**
 * （`runElemeOcrNav`：截图→OCR 定位→坐标点按，全程用 OCR 做支付红线拦截）。能力不足或失败时
 * 回退旧的 navigator 路径（对旧机型/非 canvas 版本仍有用）。
 * 超时 → StateAssertionError；验证码/登录 → NeedsHumanError。
 */
export async function runElemeReal(
  driver: Driver,
  cond: ComparisonConditions,
  ctx?: PlatformEnterContext,
): Promise<RawQuoteFacts> {
  const nav = createNavigator(driver)
  const settle = elemeAnchors()
  const settleRightPanel = [...settle, { resourceId: 'tms_fragment_container' }]

  // 已在结算页 → 直接读（控件树优先，读不到则 OCR），零点击（最安全路径）。
  // 注意：`tryReadSettle` 在"锚点命中但读不到实付"时会返回 payable=NaN 的对象，**不能当已读成功**。
  const already = await tryReadSettle(nav, cond, ctx, settleRightPanel, 1500)
  if (already && Number.isFinite(already.payable)) return already

  // canvas 自绘 → OCR 盲导航（真机 + 已注入 OCR）。失败则如实抛出（旧 navigator 路径对 canvas 无效）。
  if (supportsOcrNav(driver) && ctx?.ocr) {
    return runElemeOcrNav(driver, ctx.ocr, cond)
  }

  // 回退：导航（按 resourceId 锚点 + 坐标点击；文案锚点在 dump 里通常不存在）。
  const byId = (ids: string[]): UiSelector[] => ids.map((id) => ({ resourceId: id }))
  await ensureHome(nav, byId(ELEME_SELECTORS.homeAnchors), { appId: 'me.ele' })
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
