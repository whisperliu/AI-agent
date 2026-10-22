/**
 * idempotency.test.ts — P1 DoD ③ 幂等（§7.6）。
 * 同 key 并发 10 次 = 1 个任务；getResult 可重复只读；同键异参 = 冲突。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv } from './p1-env.ts'
import { startTask, getResult } from '../src/task/lifecycle.ts'
import { computeKey } from '../src/task/idempotency.ts'
import { buildSnapshot } from '../src/task/snapshot.ts'
import { IdempotencyConflictError } from '../src/core/errors.ts'

test('same key 10 concurrent starts => exactly 1 task', async () => {
  const env = await makeEnv()
  try {
    const replies = await Promise.all(
      Array.from({ length: 10 }, () =>
        startTask(env.deps, { item: '香叶 烤鸭饭', idempotencyKey: 'K1' }),
      ),
    )
    const ids = new Set(replies.map((r) => r.taskId))
    assert.equal(ids.size, 1, 'all replies share one taskId')
    await env.jobs.settle()
  } finally {
    await env.cleanup()
  }
})

test('getResult is idempotent read-only (repeatable, does not consume state)', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle()
    const r1 = await getResult(env.deps, start.taskId)
    const r2 = await getResult(env.deps, start.taskId)
    assert.equal(r1.status, 'completed')
    assert.equal(r2.status, 'completed')
    assert.deepEqual(r1.result?.cheapest?.platform, r2.result?.cheapest?.platform)
  } finally {
    await env.cleanup()
  }
})

test('same idempotencyKey with different snapshot => IdempotencyConflictError', async () => {
  const env = await makeEnv()
  try {
    await startTask(env.deps, { item: '香叶 烤鸭饭', idempotencyKey: 'K2', city: '上海' })
    await assert.rejects(
      () => startTask(env.deps, { item: '另一家 牛肉面', idempotencyKey: 'K2', city: '北京' }),
      (err: unknown) => err instanceof IdempotencyConflictError,
    )
    await env.jobs.settle()
  } finally {
    await env.cleanup()
  }
})

test('computeKey is deterministic and excludes time window', () => {
  const a = buildSnapshot({ item: '香叶 烤鸭饭' })
  const b = { ...a, fixedAt: '2099-01-01T00:00:00.000Z' } // 时间不同、hash 不变
  const k1 = computeKey(a, ['meituan', 'eleme'])
  const k2 = computeKey(b, ['eleme', 'meituan'])
  assert.equal(k1, k2, 'key stable across time & platform order')
})
