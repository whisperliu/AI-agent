/**
 * platform-p4.test.ts — P4「多平台 + 策略 + 等价分组」离线验收（对应 docs/tasks.md P4 DoD ①–④）。
 * 覆盖：
 *  ① 两平台从**同一 snapshotId/hash** 派生（compare 输出 query 唯一；每 Quote 带 snapshotHash）；
 *  ② 条件偏离（snapshot 不一致 / qty 偏离）的 Quote → 强制归入不可比组；
 *  ③ effectivePrice 双口径正确、无重复扣（autoApplied 已含不重复扣；verified 未含才扣）；
 *  ④ 跨平台默认不互斥（同卡跨平台均可用），仅显式 crossPlatformExclusive 才降级。
 *  另：饿了么真机结算页抽取（id/坐标行双路径）→ balanced。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compare, priceQuote } from '../src/price/engine.ts'
import {
  applyCrossPlatformExclusivity,
  evaluateStrategy,
  evaluateStrategies,
  strategyAmount,
  weekdayInShanghai,
} from '../src/price/strategies.ts'
import type { StrategySpec } from '../src/price/strategies.ts'
import { extractElemeSettleFromDump } from '../src/platform/elemeReal.ts'
import { draft, cond, NOW } from './helpers.ts'
import type { QuoteDraft } from '../src/price/model.ts'

const FIX = join(import.meta.dirname, 'fixtures')

// ─────────────────────────────── 策略四态（§5.4/§5.5） ───────────────────────────────

const WED = Date.parse('2026-10-21T12:00:00+08:00') // 2026-10-21 是周三
const THU = Date.parse('2026-10-22T12:00:00+08:00') // 2026-10-22 是周四

function cmb(over: Partial<StrategySpec> = {}): StrategySpec {
  return {
    id: 'cmb-wednesday',
    kind: 'credit_card',
    name: '招商银行 周三满50减10',
    condition: { minSpend: 50, weekday: 'wednesday' },
    discount: { type: 'fixed', amount: 10 },
    autoApplied: false,
    quota: { dailyLimit: 1, monthlyLimit: 4, totalQuota: null, lastUsedAt: null },
    exclusiveGroup: 'meituan-pay-activity',
    crossPlatformExclusive: false,
    ...over,
  }
}

test('weekdayInShanghai: 2026-10-21 is wednesday; 2026-10-22 is thursday', () => {
  assert.equal(weekdayInShanghai(WED), 'wednesday')
  assert.equal(weekdayInShanghai(THU), 'thursday')
})

test('strategyAmount: fixed and percent(cap)', () => {
  assert.equal(strategyAmount(cmb(), 60), 10)
  assert.equal(strategyAmount(cmb({ discount: { type: 'percent', amount: 10 } }), 60), 6)
  assert.equal(strategyAmount(cmb({ discount: { type: 'percent', amount: 10, cap: 4 } }), 60), 4)
})

test('strategy on right weekday + met threshold => presumed (NOT verified; never asserts usable)', () => {
  const s = evaluateStrategy(cmb(), { platform: 'meituan', payable: 60, now: WED })
  assert.equal(s.availability, 'presumed')
  assert.equal(s.sourceOfTruth, 'platform_config')
  assert.equal(s.alreadyIncludedInPayable, false)
})

test('strategy on wrong weekday => known_unavailable (excluded, not "usable")', () => {
  const s = evaluateStrategy(cmb(), { platform: 'meituan', payable: 60, now: THU })
  assert.equal(s.availability, 'known_unavailable')
  assert.match(s.availabilityReason ?? '', /非活动日/)
})

test('strategy below minSpend => known_unavailable', () => {
  const s = evaluateStrategy(cmb({ condition: { minSpend: 50 } }), {
    platform: 'meituan',
    payable: 30,
    now: WED,
  })
  assert.equal(s.availability, 'known_unavailable')
  assert.match(s.availabilityReason ?? '', /未达门槛/)
})

test('strategy used today (local ledger) => known_unavailable (only downgrade)', () => {
  const s = evaluateStrategy(
    cmb({
      quota: {
        dailyLimit: 1,
        monthlyLimit: 4,
        totalQuota: null,
        lastUsedAt: '2026-10-21T09:00:00+08:00',
      },
    }),
    { platform: 'meituan', payable: 60, now: WED },
  )
  assert.equal(s.availability, 'known_unavailable')
  assert.match(s.availabilityReason ?? '', /今日已用/)
})

test('autoApplied strategy => presumed but alreadyIncludedInPayable=true (no double count)', () => {
  const spec = cmb({
    id: 'shenquan',
    kind: 'membership',
    autoApplied: true,
    condition: { minSpend: 30 },
  })
  const s = evaluateStrategy(spec, { platform: 'meituan', payable: 60, now: WED })
  assert.equal(s.alreadyIncludedInPayable, true)
})

// ─────────────────────── 跨平台谨慎互斥（§5.6） ───────────────────────

test('cross-platform DEFAULT not exclusive: same card usable on both platforms', () => {
  const mSpecs = [cmb({ id: 'm-cmb', exclusiveGroup: 'meituan-pay-activity' })]
  const eSpecs = [cmb({ id: 'e-cmb', exclusiveGroup: 'eleme-pay-activity' })]
  const m = {
    platform: 'meituan',
    specs: mSpecs,
    savings: evaluateStrategies(mSpecs, { platform: 'meituan', payable: 60, now: WED }),
  }
  // 模拟美团侧已被"verified 使用"（真实场景：结算页实证；这里直接改状态以测互斥逻辑）
  m.savings[0]!.availability = 'verified'
  const e = {
    platform: 'eleme',
    specs: eSpecs,
    savings: evaluateStrategies(eSpecs, { platform: 'eleme', payable: 60, now: WED }),
  }

  const downgraded = applyCrossPlatformExclusivity([m, e])
  assert.equal(downgraded.length, 0, '默认不互斥：不应降级')
  assert.equal(e.savings[0]!.availability, 'presumed')
})

test('cross-platform EXPLICIT exclusive: verified use on one platform downgrades the other', () => {
  const mSpecs = [cmb({ id: 'm-cmb', crossPlatformExclusive: true })]
  const eSpecs = [cmb({ id: 'e-cmb', crossPlatformExclusive: true })]
  const m = {
    platform: 'meituan',
    specs: mSpecs,
    savings: evaluateStrategies(mSpecs, { platform: 'meituan', payable: 60, now: WED }),
  }
  m.savings[0]!.availability = 'verified'
  const e = {
    platform: 'eleme',
    specs: eSpecs,
    savings: evaluateStrategies(eSpecs, { platform: 'eleme', payable: 60, now: WED }),
  }

  const downgraded = applyCrossPlatformExclusivity([m, e])
  assert.deepEqual(downgraded, ['e-cmb'])
  assert.equal(e.savings[0]!.availability, 'known_unavailable')
  assert.match(e.savings[0]!.availabilityReason ?? '', /跨平台互斥/)
})

// ───────────────────── ② 快照一致性 + 偏离条件归不可比组（§6.6） ─────────────────────

function draftOn(
  platform: string,
  snapshotHash: string,
  over: Partial<QuoteDraft> = {},
): QuoteDraft {
  return draft({
    platform,
    snapshotId: `snap-${snapshotHash.slice(0, 6)}`,
    snapshotHash,
    ...over,
  })
}

test('① 两平台派生自同一 snapshotId/hash：compare query 唯一，quote 携带 snapshotHash', () => {
  const c = cond({ snapshotId: 'snap-1', hash: 'hash-1' })
  const m = priceQuote(draftOn('meituan', 'hash-1'))
  const e = priceQuote(draftOn('eleme', 'hash-1'))
  assert.equal(m.snapshotHash, 'hash-1')
  assert.equal(e.snapshotHash, 'hash-1')
  const r = compare([m, e], c, { taskId: 't', now: NOW })
  assert.equal(r.query.snapshotId, 'snap-1')
  assert.equal(r.query.hash, 'hash-1')
})

test('② snapshot 不一致的 Quote → 强制不可比（即使其它字段等价）', () => {
  const c = cond({ snapshotId: 'snap-1', hash: 'hash-1' })
  const m = priceQuote(draftOn('meituan', 'hash-1'))
  const eDev = priceQuote(draftOn('eleme', 'hash-DIFFERENT')) // 声称来自别的快照
  const r = compare([m, eDev], c, { taskId: 't', now: NOW })
  assert.ok(eDev.deviatedConditions && eDev.deviatedConditions.length > 0)
  assert.match(eDev.deviatedConditions!.join('|'), /snapshot 不一致/)
  // 含偏离的组不可比
  const devGroup = r.groups.find((g) => g.quotes.some((q) => q.platform === 'eleme'))
  assert.equal(devGroup?.comparable, false)
  assert.equal(r.cheapest, null)
})

// ───────────────────── ③ effectivePrice 双口径、无重复扣 ─────────────────────

test('③ effectivePrice: 只有 verified 且未含的优惠才从 payable 扣（双口径）', () => {
  const verified = {
    kind: 'credit_card' as const,
    platform: 'meituan',
    id: 'cmb',
    name: '招行周三满50减10',
    amount: 10,
    scope: 'order' as const,
    source: 'tree' as const,
    autoApplied: false,
    alreadyIncludedInPayable: false,
    availability: 'verified' as const,
    sourceOfTruth: 'settle_screenshot' as const,
  }
  // payable 26.9；无 verified savings → effective = 26.9
  const q0 = priceQuote(draft())
  assert.equal(q0.payable, 26.9)
  assert.equal(q0.effectivePrice, 26.9)
  // 加一个 verified 未含优惠 → effective = 16.9
  const q1 = priceQuote(draft({ optionalSavings: [verified] }))
  assert.equal(q1.payable, 26.9)
  assert.equal(q1.effectivePrice, 16.9)
  // 同一笔 verified 但已含在实付 → 不再扣（effective 仍 26.9）
  const q2 = priceQuote(
    draft({ optionalSavings: [{ ...verified, alreadyIncludedInPayable: true }] }),
  )
  assert.equal(q2.effectivePrice, 26.9)
})

test('③ 配置 presumed 优惠不计入 effectivePrice（不夸大低价）', () => {
  const presumed = evaluateStrategy(cmb(), { platform: 'meituan', payable: 60, now: WED })
  assert.equal(presumed.availability, 'presumed')
  // 用 60 元的账（goods 60，无优惠）构造，presumed 10 元不应扣
  const q = priceQuote(
    draft({
      fees: [{ kind: 'goods', label: '商品', amount: 60, source: 'tree' }],
      discounts: [],
      payable: 60,
      optionalSavings: [presumed],
    }),
  )
  assert.equal(q.payable, 60)
  assert.equal(q.effectivePrice, 60) // presumed 不扣
})

// ───────────────────── 真机抽取：饿了么结算页（P4 多平台） ─────────────────────

test('eleme extract (real-device, no ids): 坐标/行抽取实付+费用+优惠 → balanced', async () => {
  const xml = await readFile(join(FIX, 'eleme-settle.real-device.xml'), 'utf8')
  const facts = extractElemeSettleFromDump(xml, cond())
  assert.equal(facts.payable, 29)
  assert.equal(facts.qty, 1)
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.goods, 30)
  assert.equal(kinds.delivery, 3)
  assert.equal(kinds.packing, 1)
  // 30 + 3 + 1 - 5 = 29 → balanced
  const quote = priceQuote({
    platform: 'eleme',
    store: { name: facts.storeName, matchedScore: 1 },
    item: { name: facts.itemName, qty: facts.qty, matchedScore: 1, spec: facts.itemSpec },
    fees: facts.fees,
    discounts: facts.discounts,
    payable: facts.payable,
    extraction: { confidence: facts.confidence, byField: facts.byField },
    evidence: {
      quoteId: 'q',
      platform: 'eleme',
      storeName: facts.storeName,
      itemSpec: `${facts.itemName} x${facts.qty}`,
      qty: facts.qty,
      feeBreakdown: facts.fees,
      rawExtraction: { treeDumpPath: '/tmp/e.xml' },
      capturedAt: '2026-10-24T13:00:00+08:00',
      validUntil: '2026-10-24T13:10:00+08:00',
      redaction: 'applied',
    },
  })
  assert.equal(quote.arithmetic.balanced, true)
  assert.equal(quote.effectivePrice, 29)
  assert.equal(quote.needsConfirm, false)
})

test('eleme extract: id path (fee_*/discount_*/payable) works too', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
 <node text="确认订单" resource-id="" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,0][200,50]"/>
 <node text="香叶·精品烤鸭饭" resource-id="me.ele:id/food_name" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,120][500,170]"/>
 <node text="x1" resource-id="me.ele:id/qty" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[900,120][960,170]"/>
 <node text="30.00" resource-id="me.ele:id/fee_goods" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,300][200,340]"/>
 <node text="3.00" resource-id="me.ele:id/fee_delivery" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,350][200,390]"/>
 <node text="1.00" resource-id="me.ele:id/fee_packing" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,400][200,440]"/>
 <node text="红包 -5.00" resource-id="me.ele:id/discount_coupon" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,450][300,490]"/>
 <node text="29.00" resource-id="me.ele:id/payable" class="android.widget.TextView" package="me.ele" clickable="false" bounds="[0,900][200,950]"/>
</hierarchy>`
  const facts = extractElemeSettleFromDump(xml, cond())
  assert.equal(facts.payable, 29)
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.goods, 30)
  assert.equal(kinds.delivery, 3)
  assert.equal(facts.discounts[0]!.amount, 5)
  assert.equal(facts.confidence, 'high')
})

// ───────────────────── 全链路（Mock 双平台）集成 ─────────────────────

import { makeEnv } from './p1-env.ts'
import { startTask, getResult } from '../src/task/lifecycle.ts'
import { selectPlatforms } from '../src/platform/router.ts'

test('full chain (Mock 双平台): 同一快照派生、分组比价、cheapest 取低', async () => {
  const env = await makeEnv()
  try {
    const strategies = selectPlatforms(env.deps.config)
    assert.deepEqual(
      strategies.map((s) => s.id),
      ['eleme', 'meituan'],
    )
    const start = await startTask(env.deps, {
      item: '香叶 烤鸭饭',
      platforms: ['meituan', 'eleme'],
    })
    await env.jobs.settle()
    const got = await getResult(env.deps, start.taskId)
    assert.equal(got.status, 'completed')
    const r = got.result!
    assert.equal(r.groups.length, 1)
    assert.equal(r.groups[0]?.comparable, true)
    // 两个 Quote 均携带同一 snapshotHash（DoD①）
    const hashes = new Set(r.groups[0]!.quotes.map((q) => q.snapshotHash))
    assert.equal(hashes.size, 1)
    assert.equal([...hashes][0], r.query.hash)
    // 美团 26.9 < 饿了么 27.0
    assert.equal(r.cheapest?.platform, 'meituan')
    // 策略 presumed 不影响 effectivePrice（无 verified 实证）
    const meituan = r.groups[0]!.quotes.find((q) => q.platform === 'meituan')!
    assert.equal(meituan.effectivePrice, 26.9)
    assert.ok((meituan.optionalSavings ?? []).length >= 0)
  } finally {
    await env.cleanup()
  }
})

// ───────────────────── 饿了么 canvas 自绘 → ROI OCR 抽取（P4 真机实测结论） ─────────────────────

import { extractElemeSettleFromOcr, ocrMoney, settlePanelRoi } from '../src/platform/elemeReal.ts'
import { parseUiNodes } from '../src/device/uixml.ts'
import type { OcrWord } from '../src/ocr/reader.ts'

function ocrWord(t: string, x: number, y: number, c = 0.9): OcrWord {
  return { t, c, bbox: { x, y, w: Math.max(20, t.length * 20), h: 30 } }
}

test('ocrMoney: 归一各种 OCR 金额串', () => {
  assert.equal(ocrMoney('¥20.8'), 20.8)
  assert.equal(ocrMoney('Y3.9'), 3.9)
  assert.equal(ocrMoney('y35.9'), 35.9)
  assert.equal(ocrMoney('xy20.8'), 20.8)
  assert.equal(ocrMoney('¥1'), 1)
  assert.ok(Number.isNaN(ocrMoney('无金额')))
})

test('eleme OCR 抽取（canvas 自绘）：标签→金额 + 实付，confidence 永不 high', () => {
  // 真机布局：打包费 ¥1、配送费 ¥3.9、"已优惠 ¥35.9"（整单汇总，不当独立优惠）、立即支付 ¥20.8
  const words: OcrWord[] = [
    ocrWord('打包费', 100, 800),
    ocrWord('¥1', 2300, 800),
    ocrWord('配送费', 100, 860),
    ocrWord('¥3.9', 2280, 860),
    ocrWord('已优惠', 2100, 1000, 0.95),
    ocrWord('¥35.9', 2300, 1000, 0.95),
    ocrWord('立即支付', 1600, 1400),
    ocrWord('¥20.8', 2000, 1400, 0.9),
  ]
  const facts = extractElemeSettleFromOcr(words, cond(), 'ocr-text')
  assert.equal(facts.payable, 20.8)
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.packing, 1)
  assert.equal(kinds.delivery, 3.9)
  // "已优惠 ¥35.9" 是整单汇总，不得作为独立 discount 叠加（防重复扣，§5.3）
  assert.equal(
    facts.discounts.some((d) => d.amount === 35.9),
    false,
  )
  // OCR 命中：永不 high（§6.3.4）
  assert.notEqual(facts.confidence, 'high')
  assert.equal(facts.byField.payable, 'ocr')
  const quote = priceQuote({
    platform: 'eleme',
    store: { name: facts.storeName, matchedScore: 1 },
    item: { name: facts.itemName, qty: facts.qty, matchedScore: 1 },
    fees: facts.fees,
    discounts: facts.discounts,
    payable: facts.payable,
    extraction: { confidence: facts.confidence, byField: facts.byField },
    evidence: {
      quoteId: 'q',
      platform: 'eleme',
      storeName: facts.storeName,
      itemSpec: facts.itemName,
      qty: facts.qty,
      feeBreakdown: facts.fees,
      rawExtraction: { ocrText: 'ocr' },
      capturedAt: '2026-10-24T13:00:00+08:00',
      validUntil: '2026-10-24T13:10:00+08:00',
      redaction: 'applied',
    },
  })
  // OCR 路径 quote 的 confidence 永不 high
  assert.notEqual(quote.extraction.confidence, 'high')
})

test('eleme OCR 抽取：真实脱敏 fixture（打包费数字被 OCR 丢弃 → 低置信 needsConfirm）', async () => {
  const raw = JSON.parse(await readFile(join(FIX, 'eleme-settle.ocr.json'), 'utf8')) as {
    words: { t: string; c: number; x0: number; y0: number; x1: number; y1: number }[]
  }
  const words: OcrWord[] = raw.words.map((w) => ({
    t: w.t,
    c: w.c / 100,
    bbox: { x: w.x0, y: w.y0, w: w.x1 - w.x0, h: w.y1 - w.y0 },
  }))
  const facts = extractElemeSettleFromOcr(words, cond({ item: '手撕烤鸭（整只）+米饭' }), 'ocr')
  // 实付 20.8 稳定可读
  assert.equal(facts.payable, 20.8)
  // 打包费数字未被 OCR 读出 → 保守低置信（不硬凑）
  assert.equal(facts.confidence, 'low')
})

test('settlePanelRoi: 从 tms_fragment_container bounds 取右栏 ROI', () => {
  const xml = `<hierarchy><node resource-id="me.ele:id/tms_fragment_container" class="android.widget.RelativeLayout" clickable="false" bounds="[1280,0][2560,1570]"/></hierarchy>`
  const roi = settlePanelRoi(parseUiNodes(xml))
  assert.deepEqual(roi, { x: 1280, y: 0, w: 1280, h: 1570 })
})
