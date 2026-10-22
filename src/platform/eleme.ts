/**
 * platform/eleme.ts — 饿了么策略（§30）。
 * 层：strategy。
 */
import type { ComparisonConditions } from '../price/model.ts'
import type { Driver } from '../device/driver.ts'
import { enterViaOpenTag, SETTLE_ANCHOR } from './extract.ts'
import { GENERIC_SETTLE_SELECTORS } from './selectors/generic.ts'
import type { PlatformStrategy, RawQuoteFacts } from './types.ts'

export const eleme: PlatformStrategy = {
  id: 'eleme',
  appId: 'me.ele',
  settleAnchor: SETTLE_ANCHOR,
  selectors: GENERIC_SETTLE_SELECTORS,
  enterSettlePage(driver: Driver, cond: ComparisonConditions): Promise<RawQuoteFacts> {
    return enterViaOpenTag(driver, 'eleme', cond)
  },
}
