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

test('itemScore: Chinese names tokenize per-char; latin names per-word', () => {
  // 纯中文：按单字切分 → "烤鸭饭" 与 "鸭饭" 有较高重叠
  assert.ok(itemScore('烤鸭饭', '鸭饭') > 0)
  // 纯拉丁：按整词切分 → 完全不同词 → 0
  assert.equal(itemScore('pizza', 'burger'), 0)
  assert.equal(itemScore('pepsi cola', 'pepsi cola'), 1)
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

test('isSameMeal: different spec => NOT same (spec differs)', () => {
  const r = isSameMeal(
    { store: store(), item: item() },
    { store: store(), item: item({ spec: '小份' }) },
  )
  assert.equal(r.same, false)
  assert.match(r.reasons.join(','), /spec differs/)
})

test('storeScore: no amapId on either side falls back to name Jaccard', () => {
  const s = storeScore(
    { name: '香叶烤鸭', matchedScore: 0.9 },
    { name: '香叶烤鸭', matchedScore: 0.9 },
  )
  assert.equal(s, 1) // 完全相同名称 → Jaccard 1
  const s2 = storeScore(
    { name: '香叶烤鸭', matchedScore: 0.5 },
    { name: '沙县小吃', matchedScore: 0.5 },
  )
  assert.ok(s2 < 0.7) // 不同店名 → 低分（不可比）
})

test('storeScore: close distance (<200m) adds a small bonus on the name score', () => {
  const base = storeScore(
    { name: '香叶烤鸭', matchedScore: 0.9 },
    { name: '香叶烤鸭坊', matchedScore: 0.9 }, // 名称相近但非完全相同
  )
  const boosted = storeScore(
    { name: '香叶烤鸭', distanceM: 500, matchedScore: 0.9 },
    { name: '香叶烤鸭坊', distanceM: 620, matchedScore: 0.9 }, // 相差 120m < 200 → +0.1
  )
  assert.ok(boosted > base)
  assert.ok(boosted <= 1)
})

test('storeScore: distance >=200m gives NO bonus', () => {
  const far = storeScore(
    { name: '香叶烤鸭', distanceM: 500, matchedScore: 0.9 },
    { name: '香叶烤鸭坊', distanceM: 900, matchedScore: 0.9 }, // 相差 400m
  )
  const nameOnly = storeScore(
    { name: '香叶烤鸭', matchedScore: 0.9 },
    { name: '香叶烤鸭坊', matchedScore: 0.9 },
  )
  assert.equal(far, nameOnly)
})
