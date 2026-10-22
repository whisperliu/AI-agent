/**
 * core/clock.ts — 时间抽象（§2.1 R4：业务禁止直接 Date.now）。
 * 层：infra。生产用 SystemClock；测试用 FakeClock（可推进）。
 *
 * Node 类型剥离限制：不支持参数属性 / enum / namespace，故用显式字段与普通类。
 */

/** 时间与定时的抽象；注入到业务层，便于确定性测试。 */
export interface Clock {
  /** 当前时刻（毫秒）。 */
  now(): number
  /** 当前时刻（ISO 8601 字符串，本地时区偏移由 Date#toISOString 决定，统一 UTC）。 */
  iso(): string
  /** 等待若干毫秒（可被 AbortSignal 取消）。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** 生产时钟：直接读系统时间。 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
  iso(): string {
    return new Date(this.now()).toISOString()
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    })
  }
}

/**
 * 可推进的假时钟：测试用。`advance` 推进虚拟时间并唤醒到点的 sleep。
 * 不依赖真实定时器，保证超时/过期逻辑可确定。
 */
export class FakeClock implements Clock {
  private t: number
  private seq = 0
  private timers: { at: number; resolve: () => void; id: number }[] = []

  constructor(startMs: number) {
    this.t = startMs
  }

  now(): number {
    return this.t
  }
  iso(): string {
    return new Date(this.t).toISOString()
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.timers.push({ at: this.t + Math.max(0, ms), resolve, id })
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((x) => x.id !== id)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    })
  }

  /** 推进虚拟时间，触发所有到点定时器。 */
  advance(ms: number): void {
    this.t += ms
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((x) => x.at > this.t)
    for (const d of due) d.resolve()
  }
}
