/**
 * retry.test.ts — P5 瞬时异常重试（§7.5(3)）+ 红线：安全类错误绝不重试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRetryable, withRetry } from '../src/core/retry.ts'
import { ForbiddenActionError, NeedsHumanError, StateAssertionError } from '../src/core/errors.ts'

test('isRetryable: transient adb/dump errors are retryable', () => {
  assert.equal(isRetryable(new Error('device offline')), true)
  assert.equal(isRetryable(new Error('uiautomator dump 输出不含 hierarchy')), true)
  assert.equal(isRetryable(new Error('could not get idle state')), true)
  assert.equal(isRetryable(new Error('screencap 失败：error: closed')), true)
  assert.equal(isRetryable(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })), true)
})

test('isRetryable: captcha/login/forbidden are NEVER retryable (red-line)', () => {
  assert.equal(isRetryable(new NeedsHumanError('captcha')), false)
  assert.equal(isRetryable(new NeedsHumanError('login')), false)
  assert.equal(isRetryable(new ForbiddenActionError('提交订单')), false)
  // 即便文案里带 timeout，安全类也不重试。
  assert.equal(isRetryable(new NeedsHumanError('risk-control')), false)
})

test('isRetryable: business terminal errors are not retryable', () => {
  assert.equal(isRetryable(new StateAssertionError('expect settle')), false)
  assert.equal(isRetryable(new Error('幂等键冲突')), false)
})

test('withRetry: retries transient error then succeeds', async () => {
  let n = 0
  const value = await withRetry(
    async () => {
      n++
      if (n < 3) throw new Error('device offline')
      return 'ok'
    },
    { attempts: 3, baseDelayMs: 1 },
  )
  assert.equal(value, 'ok')
  assert.equal(n, 3)
})

test('withRetry: does not retry captcha (throws immediately)', async () => {
  let n = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          n++
          throw new NeedsHumanError('captcha')
        },
        { attempts: 5, baseDelayMs: 1 },
      ),
    NeedsHumanError,
  )
  assert.equal(n, 1) // 只尝试一次
})

test('withRetry: stops after attempts and rethrows last error', async () => {
  let n = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          n++
          throw new Error('device offline')
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
    /device offline/,
  )
  assert.equal(n, 2)
})

test('withRetry: onRetry reports attempt; aborted signal stops retry', async () => {
  const seen: number[] = []
  const ac = new AbortController()
  let n = 0
  await assert.rejects(() =>
    withRetry(
      async () => {
        n++
        ac.abort() // 首次失败后即取消
        throw new Error('device offline')
      },
      {
        attempts: 5,
        baseDelayMs: 1,
        signal: ac.signal,
        onRetry: ({ attempt }) => seen.push(attempt),
      },
    ),
  )
  assert.equal(n, 1)
  assert.deepEqual(seen, [])
})
