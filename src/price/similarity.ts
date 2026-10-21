/**
 * price/similarity.ts — 相似度与"同一顿饭"等价判定（docs/module-spec.md §6.4）。
 * 层：pure。无 IO。
 */

import type { Item, Store } from './model.ts'

const CJK = /[\u3400-\u9fff]/

/** 归一化：小写、去括号内容、非字母数字中文转空格。 */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, ' ') // 去括号内容（中/英括号）；"[" 置于字符类首无需转义
    .replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 切成 token 集合：中文按单字，其他按整词。 */
export function tokenSet(input: string): Set<string> {
  const norm = normalizeName(input)
  const out = new Set<string>()
  for (const part of norm.split(' ')) {
    if (!part) continue
    if (CJK.test(part)) {
      for (const ch of part) out.add(ch)
    } else {
      out.add(part)
    }
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 商品名相似度 0–1：token Jaccard + 主体词（较短者全含）加成。 */
export function itemScore(a: string, b: string): number {
  const ta = tokenSet(a)
  const tb = tokenSet(b)
  let score = jaccard(ta, tb)
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  if (small.size > 0) {
    let all = true
    for (const x of small) if (!large.has(x)) all = false
    if (all) score = Math.max(score, 0.9)
  }
  return clamp01(score)
}

/** 门店相似度 0–1：amapId 精确=1；冲突=0.2；否则名称 Jaccard(+ 近距离加成)。 */
export function storeScore(a: Store, b: Store): number {
  if (a.amapId && b.amapId) {
    if (a.amapId === b.amapId) return 1
    return 0.2
  }
  let score = jaccard(tokenSet(a.name), tokenSet(b.name))
  if (a.distanceM !== undefined && b.distanceM !== undefined) {
    if (Math.max(a.distanceM, b.distanceM) - Math.min(a.distanceM, b.distanceM) < 200) {
      score = Math.min(1, score + 0.1)
    }
  }
  return clamp01(score)
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

export interface MealLike {
  store: Store
  item: Item
}

export interface SameMealResult {
  same: boolean
  reasons: string[]
}

/**
 * 判定两份报价是否为"同一顿饭"：门店/商品相似度 + 套餐组成 + 数量 + 规格一致。
 * 任一不满足 → same=false 并给出原因（供分组与提示）。
 */
export function isSameMeal(a: MealLike, b: MealLike): SameMealResult {
  const reasons: string[] = []
  if (storeScore(a.store, b.store) < 0.7) reasons.push('store differs')
  if (itemScore(a.item.name, b.item.name) < 0.7) reasons.push('item name differs')
  const ca = [...(a.item.composition ?? [])].map(normalizeName).sort().join('+')
  const cb = [...(b.item.composition ?? [])].map(normalizeName).sort().join('+')
  if (ca !== cb) reasons.push('composition differs')
  if (a.item.qty !== b.item.qty) reasons.push('qty differs')
  if (normalizeName(a.item.spec ?? '') !== normalizeName(b.item.spec ?? '')) {
    reasons.push('spec differs')
  }
  return { same: reasons.length === 0, reasons }
}
