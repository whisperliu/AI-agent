/**
 * price/model.ts — 数据模型唯一真源（docs/module-spec.md §6.2）。
 * 层：pure（无 IO / 无 ctx / 无 device）。
 *
 * 注意：Node 类型剥离不支持 enum，用字符串字面量联合。
 */

export type FeeKind =
  | 'goods' // 商品价
  | 'delivery' // 配送费
  | 'packing' // 打包费
  | 'service' // 配送/平台服务费
  | 'small_order' // 起送/小单加价
  | 'tip' // 骑手打赏
  | 'other'

export type FeeSource = 'tree' | 'ocr' | 'derived'

export interface FeeLine {
  kind: FeeKind
  label: string
  amount: number
  source: FeeSource
}

export type DiscountKind = 'coupon' | 'membership' | 'credit_card' | 'promo' | 'delivery_waiver'
export type DiscountScope = 'item' | 'order' | 'delivery'
export type DiscountSource = 'tree' | 'ocr'
export type Availability = 'verified' | 'presumed' | 'known_unavailable' | 'unknown'
export type SourceOfTruth = 'settle_screenshot' | 'local_ledger' | 'platform_config' | 'none'
export type Confidence = 'high' | 'medium' | 'low'

export interface Discount {
  kind: DiscountKind
  platform: string
  id: string
  name: string
  amount: number
  scope: DiscountScope
  source: DiscountSource
  autoApplied: boolean
  /** true = 已含在结算页实付里，effectivePrice 不再减它（防重复扣） */
  alreadyIncludedInPayable: boolean
  /** 若同一优惠被拆成多条展示，指向主优惠 id，避免重复计数 */
  refundedBy?: string
}

export interface OptionalSaving extends Discount {
  availability: Availability
  availabilityReason?: string
  sourceOfTruth: SourceOfTruth
}

export interface Arithmetic {
  balanced: boolean
  expected: number
  delta: number
  tolerance: number
}

export interface Extraction {
  confidence: Confidence
  byField: Record<string, 'tree' | 'ocr'>
  ocrConfidences?: Record<string, number>
}

export interface OcrBox {
  text: string
  confidence: number
  bbox: [number, number, number, number]
}

export interface Evidence {
  quoteId: string
  platform: string
  storeName: string
  itemSpec: string
  qty: number
  feeBreakdown: FeeLine[]
  rawExtraction: {
    treeDumpPath?: string
    ocrText?: string
    ocrBoxes?: OcrBox[]
  }
  checkResult: { arithmetic: Arithmetic; extraction: Extraction }
  screenshotPath?: string
  capturedAt: string
  validUntil: string
  redaction: 'none' | 'applied'
  missingReason?: string
}

export interface Store {
  name: string
  amapId?: string
  platformShopId?: string
  distanceM?: number
  rating?: number
  matchedScore: number
}

export interface Item {
  name: string
  spec?: string
  qty: number
  matchedScore: number
  composition?: string[]
  listPrice?: number
}

export interface Quote {
  platform: string
  store: Store
  item: Item
  fees: FeeLine[]
  discounts: Discount[]
  payable: number
  effectivePrice?: number
  arithmetic: Arithmetic
  extraction: Extraction
  needsConfirm?: boolean
  deviatedConditions?: string[]
  optionalSavings?: OptionalSaving[]
  evidence: Evidence
}

export interface ComparisonConditions {
  snapshotId: string
  item: string
  qty: number
  spec: string[]
  composition: string[]
  deliverTo: { city: string; lat: number; lng: number; addressHash?: string }
  expectDeliveryBy?: string
  fixedAt: string
  hash: string
}

export interface QuoteGroup {
  key: string
  comparable: boolean
  quotes: Quote[]
}

export interface CompareResult {
  taskId: string
  query: ComparisonConditions
  groups: QuoteGroup[]
  cheapest: Quote | null
  note: string[]
}

/** 证据草稿：checkResult 由引擎填入，抽取阶段可先省略。 */
export type EvidenceDraft = Omit<Evidence, 'checkResult'> & {
  checkResult?: Evidence['checkResult']
}

/**
 * 引擎输入草稿：抽取层（device/ocr）给出原始事实与识别可信度，
 * 由 engine 负责算 arithmetic / effectivePrice / needsConfirm 并补 checkResult。
 */
export interface QuoteDraft {
  platform: string
  store: Store
  item: Item
  fees: FeeLine[]
  discounts: Discount[]
  payable: number
  optionalSavings?: OptionalSaving[]
  deviatedConditions?: string[]
  /** 调用方（OCR 质量门/控件树）给出的识别可信度 */
  extraction: Extraction
  evidence: EvidenceDraft
}
