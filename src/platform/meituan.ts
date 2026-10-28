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
import { assertUsableWindow, ensureAppForeground } from './navigator.ts'
import { GENERIC_SETTLE_SELECTORS } from './selectors/generic.ts'
import type { PlatformStrategy, RawQuoteFacts } from './types.ts'

function isRealDevice(driver: Driver): boolean {
  return typeof (driver as { probe?: unknown }).probe === 'function'
}

export const meituan: PlatformStrategy = {
  id: 'meituan',
  appId: 'com.sankuai.meituan',
  settleAnchor: SETTLE_ANCHOR,
  // 美团真机链路含**加购副作用**（非幂等）。若被 runner 外层 `withRetry` 整条重跑，会在已有购物车上
  // 再加一件（真机实测 ×3）→ payable 变成多件总额而算术自洽 → 静默错价。故声明非幂等，交由 runner
  // 跳过外层重试（美团内部"去结算"已自带 3 次点按重试，足够覆盖偶发点不中）。
  idempotentEnter: false,
  selectors: GENERIC_SETTLE_SELECTORS,
  async enterSettlePage(driver: Driver, cond: ComparisonConditions): Promise<RawQuoteFacts> {
    if (isRealDevice(driver)) {
      // 前置：窗口必须是全屏竖屏（分屏/letterbox 下坐标会错位，明确拒绝并提示人工）。
      await assertUsableWindow(driver)
      // 关键：先把美团拉到前台（此前缺失 → 前台是别的 App/桌面时必然超时）。
      await ensureAppForeground(driver, 'com.sankuai.meituan')
      return runMeituanReal(createNavigator(driver), cond)
    }
    return enterViaOpenTag(driver, 'meituan', cond)
  },
}
