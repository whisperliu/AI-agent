/**
 * device/mock.ts — MockDriver（回放 fixtures，§2.1 R3）。
 * 层：capability（device）。实现与 adb.ts 完全相同的 Driver 接口。
 *
 * 模型：不追求真实 App 脚本，只模拟"打开某平台 App → 走到结算页"。
 * - tap 命中 `open-<platform>` 时激活该平台；
 * - 激活后 dump() 返回该平台的结算页 XML（由 fixtures 提供）；
 * - screencap() 返回 1x1 PNG。
 * 这样 platform 策略用与真机相同的 Driver 调用即可取到结算事实，切换 mock|adb 不改业务代码。
 */
import { assertTapSafe } from '../core/safety.ts'
import type { Driver, UiSelector } from './driver.ts'

/** 1x1 透明 PNG（最小合法占位，避免测试依赖图片库）。 */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const HOME_XML = '<hierarchy><node resource-id="home" text="首页" /></hierarchy>'

export interface MockDriverOptions {
  /** platform id → 结算页 XML。 */
  settlePages: Record<string, string>
  /** 记录每次动作（便于断言"设备锁下不交叉点按"）。 */
  onAction?: (a: { type: string; selector?: UiSelector; platform?: string }) => void
  /** 每次动作后可注入的异步延迟（模拟真机耗时）。 */
  delayMs?: number
}

/** 创建 MockDriver。 */
export function createMockDriver(opts: MockDriverOptions): Driver {
  let activePlatform: string | undefined
  const delay = async () => {
    if (opts.delayMs && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs))
  }

  return {
    async dump() {
      if (activePlatform && opts.settlePages[activePlatform])
        return opts.settlePages[activePlatform]!
      return HOME_XML
    },
    async tap(sel: UiSelector) {
      assertTapSafe(sel)
      const m = /^open-(.+)$/.exec(sel.resourceId ?? '')
      if (m) activePlatform = m[1]
      opts.onAction?.({ type: 'tap', selector: sel, platform: activePlatform })
      await delay()
    },
    async input(sel: UiSelector, text: string) {
      opts.onAction?.({ type: 'input', selector: sel, platform: activePlatform })
      void text
      await delay()
    },
    async swipe(dir) {
      opts.onAction?.({ type: 'swipe', platform: activePlatform })
      void dir
    },
    async screencap() {
      return TINY_PNG
    },
  }
}
