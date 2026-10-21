/**
 * pricing.engine.test.ts — 折算引擎核心场景（docs/module-spec.md §5.3/§5.4、§6.3、§6.4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess, compare, priceQuote } from '../src/price/engine.ts'
import { draft, evidence, cond, NOW } from './helpers.ts'
import type { OptionalSaving, QuoteDraft } from '../src/price/model.ts'

function verifiedSaving(over: Partial<OptionalSaving> = {}): OptionalSaving {
  return {
    kind: 'credit_card',
    platform: 'meituan',
    id: 'cmb',
    name: '招行周三满50减10',
    amount: 10,
    scope: 'order',
    source: 'tree',
    autoApplied: false,
    alreadyIncludedInPayable: false,
    availability: 'verified',
    sourceOfTruth: 'settle_screenshot',
    ...over,
  }
}

test('baseline: arithmetic balanced + all tree => high, no confirm', () => {
  const a = assess(draft())
  assert.equal(a.arithmetic.balanced, true)
  assert.equal(a.arithmetic.expected, 26.9)
  assert.equal(a.arithmetic.delta, 0)
  assert.equal(a.extraction.confidence, 'high')
  assert.equal(a.needsConfirm, false)
})

test('¥28.9 read as ¥289 => arithmetic unbalanced + needsConfirm', () => {
  const d = draft({
    fees: [
      { kind: 'goods', label: '商品', amount: 289, source: 'tree' }, // OCR decimal slip
      { kind: 'delivery', label: '配送费', amount: 2, source: 'tree' },
      { kind: 'packing', label: '打包费', amount: 1, source: 'tree' },
    ],
    discounts: [],
    payable: 26.9,
  })
  const a = assess(d)
  assert.equal(a.arithmetic.balanced, false)
  assert.equal(a.needsConfirm, true)
})

test('double-error that still balances => confidence capped at medium (needsConfirm)', () => {
  // goods 28.9 & payable 31.9 both from OCR; no discounts -> delta 0 (balanced) but OCR
  const d = draft({
    fees: [
      { kind: 'goods', label: '商品', amount: 28.9, source: 'ocr' },
      { kind: 'delivery', label: '配送费', amount: 2, source: 'ocr' },
      { kind: 'packing', label: '打包费', amount: 1, source: 'ocr' },
    ],
    discounts: [],
    payable: 31.9,
    extraction: { confidence: 'high', byField: { payable: 'ocr' } }, // caller claims high
  })
  const a = assess(d)
  assert.equal(a.arithmetic.balanced, true) // 账平
  assert.equal(a.extraction.confidence, 'medium') // 但不是 high
  assert.equal(a.needsConfirm, true) // 双错平账要复核
})

test('effectivePrice only subtracts verified + not-already-included savings', () => {
  const q = priceQuote(draft({ optionalSavings: [verifiedSaving()] }))
  assert.equal(q.payable, 26.9)
  assert.equal(q.effectivePrice, 16.9)
})

test('presumed saving does NOT reduce effectivePrice (no phantom discount)', () => {
  const presumed = verifiedSaving({ availability: 'presumed', sourceOfTruth: 'local_ledger' })
  const q = priceQuote(draft({ optionalSavings: [presumed] }))
  assert.equal(q.effectivePrice, 26.9)
})

test('verified but alreadyIncluded saving is NOT subtracted again (no double count)', () => {
  const q = priceQuote(
    draft({ optionalSavings: [verifiedSaving({ alreadyIncludedInPayable: true })] }),
  )
  assert.equal(q.effectivePrice, 26.9)
})

test('missing evidence forces low confidence + needsConfirm', () => {
  const d = draft({
    evidence: evidence({ rawExtraction: {}, screenshotPath: undefined }),
  })
  const a = assess(d)
  assert.equal(a.extraction.confidence, 'low')
  assert.equal(a.needsConfirm, true)
})

test('compare: same meal groups, picks cheapest by effectivePrice', () => {
  const m = priceQuote(
    draft({
      platform: 'meituan',
      payable: 26.9,
      optionalSavings: [verifiedSaving({ amount: 10 })],
    }),
  )
  const e = priceQuote(
    draft({
      platform: 'eleme',
      store: { name: '香叶烤鸭', amapId: 'AMAP-1', matchedScore: 0.95 },
      item: {
        name: '香叶烤鸭饭',
        spec: '大份',
        qty: 1,
        matchedScore: 0.95,
        composition: ['烤鸭饭'],
      },
      payable: 26.9,
      discounts: [
        {
          kind: 'coupon',
          platform: 'eleme',
          id: 'e-coupon',
          name: '满30减5',
          amount: 5,
          scope: 'order',
          source: 'tree',
          autoApplied: true,
          alreadyIncludedInPayable: true,
        },
      ],
    }),
  )
  const r = compare([m, e], cond(), { taskId: 't1', now: NOW })
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0]?.comparable, true)
  // meituan effective 16.9 < eleme 25.5 -> cheapest = meituan
  assert.equal(r.cheapest?.platform, 'meituan')
})

test('compare: non-equivalent items go to separate non-comparable groups (no mixing)', () => {
  const plain = priceQuote(draft({ platform: 'meituan', payable: 31.9, discounts: [] }))
  const combo = priceQuote(
    draft({
      platform: 'eleme',
      item: {
        name: '香叶烤鸭饭套餐',
        spec: '大份',
        qty: 1,
        matchedScore: 0.95,
        composition: ['烤鸭饭', '可乐'],
      },
      payable: 34.9,
      discounts: [],
      fees: [
        { kind: 'goods', label: '商品', amount: 31.9, source: 'tree' },
        { kind: 'delivery', label: '配送费', amount: 2, source: 'tree' },
        { kind: 'packing', label: '打包费', amount: 1, source: 'tree' },
      ],
    }),
  )
  const r = compare([plain, combo], cond(), { taskId: 't2', now: NOW })
  assert.equal(r.groups.length, 2) // 不同套餐 -> 不同组
  assert.equal(r.cheapest, null) // 无可比组（每组仅 1 个且组间不可比）
  assert.match(r.note.join('\n'), /不可合并|按组选择|人工核对/)
})

test('compare: expired evidence is excluded from cheapest', () => {
  const fresh = priceQuote(draft({ platform: 'meituan', payable: 31.9, discounts: [] }))
  const stale = priceQuote(
    draft({
      platform: 'eleme',
      item: {
        name: '香叶烤鸭饭',
        spec: '大份',
        qty: 1,
        matchedScore: 0.95,
        composition: ['烤鸭饭'],
      },
      store: { name: '香叶烤鸭', amapId: 'AMAP-1', matchedScore: 0.95 },
      payable: 18.0,
      discounts: [],
      fees: [
        { kind: 'goods', label: '商品', amount: 15, source: 'tree' },
        { kind: 'delivery', label: '配送费', amount: 2, source: 'tree' },
        { kind: 'packing', label: '打包费', amount: 1, source: 'tree' },
      ],
      evidence: evidence({ platform: 'eleme', validUntil: '2026-10-22T11:00:00+08:00' }), // 已过期
    }),
  )
  const r = compare([fresh, stale], cond(), { taskId: 't3', now: NOW })
  assert.equal(r.cheapest?.platform, 'meituan') // 过期更便宜的不能当选
})

test('compare: deviated conditions force non-comparable group', () => {
  const d: QuoteDraft = {
    ...draft(),
    deviatedConditions: ['qty: 想要 1 份，平台只有 2 份装'],
  }
  const q1 = priceQuote(d)
  const q2 = priceQuote(draft({ platform: 'eleme', payable: 31.9, discounts: [] }))
  const r = compare([q1, q2], cond(), { taskId: 't4', now: NOW })
  const g = r.groups.find((x) => x.quotes.some((q) => q.platform === 'meituan'))
  assert.equal(g?.comparable, false)
})
