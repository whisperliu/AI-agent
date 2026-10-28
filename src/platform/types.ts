/**
 * platform/types.ts — 平台策略契约（唯一真源，§30）。
 * 层：strategy。依赖 `price/model` 类型与 `device/driver` 接口，**不 import** 设备实现。
 */
import type { Driver } from '../device/driver.ts'
import type { Ocr, OcrWord } from '../ocr/reader.ts'
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
  /** 原始 OCR 逐词结果（P5：留存到 evidence.rawExtraction.ocrBoxes，便于复核/定位）。 */
  ocrWords?: OcrWord[]
  /**
   * 加购阶段**已核对命中**的目标菜名（饿了么 OCR 盲导航专用）。
   * 背景（2026-10-28 真机）：结算页 OCR 常把菜名读花（"小炒肉木桶饭"→"小炒内木情所Y"），
   * 而加购时点的是**按目标菜名精确匹配命中**的那张卡（弹窗印证即为目标菜）。当结算页菜名识别度/相似度
   * 低于阈值时，用此已核对值回填 `itemName`——这是"有据的核对结果"，**不是伪造**（未命中则加购前已交人工）。
   */
  verifiedItemName?: string
  screenshot?: Uint8Array
}

export interface PlatformStrategy {
  id: string
  appId: string
  /** 结算页 anchor（断言命中）。 */
  settleAnchor: string
  /**
   * `enterSettlePage` 是否**幂等**（可被上层安全重试）。默认 `true`。
   *
   * 2026-10-27 真机教训：饿了么全自动链路含**加购**（非幂等副作用），且它**自带内层重试**
   * （`runElemeOcrNav(attempts)`，重试间共享 `AddToCartState` 去重）。若再被 runner 的
   * `withRetry` 外层重跑，就变成"内外两层重试相乘"：外层每次都是新的 `AddToCartState`
   * → 每重试一次就**再往购物车加一件**（真机实测 1→3 件，账单 ¥13.98→¥75.94）。
   * 故饿了吗必须声明 `idempotentEnter: false`，由 runner 跳过外层重试（改用其自带内层重试）。
   */
  idempotentEnter?: boolean
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
