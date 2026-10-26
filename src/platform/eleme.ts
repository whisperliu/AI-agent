/**
 * platform/eleme.ts — 饿了么策略（§30）。
 * 层：strategy。具体选择器在 selectors/；流程只到"进结算页并产出事实"。
 *
 * 驱动解耦（DoD②）：同一份策略按驱动能力自动选通路 ——
 *   - MockDriver（无 probe）→ `enterViaOpenTag`（回放 open-eleme 后的结算页 dump）；
 *   - 真机 adb（有 probe）→ `runElemeReal`（搜索→选店→加购→结算→读实付）。
 * 上层（task/runner）无需感知，只拿 `RawQuoteFacts`。
 */
import type { ComparisonConditions } from '../price/model.ts'
import type { Driver } from '../device/driver.ts'
import { enterViaOpenTag, SETTLE_ANCHOR } from './extract.ts'
import { assertUsableWindow, ensureAppForeground } from './navigator.ts'
import { runElemeReal } from './elemeReal.ts'
import { GENERIC_SETTLE_SELECTORS } from './selectors/generic.ts'
import type { PlatformEnterContext, PlatformStrategy, RawQuoteFacts } from './types.ts'

function isRealDevice(driver: Driver): boolean {
  return typeof (driver as { probe?: unknown }).probe === 'function'
}

export const eleme: PlatformStrategy = {
  id: 'eleme',
  appId: 'me.ele',
  settleAnchor: SETTLE_ANCHOR,
  selectors: GENERIC_SETTLE_SELECTORS,
  async enterSettlePage(
    driver: Driver,
    cond: ComparisonConditions,
    ctx?: PlatformEnterContext,
  ): Promise<RawQuoteFacts> {
    if (isRealDevice(driver)) {
      // 前置：窗口必须是全屏竖屏（分屏/letterbox 下坐标会错位，明确拒绝并提示人工）。
      await assertUsableWindow(driver)
      // 关键：先把饿了么拉到前台（此前缺失 → 前台是别的 App/桌面时必然超时）。
      await ensureAppForeground(driver, 'me.ele')
      // 饿了么为 canvas 自绘，控件树不可读 → 真机走 OCR 兜底（需要 ctx.ocr）。
      return runElemeReal(driver, cond, ctx)
    }
    return enterViaOpenTag(driver, 'eleme', cond)
  },
}
