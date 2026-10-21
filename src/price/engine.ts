/**
 * price/engine.ts — 折算引擎（docs/module-spec.md §5.3/§5.4、§6.3/§6.4）。
 * 层：pure。无 IO，时间由调用方注入。
 *
 * 职责：
 *  - assess()     : 产出两层结论（arithmetic 自洽 × extraction 识别可信度）+ needsConfirm（§6.3.1 矩阵）
 *  - priceQuote() : 由 draft 算出 effectivePrice（防重复扣）并组装成完整 Quote
 *  - compare()    : 按"同一顿饭"分组，组内可比，选出可信 cheapest（§6.2 兜底）
 */
import type {
  Arithmetic,
  CompareResult,
  ComparisonConditions,
  Confidence,
  Evidence,
  Extraction,
  Quote,
  QuoteDraft,
} from './model.ts'
import { deductibleSavings, expectedPayable, round2, toleranceFor } from './schema.ts'
import { evidenceComplete, isExpired } from './evidence.ts'
import { isSameMeal, normalizeName } from './similarity.ts'

const CONF_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }
const minConf = (a: Confidence, b: Confidence): Confidence =>
  CONF_ORDER[a] <= CONF_ORDER[b] ? a : b

/** 所有费用/优惠是否都来自控件树（derived/ocr 都不算）。 */
function allFromTree(draft: QuoteDraft): boolean {
  return (
    draft.fees.every((f) => f.source === 'tree') &&
    draft.discounts.every((d) => d.source === 'tree')
  )
}

export interface Assessment {
  arithmetic: Arithmetic
  extraction: Extraction
  needsConfirm: boolean
  reasons: string[]
}

/** 两层评估（§6.3.1 判定矩阵 + §6.5 证据降级）。 */
export function assess(draft: QuoteDraft): Assessment {
  const expected = expectedPayable(draft)
  const delta = round2(expected - draft.payable)
  const tolerance = toleranceFor(draft.platform, expected)
  const balanced = Math.abs(delta) <= tolerance

  const arithmetic: Arithmetic = { balanced, expected, delta, tolerance }

  // 识别可信度：以调用方（OCR 质量门）给出为基础；但"全 tree"是 high 的必要条件
  let confidence: Confidence = draft.extraction.confidence
  if (!allFromTree(draft)) confidence = minConf(confidence, 'medium')
  const complete = evidenceComplete(draft.evidence)
  if (!complete) confidence = 'low'
  const extraction: Extraction = { ...draft.extraction, confidence }

  const reasons: string[] = []
  if (!balanced) reasons.push('算术不平（明细与实付不符，可能有未建模费用/优惠或读错）')
  if (balanced && confidence !== 'high') reasons.push('含 OCR/推算或可信度不足，需核对截图')
  if ((draft.deviatedConditions?.length ?? 0) > 0) reasons.push('偏离输入快照的条件')
  if (!complete) reasons.push('证据缺失')

  const needsConfirm = !balanced || confidence !== 'high' || reasons.length > 0
  return { arithmetic, extraction, needsConfirm, reasons }
}

/** 由 draft 计算并组装完整 Quote（effectivePrice 只扣 verified 且未含的优惠）。 */
export function priceQuote(draft: QuoteDraft): Quote {
  const a = assess(draft)
  const effectivePrice = round2(draft.payable - deductibleSavings(draft.optionalSavings ?? []))
  const evidence: Evidence = {
    ...draft.evidence,
    checkResult: { arithmetic: a.arithmetic, extraction: a.extraction },
  }
  return {
    platform: draft.platform,
    store: draft.store,
    item: draft.item,
    fees: draft.fees,
    discounts: draft.discounts,
    payable: draft.payable,
    effectivePrice,
    arithmetic: a.arithmetic,
    extraction: a.extraction,
    needsConfirm: a.needsConfirm,
    deviatedConditions: draft.deviatedConditions,
    optionalSavings: draft.optionalSavings,
    evidence,
  }
}

/** 分组键：套餐组成 + 数量 + 规格（"同一顿饭"的形态）。 */
export function mealKey(q: Quote): string {
  const comp = [...(q.item.composition ?? [])].map(normalizeName).sort().join('+') || '(none)'
  const spec = normalizeName(q.item.spec ?? '') || '(default)'
  return `${comp}|qty=${q.item.qty}|spec=${spec}`
}

/** 组内是否全部互为"同一顿饭"（含门店/商品/组成/数量/规格）。 */
function groupComparable(quotes: Quote[]): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = []
  for (const q of quotes) {
    if ((q.deviatedConditions?.length ?? 0) > 0) reasons.push(`${q.platform} 偏离快照条件`)
  }
  for (let i = 0; i < quotes.length; i++) {
    const qi = quotes[i]
    if (!qi) continue
    for (let j = i + 1; j < quotes.length; j++) {
      const qj = quotes[j]
      if (!qj) continue
      const r = isSameMeal(qi, qj)
      if (!r.same) reasons.push(`${qi.platform} vs ${qj.platform}: ${r.reasons.join(', ')}`)
    }
  }
  return { comparable: reasons.length === 0, reasons }
}

export interface CompareOptions {
  taskId: string
  /** 当前时间（毫秒或 Date），用于证据过期判断。 */
  now: number | Date
}

/** 比价：分组 + 组内可比 + 选出可信 cheapest（§6.2 兜底）。 */
export function compare(
  quotes: Quote[],
  conditions: ComparisonConditions,
  opts: CompareOptions,
): CompareResult {
  const note: string[] = []
  const byKey = new Map<string, Quote[]>()
  for (const q of quotes) {
    const k = mealKey(q)
    const arr = byKey.get(k)
    if (arr) arr.push(q)
    else byKey.set(k, [q])
  }

  const groups = [...byKey.entries()].map(([key, qs]) => {
    const c = groupComparable(qs)
    if (!c.comparable) note.push(`组「${key}」不可比：${c.reasons.join('；')}`)
    return { key, comparable: c.comparable, quotes: qs }
  })

  // cheapest 只在"单一可比组"内取最小，绝不跨组混排（§6.2 兜底 / §6.4）。
  const comparableGroups = groups.filter((g) => g.comparable)
  const priceOf = (q: Quote) => q.effectivePrice ?? q.payable

  let cheapest: Quote | null = null
  if (comparableGroups.length === 1) {
    const g = comparableGroups[0]
    const candidates = (g?.quotes ?? []).filter(
      (q) => !q.needsConfirm && !isExpired(q.evidence, opts.now),
    )
    for (const q of candidates) {
      if (!cheapest || priceOf(q) < priceOf(cheapest)) cheapest = q
    }
    if (!cheapest) {
      if (g && g.quotes.length && g.quotes.every((q) => q.needsConfirm))
        note.push('无可信结果，请人工核对')
      else if (g && g.quotes.length && g.quotes.every((q) => isExpired(q.evidence, opts.now)))
        note.push('证据已过期，请重新核价')
      else note.push('无可信且未过期的报价，请人工核对')
    }
  } else if (comparableGroups.length > 1) {
    note.push(
      '存在多个不可合并的菜品组（门店/规格/套餐不同），已分组列出，请按组选择；不做跨组最低价',
    )
  } else {
    note.push('没有可比的组（商品/门店不等价），请人工核对')
  }

  return { taskId: opts.taskId, query: conditions, groups, cheapest, note }
}
