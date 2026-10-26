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
import { dispatch, toLosslessJson } from '../src/tools/price-agent.ts'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'

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

// P5 回归：DSH 严格拒绝 undefined，`getResult`/`listTasks` 的可选字段缺省曾让整份工具输出被判
// `invalid output: value is not lossless JSON`（模型拿不到结果，真机比价"跑完但取不回"）。
test('toLosslessJson strips undefined (recursively) but keeps falsy 0/false/""', () => {
  const dirty = {
    a: 1,
    note: undefined,
    error: undefined,
    nested: { x: undefined, y: 0, z: false, s: '', arr: [1, undefined, 0] },
  }
  const clean = toLosslessJson(dirty) as Record<string, unknown>
  assert.ok(isJsonValue(clean), 'cleaned value must be lossless JSON')
  assert.equal('note' in clean, false)
  const nested = clean.nested as Record<string, unknown>
  assert.equal('x' in nested, false)
  assert.equal(nested.y, 0)
  assert.equal(nested.z, false)
  assert.equal(nested.s, '')
  // JSON.stringify 对数组内 undefined 的语义是转 null（对象字段才丢弃），均为合法 lossless JSON。
  assert.deepEqual(nested.arr, [1, null, 0])
})

test('dispatch(getResult) completed reply is lossless JSON (regression: undefined note)', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle()
    // 修复前：evidenceDowngradeNote 返回 undefined → reply 带 note:undefined → 非 lossless。
    const reply = await dispatch(env.deps, { action: 'getResult', taskId: start.taskId })
    assert.ok(isJsonValue(reply), 'getResult completed reply must be lossless JSON')
    assert.equal((reply as { action: string }).action, 'getResult')
    assert.ok((reply as { reply: { result?: unknown } }).reply.result, 'result present')
  } finally {
    await env.cleanup()
  }
})

test('dispatch(getResult) non-terminal reply is lossless JSON (regression: undefined result/note)', async () => {
  const env = await makeEnv()
  try {
    // 构造一个未完成任务 → getResult 走 rec.status 分支，reply 带 error:undefined / result:undefined。
    await env.deps.tasks.table('tasks').put('price-compare-running1', {
      taskId: 'price-compare-running1',
      idempotencyKey: 'k2',
      status: 'processing',
      phase: 'processing',
      progress: [],
      createdAt: env.clock.iso(),
      runToken: 'rt2',
    })
    const reply = await dispatch(env.deps, {
      action: 'getResult',
      taskId: 'price-compare-running1',
    })
    assert.ok(isJsonValue(reply), 'non-terminal getResult reply must be lossless JSON')
    assert.equal((reply as { reply: { status: string } }).reply.status, 'processing')
  } finally {
    await env.cleanup()
  }
})

test('dispatch(listTasks) reply is lossless JSON (regression: undefined finishedAt)', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle()
    // 人为制造一条无 finishedAt 的已完成记录，覆盖可选字段缺省。
    const rec = getRec(env.deps, start.taskId)!
    await env.deps.tasks.table('tasks').put(start.taskId, { ...rec, finishedAt: undefined })
    const reply = await dispatch(env.deps, { action: 'listTasks' })
    assert.ok(isJsonValue(reply), 'listTasks reply must be lossless JSON')
  } finally {
    await env.cleanup()
  }
})
