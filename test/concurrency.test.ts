/**
 * concurrency.test.ts — P1 DoD ④ 并发（§7.7）。
 * 设备锁下两任务串行、不交叉；锁等待超时 → BusyError（→ 503 BUSY）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv } from './p1-env.ts'
import { runCompare } from '../src/task/runner.ts'
import { withDeviceLock } from '../src/core/locks.ts'
import { BusyError } from '../src/core/errors.ts'
import { extractSettleFacts } from '../src/platform/extract.ts'
import { MOCK_SETTLE_PAGES } from '../src/device/mock-data.ts'
import type { PlatformStrategy } from '../src/platform/types.ts'
import type { ComparisonConditions } from '../src/price/model.ts'
import type { ProgressPort } from '../src/core/container.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const noopProgress: ProgressPort = { update: () => {}, append: () => {} }

const cond: ComparisonConditions = {
  snapshotId: 'snap-x',
  item: '香叶 烤鸭饭',
  qty: 1,
  spec: [],
  composition: [],
  deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
  fixedAt: '2026-10-22T12:00:00+08:00',
  hash: 'hash-x',
}

function slowStrategy(id: string, events: string[]): PlatformStrategy {
  return {
    id,
    appId: 'x',
    settleAnchor: 'settle-page',
    selectors: {},
    async enterSettlePage(_driver, c) {
      events.push(`start-${id}`)
      await sleep(30)
      events.push(`end-${id}`)
      return extractSettleFacts(MOCK_SETTLE_PAGES.meituan!, 'meituan', c)
    },
  }
}

test('device lock: two comparisons run serially (no interleaved taps)', async () => {
  const env = await makeEnv()
  try {
    const events: string[] = []
    const planA = { taskId: 'tA', cond, platforms: [slowStrategy('A', events)] }
    const planB = { taskId: 'tB', cond, platforms: [slowStrategy('B', events)] }
    await Promise.all([
      runCompare(env.deps, planA, noopProgress),
      runCompare(env.deps, planB, noopProgress),
    ])
    // 期望：一个完全结束后才轮到另一个（连续，不交叉）。
    assert.equal(events.length, 4)
    const first = events[0]!.split('-')[1]
    assert.deepEqual(events, [
      `start-${first}`,
      `end-${first}`,
      `start-${events[3]!.split('-')[1]}`,
      `end-${events[3]!.split('-')[1]}`,
    ])
    assert.equal(events[1], `end-${first}`)
    assert.equal(events[2]!.startsWith('start-'), true)
    assert.notEqual(events[2]!.split('-')[1], first)
  } finally {
    await env.cleanup()
  }
})

test('lock wait timeout => BusyError (maps to 503 BUSY)', async () => {
  const env = await makeEnv({
    task: {
      stepTimeoutMs: 8000,
      pageTimeoutMs: 20000,
      taskTimeoutMs: 90000,
      lockWaitMs: 200,
      idempotencyTtlMinutes: 30,
    },
  } as never)
  try {
    let release!: () => void
    const held = withDeviceLock(env.deps.serial, () => new Promise<void>((r) => (release = r)), {
      root: env.deps.lockRoot,
    })
    await sleep(30) // 确保第一把锁已拿到
    await assert.rejects(
      () =>
        runCompare(
          env.deps,
          { taskId: 'tc', cond, platforms: [slowStrategy('C', [])] },
          noopProgress,
        ),
      (e: unknown) => e instanceof BusyError,
    )
    release()
    await held
  } finally {
    await env.cleanup()
  }
})
