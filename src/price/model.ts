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

// ───────────────────────────── 任务编排（task）共享契约 ─────────────────────────────
// 唯一真源：task/* 与 tools/* 都 `import type` 这里，禁止重复定义（§4.4 R5）。

/** 任务状态机（§7.3）：queued → processing → completed|failed|cancelled|expired。 */
export type TaskStatus =
  'queued' | 'processing' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'expired'

/** 失败原因分类（对应 §7.5(3)(6) 与工具错误映射）。 */
export type TaskFailureReason =
  'timeout' | 'interrupted' | 'state' | 'needs_human' | 'busy' | 'forbidden' | 'error'

/**
 * 持久化任务记录（`ctx.storageDomain` 的 `tasks` 表，§7.5(1)）。
 * 事实源；与 DSH job 解耦（job 随进程消失，本记录不丢）。
 */
export interface TaskRecord {
  taskId: string
  idempotencyKey: string
  status: TaskStatus
  phase: string
  /** 最近若干进度行（有界，便于重取时回放最后状态）。 */
  progress: string[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** 结果/错误原子写文件的绝对路径。 */
  resultPath?: string
  error?: { reason: TaskFailureReason; message: string }
  /** 当前活跃运行的执行令牌；迟到写入校验其是否仍活跃（§7.5(2)）。 */
  runToken: string
  owner?: string
  /** 结果有效期（ISO）；重取过期返回 expired 而非旧价（§7.5(7)）。 */
  validUntil?: string
  /** 是否已被消费（供 listTasks 补取，§7.5(5)）。 */
  consumed?: boolean
}

/** 幂等键 → 任务映射（`idempotency` 表，§7.6）。 */
export interface IdempotencyRecord {
  key: string
  taskId: string
  /** 生成该键的输入快照 hash；同 key 异 hash 视为冲突 409（§7.6 R3）。 */
  snapshotHash: string
  createdAt: string
}

/** 比价任务启动选项（影响结果的选项，参与任务选项 hash，§7.6 R1）。 */
export interface CompareOptionsSpec {
  platforms?: string[]
  city?: string
  /** 每个平台最多取几个候选报价。 */
  maxResults?: number
  /** 是否允许 OCR 兜底（P1 仅 Mock）。 */
  useOcr?: boolean
}

/** `price_agent` start 的入参。 */
export interface StartInput {
  item: string
  city?: string
  platforms?: string[]
  /** 显式幂等键；缺省由系统按快照计算（§7.6 R1）。 */
  idempotencyKey?: string
  /** 强制重跑：忽略既有幂等记录（用于卡死/失败态重试，§7.6 R3）。 */
  force?: boolean
  options?: CompareOptionsSpec
}

/** `price_agent` start 的返回（异步契约，§7.4 / §7.6 R3：复用时返回既有状态）。 */
export interface StartReply {
  taskId: string
  status: TaskStatus
  message: string
}

/** `price_agent.getResult` 的返回（幂等只读，§7.4/§7.6 R2）。 */
export interface GetResultReply {
  taskId: string
  status: TaskStatus
  result?: CompareResult
  error?: { reason: TaskFailureReason; message: string }
  note?: string
}

/** `price_agent.listTasks` 的一行。 */
export interface TaskSummary {
  taskId: string
  status: TaskStatus
  phase: string
  createdAt: string
  finishedAt?: string
}

/** `price_agent.cancel` 的返回（幂等，§7.6 R2）。 */
export interface CancelReply {
  taskId: string
  outcome: 'requested' | 'already-finished' | 'cancelled'
  status: TaskStatus
}

/** 设备能力探测形状（与 device/probe.ts 的 `DeviceProbe` 对齐；此处松类型避免跨层依赖）。 */
export interface ProbeInfo {
  canDump?: boolean
  dumpLatencyMs?: number
  resolution?: string
  density?: string
  foreground?: string
  canScreenshot?: boolean
  model?: string
  androidVersion?: string
  quality?: {
    textNodes: number
    resourceIds: number
    hasWebview: boolean
    treeRichness: number
    recommend: 'tree' | 'ocr' | 'human'
  }
}

/** `price_agent.probe` 的返回（P2，仅真机）。 */
export interface DeviceProbeReply {
  supported: boolean
  probe?: ProbeInfo
  message?: string
}

/** `price_agent.selfCheck`（§8.4 最小实验）的单项检查与总结果。 */
export interface MinExperimentReply {
  supported: boolean
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
  message: string
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
