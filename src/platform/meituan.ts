/**
 * platform/meituan.ts — 美团策略（§30）。
 * 层：strategy。具体选择器在 selectors/；流程只到"进结算页并产出事实"。
 *
 * 驱动解耦（DoD②）：同一份策略按驱动能力自动选通路 ——
 *   - MockDriver（无 probe）→ `enterViaOpenTag`（回放 open-meituan 后的结算页 dump）；
 *   - 真机 adb（有 probe）→ `runMeituanReal`（搜索→选店→加购→结算→读实付）。
 * 上层（task/runner）无需感知，只拿 `RawQuoteFacts`。
 */
import type { ComparisonConditions } from '../price/model.ts'
import type { Driver } from '../device/driver.ts'
import { enterViaOpenTag, SETTLE_ANCHOR } from './extract.ts'
import { createNavigator, runMeituanReal } from './meituanReal.ts'
import { GENERIC_SETTLE_SELECTORS } from './selectors/generic.ts'
import type { PlatformStrategy, RawQuoteFacts } from './types.ts'

function isRealDevice(driver: Driver): boolean {
  return typeof (driver as { probe?: unknown }).probe === 'function'
}

export const meituan: PlatformStrategy = {
  id: 'meituan',
  appId: 'com.sankuai.meituan',
  settleAnchor: SETTLE_ANCHOR,
  selectors: GENERIC_SETTLE_SELECTORS,
  async enterSettlePage(driver: Driver, cond: ComparisonConditions): Promise<RawQuoteFacts> {
    if (isRealDevice(driver)) {
      return runMeituanReal(createNavigator(driver), cond)
    }
    return enterViaOpenTag(driver, 'meituan', cond)
  },
}
