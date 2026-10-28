/**
 * schema.test.ts — 两层校验与 zod 用法（docs/module-spec.md §6.3.2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceQuote } from '../src/price/engine.ts'
import {
  expectedPayable,
  deductibleSavings,
  QuoteSchema,
  safeValidateQuote,
  validateQuote,
} from '../src/price/schema.ts'
import { draft } from './helpers.ts'

test('priceQuote output satisfies QuoteSchema', () => {
  const q = priceQuote(draft())
  const r = safeValidateQuote(q)
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues))
})

test('derived fee lines are excluded from arithmetic', () => {
  const exp = expectedPayable({
    fees: [
      { amount: 30, source: 'tree' },
      { amount: 999, source: 'derived' }, // must be ignored
    ],
    discounts: [],
  })
  assert.equal(exp, 30)
})

test('rejects a Quote missing required store/evidence', () => {
  const q = priceQuote(draft()) as unknown as Record<string, unknown>
  const noStore = { ...q }
  delete noStore.store
  assert.equal(safeValidateQuote(noStore).success, false)
})

test('schema catches a lying arithmetic.balanced flag', () => {
  const q = priceQuote(draft())
  const bad = { ...q, arithmetic: { ...q.arithmetic, balanced: !q.arithmetic.balanced } }
  const r = safeValidateQuote(bad)
  assert.equal(r.success, false)
  assert.match(JSON.stringify(r.error?.issues), /balanced/)
})

test('schema catches effectivePrice double-count (verified but alreadyIncluded)', () => {
  const q = priceQuote(
    draft({
      // verified saving that is ALREADY inside payable -> must NOT be subtracted
      optionalSavings: [
        {
          kind: 'credit_card',
          platform: 'meituan',
          id: 'cmb',
          name: '招行立减',
          amount: 10,
          scope: 'order',
          source: 'tree',
          autoApplied: false,
          alreadyIncludedInPayable: true,
          availability: 'verified',
          sourceOfTruth: 'settle_screenshot',
        },
      ],
    }),
  )
  // priceQuote correctly keeps effectivePrice = payable
  assert.equal(q.effectivePrice, q.payable)
  // now forge a wrong (double counted) effectivePrice
  const forged = { ...q, effectivePrice: q.payable - 10 }
  assert.equal(safeValidateQuote(forged).success, false)
})

test('deductibleSavings only counts verified + not-included + settle_screenshot', () => {
  assert.equal(
    deductibleSavings([
      {
        amount: 10,
        availability: 'verified',
        sourceOfTruth: 'settle_screenshot',
        alreadyIncludedInPayable: false,
      },
      {
        amount: 5,
        availability: 'presumed',
        sourceOfTruth: 'local_ledger',
        alreadyIncludedInPayable: false,
      },
      {
        amount: 7,
        availability: 'verified',
        sourceOfTruth: 'settle_screenshot',
        alreadyIncludedInPayable: true,
      },
    ]),
    10,
  )
})

test('QuoteSchema is exported and parses directly', () => {
  assert.equal(typeof QuoteSchema.parse, 'function')
})

test('deductibleSavings: refundedBy 拆条只计主条，防止重复计数（真·防虚低价）', () => {
  // 同一笔招行立减被 App 拆成两条展示：主条 cmb(10) + 从条 cmb-sub(10, refundedBy=cmb)。
  // 若不识别 refundedBy，会重复扣 20 → effectivePrice 被压到低于实际（幻影优惠）。
  const handled = deductibleSavings([
    {
      id: 'cmb',
      amount: 10,
      availability: 'verified',
      sourceOfTruth: 'settle_screenshot',
      alreadyIncludedInPayable: false,
    },
    {
      id: 'cmb-sub',
      amount: 10,
      availability: 'verified',
      sourceOfTruth: 'settle_screenshot',
      alreadyIncludedInPayable: false,
      refundedBy: 'cmb', // 从条：指向主优惠，不得重复计数
    },
  ])
  assert.equal(handled, 10)
})

test('deductibleSavings: refundedBy 指向不在列表里时仍保守计入该条（不静默丢优惠）', () => {
  const total = deductibleSavings([
    {
      id: 'x-sub',
      amount: 6,
      availability: 'verified',
      sourceOfTruth: 'settle_screenshot',
      alreadyIncludedInPayable: false,
      refundedBy: 'missing-master',
    },
  ])
  assert.equal(total, 6)
})

test('validateQuote throws ZodError on an invalid quote (strict entrypoint)', () => {
  assert.throws(() => validateQuote({ platform: 'meituan' }), /invalid|required|expected/i)
})

test('schema catches a lying arithmetic.expected (self-reported mismatch)', () => {
  const q = priceQuote(draft())
  const bad = { ...q, arithmetic: { ...q.arithmetic, expected: q.arithmetic.expected + 5 } }
  const r = safeValidateQuote(bad)
  assert.equal(r.success, false)
  assert.match(JSON.stringify(r.error?.issues), /arithmetic\.expected/)
})
