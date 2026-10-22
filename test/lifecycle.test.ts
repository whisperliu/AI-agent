/**
 * lifecycle.test.ts — P1 DoD ⑤取消 / ⑥重取 / ⑦过期 / 重启恢复 / 已知错误（§7.5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, getRec } from './p1-env.ts'
import { startTask, getResult, cancel, recoverOnStartup, listTasks } from '../src/task/lifecycle.ts'
import { TaskNotFoundError } from '../src/core/errors.ts'
import { createMockDriver } from '../src/device/mock.ts'
import { MOCK_SETTLE_PAGES } from '../src/device/mock-data.ts'
import { dispatch } from '../src/tools/price-agent.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('cancel while running => status cancelled (not overwritten to failed)', async () => {
  const env = await makeEnv()
  try {
    // 慢驱动：让后台 work 在 cancel 时仍在跑。
    env.deps.driver = createMockDriver({ settlePages: MOCK_SETTLE_PAGES, delayMs: 60 })
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭', idempotencyKey: 'CANCEL1' })
    await sleep(10) // 让 work 进入运行
    const c = await cancel(env.deps, start.taskId)
    assert.equal(c.status, 'cancelled')
    await env.jobs.settle() // 让子步骤停止并退出
    const rec = getRec(env.deps, start.taskId)!
    assert.equal(rec.status, 'cancelled', 'cancel acknowledgement not overwritten')
  } finally {
    await env.cleanup()
  }
})

test('dispatch validates start requires item', async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(() => dispatch(env.deps, { action: 'start', item: '   ' }))
  } finally {
    await env.cleanup()
  }
})

test('cancel an unknown task => TaskNotFoundError', async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(
      () => cancel(env.deps, 'nope'),
      (e: unknown) => e instanceof TaskNotFoundError,
    )
  } finally {
    await env.cleanup()
  }
})

test('cancel is idempotent: second cancel returns already-finished', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle() // completed
    const c1 = await cancel(env.deps, start.taskId)
    assert.equal(c1.outcome, 'already-finished')
    assert.equal(c1.status, 'completed')
    const c2 = await cancel(env.deps, start.taskId)
    assert.equal(c2.outcome, 'already-finished')
  } finally {
    await env.cleanup()
  }
})

test('result expires after evidence TTL => getResult returns expired', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle()
    const ok = await getResult(env.deps, start.taskId)
    assert.equal(ok.status, 'completed')
    // 推进时间超过 evidence.ttlMinutes(10)
    env.clock.advance(11 * 60_000)
    const expired = await getResult(env.deps, start.taskId)
    assert.equal(expired.status, 'expired')
    assert.equal(expired.result, undefined)
  } finally {
    await env.cleanup()
  }
})

test('startup recovery marks processing-without-process as failed(interrupted)', async () => {
  const env = await makeEnv()
  try {
    // 直接构造一条 processing 记录（模拟崩溃残留）
    await env.deps.tasks.table('tasks').put('price-compare-deadbeef', {
      taskId: 'price-compare-deadbeef',
      idempotencyKey: 'k',
      status: 'processing',
      phase: 'processing',
      progress: [],
      createdAt: env.clock.iso(),
      runToken: 'rt',
    })
    const fixed = await recoverOnStartup(env.deps)
    assert.equal(fixed, 1)
    assert.equal(getRec(env.deps, 'price-compare-deadbeef')?.status, 'failed')
    assert.equal(getRec(env.deps, 'price-compare-deadbeef')?.error?.reason, 'interrupted')
  } finally {
    await env.cleanup()
  }
})

test('listTasks only returns unconsumed completed tasks', async () => {
  const env = await makeEnv()
  try {
    const a = await startTask(env.deps, { item: '香叶 烤鸭饭', idempotencyKey: 'A' })
    await env.jobs.settle()
    const before = listTasks(env.deps)
    assert.ok(before.some((t) => t.taskId === a.taskId))
    await getResult(env.deps, a.taskId) // consume
    const after = listTasks(env.deps)
    assert.ok(!after.some((t) => t.taskId === a.taskId))
  } finally {
    await env.cleanup()
  }
})
