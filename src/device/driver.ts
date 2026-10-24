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
  /**
   * 按屏幕坐标点击（**安全**：实现内先解析该点命中的节点、过 `assertTapSafe`，
   * 命中下单/支付即拒绝）。用于无稳定 id/文案、只能按几何位置进入的场景（如搜索结果卡片）。
   */
  tapPoint?(x: number, y: number): Promise<void>
  /** 上/下滑动。 */
  swipe(dir: 'up' | 'down'): Promise<void>
  /** 截屏，返回 PNG 字节。 */
  screencap(): Promise<Uint8Array>
  /**
   * 把目标 App 拉到前台（等价"用户点桌面图标"；**不做任何登录/授权/支付操作**）。
   * `force=true` 时先 force-stop 再启动（用于"App 恢复到上次页面且退不出去"时**强制回首页**）。
   * Mock 可不实现（上层跳过）。
   */
  launchApp?(appId: string, opts?: { force?: boolean }): Promise<void>
  /**
   * 当前前台包名（用于判断"是不是我们的 App 在前台"，失败返回 undefined）。
   * Mock 可不实现。
   */
  foreground?(): Promise<string | undefined>
  /** 按一次系统返回键（仅用于**回到首页**等导航，绝不用于关闭支付/确认框）。Mock 可不实现。 */
  back?(): Promise<void>
  /**
   * 能力探测（可选）：真机驱动实现；Mock 驱动可不实现（上层据 undefined 提示"仅真机可用"）。
   * 返回结构见 device/probe.ts 的 `DeviceProbe`；此处用宽松类型避免循环依赖。
   */
  probe?(): Promise<unknown>
}
