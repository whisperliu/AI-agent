/**
 * Cross-cutting error types (referenced by AGENTS.md §2 错误语义).
 * Layer: core (no dependencies).
 *
 * 注意：Node 直接运行 .ts 采用"类型剥离"，**不支持参数属性/枚举/命名空间**，
 * 因此这里用显式字段声明（见 AGENTS.md §2 与 docs/module-spec.md §4.1）。
 */

/** 设备/快照锁被占用或获取超时 → 上层映射为 503 BUSY（docs/module-spec.md §7.7） */
export class BusyError extends Error {
  override readonly name = 'BusyError'
  readonly resource: string
  constructor(resource: string) {
    super(`busy: ${resource}`)
    this.resource = resource
  }
}

/** 页面状态断言失败 → 带取证（dump 路径 / 截图路径），见 §3.5.1 */
export class StateAssertionError extends Error {
  override readonly name = 'StateAssertionError'
  readonly expected: string
  readonly dumpPath?: string
  readonly screenshotPath?: string
  constructor(expected: string, dumpPath?: string, screenshotPath?: string) {
    super(`state assertion failed: ${expected}`)
    this.expected = expected
    this.dumpPath = dumpPath
    this.screenshotPath = screenshotPath
  }
}

/** 需要人工介入（登录 / 验证码 / 风控）→ 任务必须暂停，禁止自动绕过（AGENTS.md §0 红线 2） */
export class NeedsHumanError extends Error {
  override readonly name = 'NeedsHumanError'
  readonly reason: 'login' | 'captcha' | 'risk-control'
  constructor(reason: 'login' | 'captcha' | 'risk-control') {
    super(`needs human intervention: ${reason}`)
    this.reason = reason
  }
}

/**
 * 试图触碰"下单/支付"红线控件时抛出（AGENTS.md §0 红线 1）。
 * 这是**最后一道程序化防线**：即便上层逻辑写错，命中危险控件也会在这里被拦下。
 */
export class ForbiddenActionError extends Error {
  override readonly name = 'ForbiddenActionError'
  readonly target: string
  constructor(target: string) {
    super(`forbidden action blocked (order/payment): ${target}`)
    this.target = target
  }
}
