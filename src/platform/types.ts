/**
 * platform/types.ts — 平台策略契约（唯一真源，§30）。
 * 层：strategy。依赖 `price/model` 类型与 `device/driver` 接口，**不 import** 设备实现。
 */
import type { Driver } from '../device/driver.ts'
import type { Ocr } from '../ocr/reader.ts'
import type {
  ComparisonConditions,
  DiscountKind,
  DiscountSource,
  DiscountScope,
  FeeKind,
  FeeSource,
  OptionalSaving,
} from '../price/model.ts'

/** 抽取到的一组原始事实（platform 产出；engine 负责判账）。 */
export interface RawQuoteFacts {
  storeName: string
  storeAmapId?: string
  itemName: string
  itemSpec?: string
  qty: number
  composition?: string[]
  /** 已带 source 的费用明细（tree；P1 mock 一律 tree）。 */
  fees: { kind: FeeKind; label: string; amount: number; source: FeeSource }[]
  discounts: {
    kind: DiscountKind
    platform: string
    id: string
    name: string
    amount: number
    scope: DiscountScope
    source: DiscountSource
    autoApplied: boolean
    alreadyIncludedInPayable: boolean
  }[]
  /** 结算页实付（纯事实）。 */
  payable: number
  /**
   * 未纳入实付的"可得优惠"（如美团"待使用红包"）——结算页明确展示但**未自动抵扣**。
   * 作为 optionalSaving 交给 price：只有 verified 才在 effectivePrice 里扣，避免把"待使用"当"已用"。
   */
  optionalSavings?: OptionalSaving[]
  /** 识别可信度（tree 读取 → high；OCR → 由质量门下调）。 */
  confidence: 'high' | 'medium' | 'low'
  /** 抽取来源（tree/ocr），写入 evidence 与 extraction.byField。 */
  byField: Record<string, 'tree' | 'ocr'>
  /** 原始 dump 文本（用于 evidence 留存）。 */
  dump: string
  screenshot?: Uint8Array
}

export interface PlatformStrategy {
  id: string
  appId: string
  /** 结算页 anchor（断言命中）。 */
  settleAnchor: string
  /** 控件选择器集中登记（App 改版只改 selectors/）。 */
  selectors: Record<string, string>
  /**
   * 打开 App 并进入结算页。
   * `ctx` 可选传入 OCR 端口（仅当平台在控件树不可读、需截图 OCR 兜底时使用，如饿了么 canvas 自绘）。
   */
  enterSettlePage(
    driver: Driver,
    cond: ComparisonConditions,
    ctx?: PlatformEnterContext,
  ): Promise<RawQuoteFacts>
}

/** 进入结算页时可用的附加能力（注入式，platform 只依赖接口）。 */
export interface PlatformEnterContext {
  /** OCR 端口（仅当 controls 不可读时用；未提供表示不启用 OCR）。 */
  ocr?: Ocr
  /** 截图的落盘目录（证据留存）。 */
  dataDir?: string
}
