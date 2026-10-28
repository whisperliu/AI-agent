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

test('分组结果带统一输入快照 id（双平台对比可追溯，§6.6）', async () => {
  const { compare } = await import('../src/price/engine.ts')
  const cond = {
    snapshotId: 'snap-abc123',
    item: '小炒肉木桶饭',
    qty: 1,
    spec: [],
    composition: [],
    deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
    fixedAt: '2026-10-27T00:00:00+08:00',
    hash: 'h-abc123',
  }
  // 无 quotes 时 groups 为空属正常；这里验证有 quote 时组带 snapshotId
  const quotes = (await import('../src/price/engine.ts')).priceQuote({
    platform: 'meituan',
    store: { name: '江西小炒', matchedScore: 1 },
    item: { name: '小炒肉木桶饭', qty: 1, matchedScore: 1 },
    fees: [{ kind: 'goods', label: '商品', amount: 20, source: 'tree' }],
    discounts: [],
    payable: 20,
    snapshotId: cond.snapshotId,
    snapshotHash: cond.hash,
    extraction: { confidence: 'high', byField: { payable: 'tree' } },
    evidence: {
      quoteId: 'q1',
      platform: 'meituan',
      storeName: '江西小炒',
      itemSpec: '小炒肉木桶饭 x1',
      qty: 1,
      feeBreakdown: [],
      rawExtraction: { treeDumpPath: '/tmp/x.xml' },
      capturedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      redaction: 'applied',
    },
  })
  const r2 = compare([quotes], cond, { taskId: 't2', now: Date.now() })
  assert.equal(r2.groups.length, 1)
  assert.equal(r2.groups[0]?.snapshotId, 'snap-abc123')
})

/** 构造"低可信"草稿：费用全来自 OCR → 置信度被压到 medium → needsConfirm=true（账仍平）。 */
function ocrDraft(over: Partial<QuoteDraft> = {}): QuoteDraft {
  return draft({
    fees: [
      { kind: 'goods', label: '商品', amount: 28.9, source: 'ocr' },
      { kind: 'delivery', label: '配送费', amount: 2, source: 'ocr' },
      { kind: 'packing', label: '打包费', amount: 1, source: 'ocr' },
    ],
    ...over,
  })
}

test('compare: 组内全部 needsConfirm → cheapest=null + 「无可信结果」提示', () => {
  const m = priceQuote(ocrDraft({ platform: 'meituan' }))
  const e = priceQuote(ocrDraft({ platform: 'eleme' }))
  const r = compare([m, e], cond(), { taskId: 't-nc', now: NOW })
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0]?.comparable, true)
  assert.equal(r.cheapest, null)
  assert.match(r.note.join('\n'), /无可信结果/)
})

test('compare: 组内全部过期 → cheapest=null + 「证据已过期」提示', () => {
  const past = { validUntil: '2026-10-22T11:00:00+08:00' } // NOW 之前 → 过期
  const m = priceQuote(draft({ platform: 'meituan', evidence: evidence(past) }))
  const e = priceQuote(draft({ platform: 'eleme', evidence: evidence(past) }))
  const r = compare([m, e], cond(), { taskId: 't-exp', now: NOW })
  assert.equal(r.groups[0]?.comparable, true)
  assert.equal(r.cheapest, null)
  assert.match(r.note.join('\n'), /证据已过期/)
})

test('compare: 既非全 needsConfirm 也非全过期（混合）→ 「无可信且未过期」提示', () => {
  // A：OCR → needsConfirm 但证据新鲜；B：树可信但证据过期。
  const a = priceQuote(ocrDraft({ platform: 'meituan' }))
  const b = priceQuote(
    draft({ platform: 'eleme', evidence: evidence({ validUntil: '2026-10-22T11:00:00+08:00' }) }),
  )
  const r = compare([a, b], cond(), { taskId: 't-mix', now: NOW })
  assert.equal(r.cheapest, null)
  const note = r.note.join('\n')
  assert.match(note, /无可信且未过期/)
  assert.doesNotMatch(note, /无可信结果/)
  assert.doesNotMatch(note, /证据已过期，请重新核价/)
})

test('priceQuote: 拆条优惠(refundedBy) 只扣主条 —— effectivePrice 不被压成幻影低价', () => {
  // 同一笔招行立减被拆成两条展示：主条 10 + 从条 10(refundedBy=主条)。
  // 旧实现会扣 20 → effectivePrice=6.9（远低于真实到手价），是"静默低报"。
  const q = priceQuote(
    draft({
      payable: 26.9,
      optionalSavings: [
        verifiedSaving({ id: 'cmb', amount: 10 }),
        verifiedSaving({ id: 'cmb-sub', amount: 10, refundedBy: 'cmb' }),
      ],
    }),
  )
  assert.equal(q.payable, 26.9)
  assert.equal(q.effectivePrice, 16.9) // 只扣一次 10
})

// ───────────────── 2026-10-28：双平台同菜（真机形态）→ 合为同一可比组 ─────────────────
test('双平台同店同菜、规格表述差异（美团"1人份，微辣" vs 饿了么"微辣"）→ 同一可比组', () => {
  const mk = (
    platform: string,
    spec: string,
    payable: number,
    fees: QuoteDraft['fees'],
    discounts: QuoteDraft['discounts'],
    conf: 'high' | 'medium',
  ) =>
    priceQuote(
      draft({
        platform,
        store: { name: '江西小炒(盛夏路店)', matchedScore: 1 },
        item: { name: '小炒肉木桶饭', spec, qty: 1, matchedScore: 1 },
        fees,
        discounts,
        payable,
        extraction: { confidence: conf, byField: { payable: conf === 'high' ? 'tree' : 'ocr' } },
      }),
    )
  const m = mk(
    'meituan',
    '1 人份，微辣',
    29.88,
    [
      { kind: 'goods', label: '商品原价', amount: 28.88, source: 'tree' },
      { kind: 'delivery', label: '配送费', amount: 3.9, source: 'tree' },
      { kind: 'packing', label: '打包费', amount: 2, source: 'tree' },
    ],
    [
      {
        kind: 'delivery_waiver',
        platform: 'meituan',
        id: 'd',
        name: '减配送费',
        amount: 3.9,
        scope: 'delivery',
        source: 'tree',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      },
      {
        kind: 'promo',
        platform: 'meituan',
        id: 'p',
        name: '满减',
        amount: 1,
        scope: 'order',
        source: 'tree',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      },
    ],
    'high',
  )
  const e = mk(
    'eleme',
    '微辣',
    9.88,
    [
      { kind: 'goods', label: '商品金额', amount: 7.88, source: 'ocr' },
      { kind: 'packing', label: '打包费', amount: 2, source: 'ocr' },
      { kind: 'delivery', label: '配送费', amount: 3.9, source: 'ocr' },
    ],
    [
      {
        kind: 'delivery_waiver',
        platform: 'eleme',
        id: 'd2',
        name: '免配送费',
        amount: 3.9,
        scope: 'delivery',
        source: 'ocr',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      },
    ],
    'medium',
  )
  const r = compare([m, e], cond(), { taskId: 't-dual', now: NOW })
  assert.equal(r.groups.length, 1, '两平台同菜应合为一组')
  assert.equal(r.groups[0]?.comparable, true, r.groups[0]?.quotes && JSON.stringify(r.note))
  assert.equal(r.groups[0]?.quotes.length, 2)
  // 饿了么 OCR medium → needsConfirm=true，不作为"可信最低价"；美团 high 被选为可信最低价
  assert.equal(r.cheapest?.platform, 'meituan')
  // 组内两条价都展示：饿了么 ¥9.88（更便宜但需复核）／美团 ¥29.88
  const effs = r.groups[0]!.quotes.map((q) => `${q.platform}:${q.effectivePrice}`).sort()
  assert.deepEqual(effs, ['eleme:9.88', 'meituan:29.88'])
})
