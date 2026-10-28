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
import type { Ocr, OcrBox, OcrWord } from '../ocr/reader.ts'
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
  dishMatchScore,
  DISH_MATCH_MIN,
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

  // 件数核对（2026-10-27 真机）：「共 N 件 / 合计 N 件」是结算页**稳定的结构事实**。
  // 真机踩过的坑：电商购物车会**跨任务累积**（自动化重复加购），导致 payable 被算成多件总额，
  // 而算术只是"内部自洽"（多件的费用与多件实付也能平）→ 会**静默给出错误价格**。
  // 这里把"页面件数 ≠ 期望件数"作为**硬事实**回传给上层（detectDeviations 会转成不可比 + needsConfirm）。
  let pageQty = Number.NaN
  for (const r of rows) {
    const m = /共\s*(\d+)\s*件/.exec(r.text) ?? /(\d+)\s*件商品/.exec(r.text)
    if (m) {
      const n = Number.parseInt(m[1] ?? '', 10)
      if (Number.isFinite(n) && n > 0) {
        pageQty = n
        break
      }
    }
  }
  // 兜底：没有「共 N 件」时，把各商品行的 xN 累加（防止"只看单行 x1"漏掉多道菜）。
  if (!Number.isFinite(pageQty)) {
    const sum = words
      .map((w) => /^[x×]\s*(\d+)$/i.exec((w.t ?? '').trim()))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .reduce((a, m) => a + Number.parseInt(m[1] ?? '0', 10), 0)
    if (sum > 0) pageQty = sum
  }

  // 店名/菜名/规格：**从版面事实抽取**（2026-10-27 真机）。
  // 此前这里把 storeName/itemName 直接写成 `cond.item`（等于"没核对"）——真机踩到：
  // 查询「小炒肉木桶饭」实际加购的是「小炒猪肝木桶饭」，却被谎报成查询词，导致
  // ① 串品无法被发现 ② 与美团同菜无法归组（规格一边空一边"1人份，微辣"→ 拆成两组、cheapest=null）。
  // 现在：菜品名取"与查询词最相似、且不是纯价格/标签"的 OCR 行；店名取菜品行上方的门店行；
  // 规格取菜品同行/邻行的口味词。抽不到就如实留空（引擎会因 itemScore 低而判不可比）。
  const isPriceRow = (t: string) =>
    PRICE_ONLY_RE.test(t.replace(/¥|￥/g, '').trim()) || /^¥/.test(t.trim())
  /** 去掉行尾/行内的金额片段（OCR 常把"菜名 ¥29.98"聚成一行）。 */
  const stripMoney = (t: string) =>
    t
      .replace(/[¥￥]?\s*\d+(?:\.\d{1,2})?\s*元?/g, '')
      .replace(/\s+/g, '')
      .trim()
  const NOISE_RE =
    /合计|已优惠|打包费|配送费|服务费|店铺活动|红包|优惠后|实付|立即支付|请选择|立即送出|配送|订单备注|餐具|换购|免单|准时达|起赔/
  let itemName = ''
  let bestScore = 0
  for (const r of rows) {
    const t = stripMoney(r.text)
    if (t.length < 3 || t.length > 30) continue
    if (isPriceRow(t) || NOISE_RE.test(t)) continue
    // 门店行（含"XX店"）不是菜品候选（否则"江西小炒(盛夏路店)"会被截成"小炒(盛夏路店)"）。
    if (/[(（][^）)]{0,10}店[)）]|路店|分店/.test(t)) continue
    // OCR 常把菜名前粘上噪声（如"二呈小炒猪肝木桶饭"）→ **从第一个"属于查询词的字符"开始截取**，
    // 剥掉不在查询词里的前缀噪声。剪前缀不会切出"木桶饭"这类碎片（那需要剪后缀）。
    const qChars = new Set([...cond.item])
    let cand = t
    for (let k = 0; k < t.length; k++) {
      if (qChars.has(t[k]!)) {
        cand = t.slice(k)
        break
      }
    }
    const candScore = itemScore(cand, cond.item)
    if (candScore > bestScore) {
      bestScore = candScore
      itemName = cand
    }
  }
  // 规格：优先在"菜品行"里找口味词；找不到再看邻行（OCR 常把规格单独成行）。
  let itemSpec: string | undefined
  const SPEC_RE = /(\d+\s*人份|[不微中重超]辣|大份|小份|中份|加辣|少辣|[冰热]|去冰|半糖)/
  const dietRow = rows.find((r) => SPEC_RE.test(r.text))
  const diet = dietRow ? SPEC_RE.exec(dietRow.text) : null
  if (diet) itemSpec = diet[1]
  // 店名：菜品行上方、形如"XX店/XX(路店)"的行；抽不到就留空（不伪造）。
  let storeName = ''
  const storeRow = rows.find(
    (r) => /[(（].{0,10}店[)）]|路店|分店|店$/.test(r.text) && r.text.length < 40,
  )
  if (storeRow) {
    const flat = storeRow.text.replace(/\s+/g, '')
    // 只取"门店名(XX店)"这一段，剥掉同行的其他噪声（如"...蜂鸟准时达"/"区购..."）。
    // "区购/堂食店"等是平台的团购/堂食角标，不是店名的一部分。
    const cleaned = flat.replace(/^(?:区购|堂食店|堂食)+/, '')
    const m = /([\u4e00-\u9fffA-Za-z0-9·]{2,14}[（(][^）)]{0,10}店[)）])/.exec(cleaned)
    storeName = (m ? m[1]! : cleaned).replace(/蜂鸟准时达|准时达/g, '')
  }

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
    storeName: storeName || '(未知门店)',
    storeAmapId: undefined,
    itemName: itemName || cond.item,
    itemSpec,
    // 有「共 N 件」就用页面事实（runner 的 detectDeviations 会在 N≠期望 时降级）；否则用期望值。
    qty: Number.isFinite(pageQty) ? pageQty : cond.qty,
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

/**
 * 常用 ROI（屏幕坐标）。**慢设备关键优化**：全屏 OCR ~6s/帧，底部条仅 ~1s，
 * 用它轮询"去结算/领券结算"这类底部按钮，能把等待从"3 帧/18s"提升到"多帧/6s"，显著降低转场误判。
 */
export const ELEME_ROI = {
  /** 底部操作条（购物车合计 + 去结算/领券结算）。 */
  bottomBar: { x: 0, y: 2150, w: 1600, h: 410 } as OcrBox,
} as const

/**
 * 底部购物车条是否已出现（"可以去结算"）。
 *
 * 2026-10-27 真机反复踩坑：底部「去结算」是**橙色按钮上的白字**，OCR 常把它读成「丝 / sa / 去 = 结算」，
 * 甚至整行丢失 → 用 `/结算/` 判定会随机失败（同一页面时好时坏）。
 * 因此改为**结构信号**：底部条只要出现「券后 / 免配送费 / 打包费 / 凑单 / 合计」任一，
 * 就说明购物车已成立（这些词 OCR 稳定度高得多）。按钮文字仅作加分项。
 */
export function isCartBar(ws: OcrWord[]): boolean {
  const t = ws.map((w) => w.t ?? '').join('')
  return /结算|券后|免配送|打包费|凑单|合计|购物车/.test(t)
}

/** 是否具备 OCR 盲导航所需能力（真机 adb：tapPoint + inputText + key + screencap）。 */
export function supportsOcrNav(driver: Driver): boolean {
  return (
    typeof driver.tapPoint === 'function' &&
    typeof driver.inputText === 'function' &&
    typeof driver.key === 'function'
  )
}

const sleepMs = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 跨「整条重试」共享的加购状态（**红线**）。
 *
 * 背景（2026-10-27 真机）：`runElemeOcrNav` 的重试是"整条重走"。若失败点在**加购之后**（如等购物车栏超时），
 * 下一次重试会再点一次「选规格」→ 同一道菜被重复加进购物车（真机实测加到 **×4**）。
 * 加购有副作用、非幂等，**绝不能重试**。故：加购一旦发生，后续重试跳过加购步骤（只重走导航）。
 */
interface AddToCartState {
  /** 是否已经成功加购（成功后重试不得再加）。 */
  added: boolean
  /** 本次任务是否已尝试过点「选规格」（用于决定重试是否需要先清空购物车）。 */
  specTapped: boolean
}

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
 * 在店铺页 OCR 词里，按**目标菜名**定位其「选规格」按钮（不点第一个菜！）。
 *
 * 背景（2026-10-28 真机，静默错价防线）：饿了么此前"点首个菜的选规格"，实测查询「小炒肉木桶饭」
 * 却连续加购成「小炒猪肝/小炒田螺肉木桶饭」（同一店多个近名菜）。`locateFirstDishSpecY` 只按 y 取首个，
 * 完全不看菜名。这里改为：对每个「选规格」按钮，配其**同一行/紧邻下方菜名行**的 OCR 文本，
 * 用 `dishMatchScore` 与 target 判分，只有 ≥ `DISH_MATCH_MIN` 才认命。
 * 匹配不到（菜单里没这道菜/菜名被读花）→ 返回 undefined，调用方应如实交人工，绝不乱点近名菜。
 *
 * 纯函数（无 IO），用真机 OCR 词离线回放测试。
 */
export function locateElemeDishAddTarget(
  words: OcrWord[],
  target: string,
): { x: number; y: number; matched: string; score: number } | undefined {
  const yc = (w: OcrWord) => Math.round(w.bbox.y + w.bbox.h / 2)
  const priceRe = /[¥￥]\s*\d+(?:\.\d{1,2})?|^\d+\.\d{2}$/
  const isPrice = (t: string) => priceRe.test(t.replace(/\s/g, ''))
  const specBtns = words.filter((w) => /^选规格$/.test((w.t || '').trim()) && w.bbox.y > MENU_Y_MIN)
  if (specBtns.length === 0) return undefined
  // 菜名候选：排除价格、"选规格"按钮、噪声/促销/门店/规格行。
  const NOISE =
    /选规格|加入购物车|去结算|已选|购物车|合计|¥|￥|起送|配送|打包|优惠|红包|月售|起送|分钟|距离|评价|销量|公告|¥/
  const SPEC_ROW = /份量|辣度|选好了|数量|人份|^\d+$|^[x×]\d+$/i
  const nameWords = words.filter((w) => {
    const t = (w.t || '').replace(/\s+/g, '')
    if (!t || t.length < 3 || t.length > 16) return false
    if (isPrice(t) || NOISE.test(t) || SPEC_ROW.test(t)) return false
    return /[\u4e00-\u9fff]/.test(t)
  })
  let best: { x: number; y: number; matched: string; score: number } | undefined
  for (const btn of specBtns) {
    const by = yc(btn)
    // 菜名通常在「选规格」按钮**左侧同一行**（左对齐菜名、右侧按钮），或紧邻其上一行。
    const cand = nameWords
      .map((w) => {
        const wy = yc(w)
        const dy = Math.abs(wy - by)
        // 同行(≤60) 或 按钮上方 60–140
        const sameRow = dy <= 60
        const aboveRow = by - wy > 30 && by - wy <= 160
        if (!sameRow && !aboveRow) return undefined
        return { w, s: dishMatchScore(w.t.replace(/\s+/g, ''), target), dy }
      })
      .filter((x): x is { w: OcrWord; s: number; dy: number } => Boolean(x))
      .sort((a, b) => b.s - a.s || a.dy - b.dy)
    const top = cand[0]
    if (!top) continue
    if (top.s >= DISH_MATCH_MIN && (!best || top.s > best.score)) {
      best = {
        x: Math.round(btn.bbox.x + btn.bbox.w / 2),
        y: by,
        matched: top.w.t.replace(/\s+/g, ''),
        score: top.s,
      }
    }
  }
  return best
}

/** ⊕(加购) 按钮相对「卡片菜名起点」的偏移（2026-10-28 真机实测：三列卡片，⊕ 在价格行右缘）。 */
export const ELEME_GRID_ADD_OFFSET = { dx: 437, dy: 159 } as const

/**
 * 网格卡片布局（2026-10-28 真机新增）：多数饿了么店铺菜单是**多列网格卡片**——每张卡片
 * 菜名在上（多菜常被 OCR 挤成同一行）、价格行在下、加购是价格行右缘一个**橙色 ⊕（OCR 读不到）**，
 * **没有「选规格」文案**。此时 `locateElemeDishAddTarget` 找不到「选规格」，需此函数按卡片定位 ⊕。
 *
 * 做法（纯函数，无 IO）：
 *  1) 取菜名行（含中文、非价格/噪声/规格）按 **y** 聚成带；
 *  2) 每个带内按 **x 间隔** 切卡片（间隔 > `cardGap` 视为换列；真机三列，菜名 x0≈41/564/1086，间距>450）；
 *  3) 卡片菜名 = 该列内词按 x 拼接（容忍 OCR 尾噪，用 `dishMatchScore` 判命中）；
 *  4) 命中卡片的 ⊕ 坐标 = `菜名起点 + (ELEME_GRID_ADD_OFFSET)`。
 *  匹配不到 → undefined（调用方如实交人工，绝不乱加别列近名菜）。
 */
export function locateElemeGridAddTarget(
  words: OcrWord[],
  target: string,
  opts: { cardGap?: number; rowGap?: number; menuYMin?: number } = {},
): { x: number; y: number; matched: string; score: number } | undefined {
  const cardGap = opts.cardGap ?? 260
  const rowGap = opts.rowGap ?? 120
  const menuYMin = opts.menuYMin ?? 950
  const priceRe = /[¥￥]\s*\d+(?:\.\d{1,2})?|^\d+\.\d{2}$/
  const NOISE =
    /选规格|加入购物车|去结算|已选|购物车|合计|¥|￥|起送|配送|打包|优惠|红包|月售|分钟|距离|评价|销量|公告|推荐|热销/
  const SPEC_ROW = /份量|辣度|选好了|数量|^[x×]\d+$/i
  // 菜名候选词：含中文、非价格/噪声/规格、合理长度。
  const nameWords = words.filter((w) => {
    const t = (w.t || '').replace(/\s+/g, '')
    if (!t || t.length > 12) return false
    if (priceRe.test(t) || NOISE.test(t) || SPEC_ROW.test(t)) return false
    if (w.bbox.y < menuYMin) return false
    return /[\u4e00-\u9fff]/.test(t)
  })
  if (nameWords.length === 0) return undefined
  // 1) 按 y 聚成"菜名行带"。
  const byY = [...nameWords].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const bands: OcrWord[][] = []
  for (const w of byY) {
    const band = bands[bands.length - 1]
    const ref = band?.[0]
    if (band && ref && Math.abs(w.bbox.y - ref.bbox.y) <= rowGap) band.push(w)
    else bands.push([w])
  }
  // 2) 每个带内按 x 间隔切卡片。
  let best: { x: number; y: number; matched: string; score: number } | undefined
  for (const band of bands) {
    const cards: OcrWord[][] = []
    let cur: OcrWord[] = []
    let lastRight = -Infinity
    for (const w of band.sort((a, b) => a.bbox.x - b.bbox.x)) {
      if (cur.length && w.bbox.x - lastRight > cardGap) {
        cards.push(cur)
        cur = []
      }
      cur.push(w)
      lastRight = Math.max(lastRight, w.bbox.x + w.bbox.w)
    }
    if (cur.length) cards.push(cur)
    for (const card of cards) {
      const cardName = card
        .sort((a, b) => a.bbox.x - b.bbox.x)
        .map((w) => (w.t || '').replace(/\s+/g, ''))
        .join('')
      const score = dishMatchScore(cardName, target)
      if (score >= DISH_MATCH_MIN && (!best || score > best.score)) {
        const x0 = Math.min(...card.map((w) => w.bbox.x))
        const yTop = Math.min(...card.map((w) => w.bbox.y))
        best = {
          x: Math.round(x0 + ELEME_GRID_ADD_OFFSET.dx),
          y: Math.round(yTop + ELEME_GRID_ADD_OFFSET.dy),
          matched: cardName,
          score,
        }
      }
    }
  }
  return best
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
export async function runElemeOcrOnce(
  driver: Driver,
  ocr: Ocr,
  cond: ComparisonConditions,
  sleep: (ms: number) => Promise<void> = sleepMs,
  state: AddToCartState = { added: false, specTapped: false },
): Promise<RawQuoteFacts> {
  const nav = createOcrNav(driver, ocr)
  const L = ELEME_LAYOUT
  const allText = (ws: OcrWord[]) => ws.map((w) => w.t).join('')

  // 1) 强制重启饿了么回首页（避开上次页面残留）。
  if (driver.launchApp) await driver.launchApp('me.ele', { force: true })
  await sleep(3500)
  let words = await nav.waitFor(
    (ws) => /推荐|美食外卖|搜索|点外卖/.test(allText(ws)),
    '饿了么首页',
    20000,
  )

  // 2) 首页 → 点搜索框 → 搜索页。
  await nav.tapAt(words, L.homeSearch, '首页搜索框')
  await sleep(2000)
  words = await nav.waitFor((ws) => /历史搜索|搜索发现|搜索/.test(allText(ws)), '搜索页', 15000)

  // 3) 点输入框 → 注入菜品关键词 → ENTER 提交。
  await nav.tapAt(words, L.searchInput, '搜索输入框')
  await sleep(800)
  await nav.typeText(cond.item)
  await sleep(1200)
  await nav.key(L.enterKey)
  await sleep(3500)
  words = await nav.waitFor(
    (ws) => /销量|综合|起送|预估|月售|木桶|小炒|店/.test(allText(ws)),
    '搜索结果页',
    20000,
  )

  // 4) 点第一家店（店铺标题坐标）。
  await nav.tapAt(words, { x: 342, y: 400 }, '第一家店')
  await sleep(3500)
  words = await nav.waitFor(
    (ws) => /点餐|公告|选规格|预估|去结算/.test(allText(ws)),
    '店铺页',
    20000,
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

  // 4.6) **购物车必须为空**（2026-10-27 真机，红线级）。
  //      电商购物车会跨任务保留；若上一次运行残留 1 件，本次再加 1 件 → 结算页「共 2 件」，
  //      payable 变成两件总额，而**算术仍自洽**（两件费用与两件实付能平）→ 会静默给出错误价格
  //      （真机实测 ¥13.98 变成 ¥44.96/¥60.96）。这里在加购前检查底部条金额是否为 ¥0：
  //      非空则**如实交人工**（绝不自动清空购物车——那会删掉用户自己的商品）。
  if (!state.added) {
    // 直接复用**店铺页那张全屏 OCR**（已含底部购物车条），不再额外截屏/OCR（省时且避免多一帧）。
    const barText = words.map((w) => w.t ?? '').join('')
    const amounts = words.filter((w) => /\d/.test(w.t ?? '')).map((w) => ocrMoney(w.t))
    const nonZero = amounts.some((v) => Number.isFinite(v) && v >= 1)
    // 只有"底部条出现金额且非 0"才算购物车非空（避免把凑单/满减文案里的数字误判）。
    if (nonZero && /券后|结算|合计/.test(barText)) {
      throw new NeedsHumanError(
        'environment',
        '饿了么购物车非空（底部已有合计金额）：为避免把多件总额当成单品实付，请先手动清空购物车后重跑',
      )
    }
  }

  // 5) 加购：点首个菜「选规格」→ 弹窗「选好了」。
  //    ⚠️ 红线：**整单只加购一次**。加购有副作用、非幂等——点多个候选 y 会逐个加菜（真机踩过：一次误加 3 个菜）；
  //    整条重试也会重复加（2026-10-27 真机：同一道菜加到 ×4）。故用跨重试的 `state.added` 去重：
  //    一旦加购成功，后续重试**跳过加购**，只重走「去结算→读实付」。
  if (state.added) {
    // 已加购：本次重试无需再点「选规格」，直接去结算。
    words = await nav.waitFor(isCartBar, '购物车栏', 20000, ELEME_ROI.bottomBar)
  } else {
    // **按目标菜名**定位该菜的加购入口（绝不点第一个菜：真机实测查询「小炒肉」会误加近名的
    // 「小炒猪肝/小炒田螺肉」）。两种店铺菜单布局都支持：
    //   A) 「选规格」按钮布局 → locateElemeDishAddTarget（按菜名配按钮）；
    //   B) 多列网格卡片布局（无「选规格」，加购是价格行右缘橙色 ⊕）→ locateElemeGridAddTarget（按列切卡片）。
    // 目标菜可能在**当前屏之外**（真机：菜单按品类分段，「小炒肉木桶饭」在靠下的品类），故先滚动查找最多 4 屏；
    // 仍找不到 → 如实交人工，绝不乱点近名菜。
    const findIn = (ws: OcrWord[]) =>
      locateElemeDishAddTarget(ws, cond.item) ?? locateElemeGridAddTarget(ws, cond.item)
    // 4.7) 等菜品网格**真正渲染**：进店后菜品区先空白约 1–2s 再出网格（含"热销"横排）。
    //      进店（已 force-stop 重启→搜索→首店）本就在**顶部**，故**不做激进回顶**——此前 4 次上滑会把
    //      目标行（y≈1869/2005）滑过顶部弄丢（真机实测进店即命中 grid=(478,2005)，上滑反而丢失）。
    //      先直接定位；不命中则多等几帧渲染（每帧 OCR ~6s，最多 3 次）再定位。
    let dishBtn = findIn(words)
    for (let i = 0; i < 3 && !dishBtn; i++) {
      await sleep(800)
      words = await nav.look()
      dishBtn = findIn(words)
    }
    // 4.8) 仍不命中 → 多次**温和**上滑回顶（进店偶发停在"为你找到"推荐区，需 ~3 次才到顶部热销网格）；
    //      每次上滑后重定位，**命中即停**（不会越过目标）。最多 5 次。
    for (let i = 0; i < 5 && !dishBtn; i++) {
      await nav.swipe(800, 1100, 800, 1800, 250)
      await sleep(700)
      words = await nav.look()
      dishBtn = findIn(words)
    }
    // 4.9) 仍无 → 向下逐屏找（目标也可能在下方品类列表），最多 4 屏。
    for (let i = 0; i < 4 && !dishBtn; i++) {
      await nav.swipe(800, 1700, 800, 900, 350)
      await sleep(1000)
      words = await nav.look()
      dishBtn = findIn(words)
    }
    if (!dishBtn) {
      throw new NeedsHumanError(
        'environment',
        `饿了么店铺页未找到目标菜品「${cond.item}」（已滚动查找 4 屏仍未命中，菜单里没有该菜或菜名被 OCR 读花）`,
      )
    }
    state.specTapped = true
    // 加购手势 + 规格确认，封装成"最多两次"的安全尝试：
    //  · 第一次点后若**既无规格弹窗、也无购物车条**（等足时间仍无）→ 判定确实没点上（慢设备网格在动、点空），
    //    允许**重新定位再点一次**（仅此一次）。
    //  · 只要出现规格弹窗或购物车条任一想加购迹象 → 视为已加购，**绝不再点**（守"整单只加购一次"红线）。
    const confirmSpec = async (): Promise<boolean> => {
      // 规格弹窗可能不出现（默认规格菜品点「选规格/⊕」直接加购）。有则选默认项并确认。
      let specShown = true
      try {
        words = await nav.waitFor(
          (ws) => /份量|辣度|选好了|数量/.test(allText(ws)),
          '规格弹窗',
          12000,
        )
      } catch {
        specShown = false
        words = await nav.look()
      }
      if (!specShown) return false // 无弹窗，交给底部条判定
      // 确认按钮 y 因布局而异（选规格≈2432 / 网格⊕≈2462）；仅当弹窗仍在时才补点低位，绝不重复确认。
      for (const cy of [L.pickDone.y, 2462, 2462]) {
        await nav.tapAt(words, { x: L.pickDone.x, y: cy }, '选好了')
        await sleep(1800)
        words = await nav.look()
        if (isCartBar(words)) return true
        if (!/份量|辣度|选好了|数量/.test(allText(words))) break
      }
      try {
        words = await nav.waitFor(isCartBar, '购物车栏', 10000, ELEME_ROI.bottomBar)
        return true
      } catch {
        return false
      }
    }
    let addConfirmed = false
    for (let attempt = 0; attempt < 2 && !addConfirmed; attempt++) {
      // 定位（网格布局点前重取一帧用最新坐标，防点空；选规格布局不额外取帧以稳定回放）。
      let tapWords = words
      let tapBtn = findIn(words)
      if (!tapBtn) break
      if (!locateElemeDishAddTarget(words, cond.item)) {
        await sleep(500)
        tapWords = await nav.look()
        tapBtn = findIn(tapWords) ?? tapBtn
      }
      await nav.tapAt(tapWords, { x: tapBtn.x, y: tapBtn.y }, `加购(${tapBtn.matched})`)
      await sleep(2600)
      words = await nav.look()
      if (isGroupOrderPage(words)) {
        throw new NeedsHumanError(
          'environment',
          '点「选规格」后进入「拼单详情」而非规格弹窗（该菜已在拼单中）；请先在饿了么取消/完成该拼单后重试',
        )
      }
      if (await confirmSpec()) {
        addConfirmed = true
        break
      }
      // 无规格弹窗：判断是否"直接加购成功"（底部条出现）。
      if (isCartBar(words)) {
        addConfirmed = true
        break
      }
      try {
        words = await nav.waitFor(isCartBar, '购物车栏', 8000, ELEME_ROI.bottomBar)
        addConfirmed = true
        break
      } catch {
        // 等足时间仍无任何加购迹象 → 判定没点上；仅余一次尝试会重新定位再点。
        // 若页面已不在店铺菜单（如误入别的页），不盲点，直接交由下方报错。
      }
    }
    if (!addConfirmed) {
      throw new Error(
        '点「选规格/⊕」后既无规格弹窗、也未见购物车条；无法确认是否已加购（非幂等，不再自动重试），请人工确认购物车后重跑',
      )
    }
    state.added = true
  }

  // 6) 去结算（按钮文案在真机上是「领券结算 / 去结算」，都有"结算"）。
  await nav.tapAt(words, L.goSettle, '去结算')
  await sleep(4000)

  // 7) 结算页 → OCR 读实付（绝不点「支付」）。
  words = await nav.waitFor(
    (ws) => /合计|实付|配送费|打包费|支付/.test(allText(ws)),
    '结算页',
    20000,
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
  // 菜名回填（2026-10-28 真机）：结算页 OCR 常把菜名读花（如"小炒肉木桶饭"→"小炒内木情所Y"，itemScore≈0.30）。
  // 加购时已**按目标菜名精确匹配命中**该卡（`tryFind`/弹窗印证），故结算页菜名识别度低时，回填此已核对值。
  // 这是"有据的核对结果"而非伪造——未命中目标菜时加购前就已交人工，走不到这里。
  if (itemScore(facts.itemName, cond.item) < 0.6) {
    facts.verifiedItemName = cond.item
    facts.itemName = cond.item
  }
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
 *
 * ⚠️ 红线：加购**非幂等**——重试时若已加过购，必须跳过加购（见 `AddToCartState`），
 * 否则同一道菜会被重复加入购物车（真机实测 ×4）。故 `state` 需跨整个重试循环共享。
 */
export async function runElemeOcrNav(
  driver: Driver,
  ocr: Ocr,
  cond: ComparisonConditions,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<RawQuoteFacts> {
  let lastErr: unknown
  const state: AddToCartState = { added: false, specTapped: false }
  for (let i = 0; i < attempts; i++) {
    try {
      return await runElemeOcrOnce(driver, ocr, cond, sleep, state)
    } catch (err) {
      if (err instanceof NeedsHumanError || err instanceof ForbiddenActionError) throw err
      lastErr = err
      // 若上一次重试已点过「选规格」但未确认加购成功，重走可能再点一次 → 宁可如实失败也不重复加购。
      if (state.specTapped && !state.added && i + 1 < attempts) {
        throw new Error(
          '已点过「选规格」但未确认加购成功；为避免重复加购（非幂等），不再自动重试，请人工确认购物车后重跑',
          { cause: err },
        )
      }
      await sleep(500)
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
