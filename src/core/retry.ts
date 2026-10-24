/**
 * core/retry.ts — 瞬时可重试错误的统一判定与重试（P5 打磨 · §7.5(3) 异常重试）。
 * 层：infra（无业务依赖）。
 *
 * 红线（AGENTS.md §0）：**绝不重试**安全类错误——
 *   - `NeedsHumanError`（验证码 / 登录 / 风控）
 *   - `ForbiddenActionError`（试图触碰下单/支付控件）
 *   这两类是"必须停下来交人工/程序化拦截"的信号，重试只会放大风险。
 * 业务终态错误（`StateAssertionError`/`BusyError`/`IdempotencyConflictError`）也不重试，
 * 只重试**明显瞬时**的故障：adb 掉线、`uiautomator dump` 拿不到 idle、截屏拉取失败等。
 */
import { ForbiddenActionError, NeedsHumanError } from './errors.ts'

/** 明确**不可重试**的错误（安全红线 + 业务终态）。 */
const NEVER_RETRY = [/验证码|captcha|滑块|风控|安全验证/i, /需要人工介入/, /forbidden action/i]

/** 明确**可重试**的瞬时故障特征（adb/系统层面）。 */
const TRANSIENT = [
  /device offline/i,
  /device '\S+' not found/i,
  /no devices\/emulators found/i,
  /connection refused/i,
  /could not get idle state/i,
  /uiautomator dump/i,
  /error: closed/i,
  /broken pipe/i,
  /timed out/i,
  /timeout/i,
  /ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH/i,
  /screencap 失败/i,
  /pull 失败/i,
  /adb connect 未成功/i,
]

/**
 * 判定一个错误是否可重试。**安全红线优先**：命中不可重试特征直接 false，
 * 即使文案里也含 "timeout" 之类。默认不可重试（保守，避免放大失败）。
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof NeedsHumanError || err instanceof ForbiddenActionError) return false
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const code = (err as { code?: unknown })?.code
  const codeStr = typeof code === 'string' ? code : ''
  const hay = `${message} ${codeStr}`
  for (const re of NEVER_RETRY) if (re.test(hay)) return false
  return TRANSIENT.some((re) => re.test(hay))
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 1（不重试）。 */
  attempts?: number
  /** 基础退避毫秒（指数退避），默认 300。 */
  baseDelayMs?: number
  /** 单次退避上限毫秒，默认 2000。 */
  maxDelayMs?: number
  /** 取消信号：中止时不再重试。 */
  signal?: AbortSignal
  /** 每次重试前的回调（记录进度用；不要抛）。 */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void
}

/**
 * 执行 `fn`，仅在 `isRetryable` 判定为瞬时故障时按指数退避重试。
 * 达到上限或遇不可重试错误 → 原样抛出最后一次错误（不吞异常）。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 1))
  const base = Math.max(0, opts.baseDelayMs ?? 300)
  const cap = Math.max(base, opts.maxDelayMs ?? 2000)

  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    if (opts.signal?.aborted) throw new Error('aborted')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i >= attempts || !isRetryable(err) || opts.signal?.aborted) throw err
      const delayMs = Math.min(cap, base * 2 ** (i - 1))
      opts.onRetry?.({ attempt: i, error: err, delayMs })
      await sleep(delayMs, opts.signal)
    }
  }
  throw lastErr
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
