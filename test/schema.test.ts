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
