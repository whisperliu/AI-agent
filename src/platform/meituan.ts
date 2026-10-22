/**
 * platform/meituan.ts — 美团策略（§30）。
 * 层：strategy。具体选择器在 selectors/；流程只到"进结算页并产出事实"。
 */
import type { ComparisonConditions } from '../price/model.ts'
import type { Driver } from '../device/driver.ts'
import { enterViaOpenTag, SETTLE_ANCHOR } from './extract.ts'
import { GENERIC_SETTLE_SELECTORS } from './selectors/generic.ts'
import type { PlatformStrategy, RawQuoteFacts } from './types.ts'

export const meituan: PlatformStrategy = {
  id: 'meituan',
  appId: 'com.sankuai.meituan',
  settleAnchor: SETTLE_ANCHOR,
  selectors: GENERIC_SETTLE_SELECTORS,
  enterSettlePage(driver: Driver, cond: ComparisonConditions): Promise<RawQuoteFacts> {
    return enterViaOpenTag(driver, 'meituan', cond)
  },
}
