/**
 * price/schema.ts — 两层校验（docs/module-spec.md §6.3）。
 * 层：pure。只依赖 zod 与同目录 model.ts。
 *
 * 关键点：
 *  - 算术自洽（arithmetic）与识别可信度（extraction）是**两套独立**结论；
 *  - arithmetic/extraction 是"自报字段"，用 superRefine 按 fees/discounts/payable **交叉校验是否诚实**；
 *  - effectivePrice 若给出，必须等于 payable − Σ(verified && !alreadyIncludedInPayable)（防重复扣）。
 * 实测：superRefine 内 ctx.addIssue 必须用 `message`（用 `error` 会降级为 "Invalid input"）。
 */
import { z } from 'zod'

const money = z.number().finite().nonnegative().max(10000)

export const FeeKindSchema = z.enum([
  'goods',
  'delivery',
  'packing',
  'service',
  'small_order',
  'tip',
  'other',
])
const FeeSourceSchema = z.enum(['tree', 'ocr', 'derived'])
const DiscountKindSchema = z.enum([
  'coupon',
  'membership',
  'credit_card',
  'promo',
  'delivery_waiver',
])
const DiscountSourceSchema = z.enum(['tree', 'ocr'])
const ScopeSchema = z.enum(['item', 'order', 'delivery'])
const ConfidenceSchema = z.enum(['high', 'medium', 'low'])
export const AvailabilitySchema = z.enum(['verified', 'presumed', 'known_unavailable', 'unknown'])
const SourceOfTruthSchema = z.enum(['settle_screenshot', 'local_ledger', 'platform_config', 'none'])

export const FeeLineSchema = z.object({
  kind: FeeKindSchema,
  label: z.string(),
  amount: money,
  source: FeeSourceSchema,
})

export const DiscountSchema = z.object({
  kind: DiscountKindSchema,
  platform: z.string(),
  id: z.string(),
  name: z.string(),
  amount: z.number().nonnegative(),
  scope: ScopeSchema,
  source: DiscountSourceSchema,
  autoApplied: z.boolean(),
  alreadyIncludedInPayable: z.boolean(),
  refundedBy: z.string().optional(),
})

export const OptionalSavingSchema = DiscountSchema.extend({
  availability: AvailabilitySchema,
  availabilityReason: z.string().optional(),
  sourceOfTruth: SourceOfTruthSchema,
})

export const ArithmeticSchema = z.object({
  balanced: z.boolean(),
  expected: money,
  delta: z.number(),
  tolerance: z.number().nonnegative(),
})

export const ExtractionSchema = z.object({
  confidence: ConfidenceSchema,
  byField: z.record(z.string(), z.enum(['tree', 'ocr'])),
  ocrConfidences: z.record(z.string(), z.number().min(0).max(1)).optional(),
})

export const OcrBoxSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
})

export const EvidenceSchema = z.object({
  quoteId: z.string(),
  platform: z.string(),
  storeName: z.string(),
  itemSpec: z.string(),
  qty: z.number().int().positive(),
  feeBreakdown: z.array(FeeLineSchema),
  rawExtraction: z.object({
    treeDumpPath: z.string().optional(),
    ocrText: z.string().optional(),
    ocrBoxes: z.array(OcrBoxSchema).optional(),
  }),
  checkResult: z.object({ arithmetic: ArithmeticSchema, extraction: ExtractionSchema }),
  screenshotPath: z.string().optional(),
  capturedAt: z.string(),
  validUntil: z.string(),
  redaction: z.enum(['none', 'applied']),
  missingReason: z.string().optional(),
})

/** 容差（仅用于"算术自洽"判定）：默认 min(1.0 元, 5%)。 */
export function toleranceFor(platform: string, expected = 0): number {
  const configured: Record<string, number> = { meituan: 1.0, eleme: 1.0 }
  const cap = configured[platform] ?? 1.0
  return expected > 0 ? Math.min(cap, expected * 0.05) : cap
}

/** 由明细重算应付：只用非 derived 的费用项，减去 autoApplied 的优惠。 */
export function expectedPayable(input: {
  fees: { amount: number; source: string }[]
  discounts: { amount: number; autoApplied: boolean }[]
}): number {
  const gross = input.fees.filter((f) => f.source !== 'derived').reduce((s, f) => s + f.amount, 0)
  const auto = input.discounts.filter((d) => d.autoApplied).reduce((s, d) => s + d.amount, 0)
  return round2(gross - auto)
}

/**
 * effectivePrice 应扣的优惠：verified 且 sourceOfTruth=settle_screenshot 且未含在 payable。
 *
 * 防重复计数（§5.3）：同一笔优惠可能被 App **拆成多条展示**，从条的 `refundedBy` 指向主条 `id`。
 * 若主条已在本次可扣集合中，则从条**不得重复计入**（否则 effectivePrice 被压到低于实际 = 幻影优惠）。
 * 仅当主条不在可扣集合里（如主条已含在 payable / 数据缺失）时，从条才作为唯一可见凭证计入（保守，不静默丢优惠）。
 */
export function deductibleSavings(
  savings: {
    id?: string
    amount: number
    availability: string
    sourceOfTruth?: string
    alreadyIncludedInPayable: boolean
    refundedBy?: string
  }[],
): number {
  const eligible = savings.filter(
    (s) =>
      s.availability === 'verified' &&
      (s.sourceOfTruth === undefined || s.sourceOfTruth === 'settle_screenshot') &&
      !s.alreadyIncludedInPayable,
  )
  // 本次真正会被计入的"主条"id（自身不是从条）。
  const masterIds = new Set(
    eligible.filter((s) => !s.refundedBy && s.id).map((s) => s.id as string),
  )
  const counted = eligible.filter((s) => !(s.refundedBy && masterIds.has(s.refundedBy)))
  return round2(counted.reduce((sum, s) => sum + s.amount, 0))
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

const StoreSchema = z.object({
  name: z.string(),
  amapId: z.string().optional(),
  platformShopId: z.string().optional(),
  distanceM: z.number().nonnegative().optional(),
  rating: z.number().optional(),
  matchedScore: z.number().min(0).max(1),
})

const ItemSchema = z.object({
  name: z.string(),
  spec: z.string().optional(),
  qty: z.number().int().positive().default(1),
  matchedScore: z.number().min(0).max(1).default(1),
  composition: z.array(z.string()).optional(),
  listPrice: money.optional(),
})

export const QuoteSchema = z
  .object({
    platform: z.string(),
    store: StoreSchema,
    item: ItemSchema,
    fees: z.array(FeeLineSchema).min(1),
    discounts: z.array(DiscountSchema).default([]),
    payable: money,
    effectivePrice: money.optional(),
    arithmetic: ArithmeticSchema,
    extraction: ExtractionSchema,
    needsConfirm: z.boolean().optional(),
    deviatedConditions: z.array(z.string()).optional(),
    optionalSavings: z.array(OptionalSavingSchema).optional(),
    snapshotId: z.string().optional(),
    snapshotHash: z.string().optional(),
    evidence: EvidenceSchema,
  })
  .superRefine((q, ctx) => {
    const expected = expectedPayable(q)
    const delta = round2(expected - q.payable)
    const tol = toleranceFor(q.platform, expected)

    // 自报 arithmetic 必须与重算一致
    if (Math.abs(q.arithmetic.expected - expected) > 0.01) {
      ctx.addIssue({
        code: 'custom',
        path: ['arithmetic', 'expected'],
        message: `arithmetic.expected 与明细重算不一致（应为 ${expected}）`,
      })
    }
    const balancedShould = Math.abs(delta) <= tol
    if (q.arithmetic.balanced !== balancedShould) {
      ctx.addIssue({
        code: 'custom',
        path: ['arithmetic', 'balanced'],
        message: `arithmetic.balanced 与重算不一致（应为 ${balancedShould}）`,
      })
    }

    // effectivePrice 不得重复扣
    if (q.effectivePrice !== undefined) {
      const want = round2(q.payable - deductibleSavings(q.optionalSavings ?? []))
      if (Math.abs(want - q.effectivePrice) > 0.01) {
        ctx.addIssue({
          code: 'custom',
          path: ['effectivePrice'],
          message: `effectivePrice 应为 ${want}（只扣已验证且未含的优惠），实际 ${q.effectivePrice}`,
        })
      }
    }
  })

export type QuoteInput = z.input<typeof QuoteSchema>

/** 校验并返回规范化后的 Quote；失败抛 ZodError。 */
export function validateQuote(raw: unknown) {
  return QuoteSchema.parse(raw)
}

export function safeValidateQuote(raw: unknown) {
  return QuoteSchema.safeParse(raw)
}
