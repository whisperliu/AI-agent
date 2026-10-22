/**
 * device/driver.ts — 设备抽象（唯一真源，§40 / §4.4）。
 * 层：capability。**不得**依赖 price/task/platform；只描述 UI 操作与原始读取。
 *
 * Node 类型剥离限制：使用显式接口，无 enum。
 */

/** UI 选择器：优先 resourceId，其次文本/无障碍标签。 */
export interface UiSelector {
  resourceId?: string
  text?: string
  label?: string
}

/** 设备抽象：adb 与 mock 实现同一接口，切换 `device.driver` 不改上层（§2.1 R3）。 */
export interface Driver {
  /** 读取当前界面的 uiautomator XML 文本。 */
  dump(): Promise<string>
  /** 点击一个控件。实现内**必须先过安全护栏**（assertTapSafe，§0 红线 1）。 */
  tap(sel: UiSelector): Promise<void>
  /** 在输入框输入文本。 */
  input(sel: UiSelector, text: string): Promise<void>
  /** 上/下滑动。 */
  swipe(dir: 'up' | 'down'): Promise<void>
  /** 截屏，返回 PNG 字节。 */
  screencap(): Promise<Uint8Array>
  /**
   * 能力探测（可选）：真机驱动实现；Mock 驱动可不实现（上层据 undefined 提示"仅真机可用"）。
   * 返回结构见 device/probe.ts 的 `DeviceProbe`；此处用宽松类型避免循环依赖。
   */
  probe?(): Promise<unknown>
}
