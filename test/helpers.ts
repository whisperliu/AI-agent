/**
 * Shared builders for price tests (not a test file itself).
 */
import type { ComparisonConditions, EvidenceDraft, QuoteDraft } from '../src/price/model.ts'

export const NOW = Date.parse('2026-10-22T12:00:00+08:00')

export function evidence(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    quoteId: 'q1',
    platform: 'meituan',
    storeName: '香叶',
    itemSpec: '烤鸭饭 x1',
    qty: 1,
    feeBreakdown: [],
    rawExtraction: { treeDumpPath: '/tmp/ui.xml' },
    screenshotPath: '/tmp/shot.png',
    capturedAt: '2026-10-22T11:59:00+08:00',
    validUntil: '2026-10-22T12:09:00+08:00',
    redaction: 'applied',
    ...over,
  }
}

/** Baseline: goods 28.9 + delivery 2 + packing 1 = 31.9; coupon 5 auto => payable 26.9 */
export function draft(over: Partial<QuoteDraft> = {}): QuoteDraft {
  const base: QuoteDraft = {
    platform: 'meituan',
    store: { name: '香叶烤鸭', amapId: 'AMAP-1', matchedScore: 0.95 },
    item: {
      name: '香叶·精品烤鸭饭',
      spec: '大份',
      qty: 1,
      matchedScore: 0.95,
      composition: ['烤鸭饭'],
    },
    fees: [
      { kind: 'goods', label: '商品', amount: 28.9, source: 'tree' },
      { kind: 'delivery', label: '配送费', amount: 2, source: 'tree' },
      { kind: 'packing', label: '打包费', amount: 1, source: 'tree' },
    ],
    discounts: [
      {
        kind: 'coupon',
        platform: 'meituan',
        id: 'm-coupon',
        name: '满30减5',
        amount: 5,
        scope: 'order',
        source: 'tree',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      },
    ],
    payable: 26.9,
    extraction: { confidence: 'high', byField: { payable: 'tree' } },
    evidence: evidence(),
  }
  return { ...base, ...over }
}

export function cond(over: Partial<ComparisonConditions> = {}): ComparisonConditions {
  return {
    snapshotId: 'snap-1',
    item: '香叶 烤鸭饭',
    qty: 1,
    spec: ['大份'],
    composition: ['烤鸭饭'],
    deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
    fixedAt: '2026-10-22T11:58:00+08:00',
    hash: 'hash-1',
    ...over,
  }
}
