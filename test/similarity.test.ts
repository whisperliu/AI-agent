/**
 * similarity.test.ts — 相似度与"同一顿饭"（docs/module-spec.md §6.4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSameMeal, itemScore, normalizeName, storeScore } from '../src/price/similarity.ts'

const store = (over = {}) => ({ name: '香叶烤鸭', amapId: 'AMAP-1', matchedScore: 0.95, ...over })
const item = (over = {}) => ({
  name: '香叶·精品烤鸭饭',
  spec: '大份',
  qty: 1,
  matchedScore: 0.95,
  composition: ['烤鸭饭'],
  ...over,
})

test('normalize strips bracket content and punctuation', () => {
  assert.equal(normalizeName('香叶烤鸭饭（送可乐）'), '香叶烤鸭饭')
  assert.equal(normalizeName('A-B_C  x'), 'a b c x')
})

test('itemScore: same dish name variants score high', () => {
  assert.ok(itemScore('香叶·精品烤鸭饭', '香叶烤鸭饭') >= 0.7)
})

test('storeScore: same amapId => 1; different amapId => low', () => {
  assert.equal(storeScore(store(), store()), 1)
  assert.ok(storeScore(store({ amapId: 'X' }), store({ amapId: 'Y' })) < 0.7)
})

test('isSameMeal: identical => same', () => {
  const r = isSameMeal({ store: store(), item: item() }, { store: store(), item: item() })
  assert.equal(r.same, true, r.reasons.join(','))
})

test('isSameMeal: 烤鸭饭 vs 烤鸭饭+可乐 => NOT same (composition differs)', () => {
  const r = isSameMeal(
    { store: store(), item: item() },
    { store: store(), item: item({ name: '香叶烤鸭饭套餐', composition: ['烤鸭饭', '可乐'] }) },
  )
  assert.equal(r.same, false)
  assert.match(r.reasons.join(','), /composition/)
})

test('isSameMeal: different qty => NOT same', () => {
  const r = isSameMeal({ store: store(), item: item() }, { store: store(), item: item({ qty: 2 }) })
  assert.equal(r.same, false)
})
