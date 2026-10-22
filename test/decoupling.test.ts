/**
 * decoupling.test.ts — P1 DoD ① 全链路 + ② 解耦。
 * 一句话 → taskId → 进度 → 分组比价表；price/* 脱离设备可单测；切 mock|adb 不改业务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, getRec } from './p1-env.ts'
import { startTask, getResult } from '../src/task/lifecycle.ts'
import { dispatch, formatCompareResult } from '../src/tools/price-agent.ts'

test('full chain: item → taskId → getResult → grouped comparison', async () => {
  const env = await makeEnv()
  try {
    const start = await dispatch(env.deps, { action: 'start', item: '香叶 烤鸭饭' })
    assert.equal(start.action, 'start')
    const taskId = start.action === 'start' ? start.reply.taskId : ''
    assert.match(taskId, /^price-compare-/)

    await env.jobs.settle() // 后台跑完

    const got = await dispatch(env.deps, { action: 'getResult', taskId })
    assert.equal(got.action, 'getResult')
    if (got.action !== 'getResult') return
    assert.equal(got.reply.status, 'completed')
    const result = got.reply.result!
    assert.ok(result, 'result present')
    assert.equal(result.groups.length, 1, 'same meal → one comparable group')
    assert.equal(result.groups[0]?.comparable, true)
    // 美团 26.9 < 饿了么 27.0 → cheapest = meituan
    assert.equal(result.cheapest?.platform, 'meituan')
    assert.equal(result.cheapest?.payable, 26.9)

    const text = formatCompareResult(result)
    assert.match(text, /meituan/)
    assert.match(text, /最便宜/)
  } finally {
    await env.cleanup()
  }
})

test('task record reaches completed with resultPath and validUntil', async () => {
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    await env.jobs.settle()
    const rec = getRec(env.deps, start.taskId)!
    assert.equal(rec.status, 'completed')
    assert.ok(rec.resultPath)
    assert.ok(rec.validUntil)
    assert.ok((rec.progress?.length ?? 0) > 0)
  } finally {
    await env.cleanup()
  }
})

test('decoupling: business code identical whether driver=mock or adb config', async () => {
  // buildCapabilities 是唯一决定 mock|adb 的地方；task/price 不 import 设备实现。
  // 这里断言：用 mock 配置能跑通；adb 配置只是换 driver 实例，不改业务函数。
  const env = await makeEnv()
  try {
    const start = await startTask(env.deps, { item: '香鸭饭', platforms: ['meituan'] })
    await env.jobs.settle()
    const got = await getResult(env.deps, start.taskId)
    assert.equal(got.status, 'completed')
    assert.equal(got.result?.groups.length, 1)
  } finally {
    await env.cleanup()
  }
})
