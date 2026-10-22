/**
 * jobs-owner.test.ts — 回归：job 必须带 owner（web 下 controller 按 agent scope 挂）；
 * 且 jobs.start 失败时必须回滚幂等映射，不能把输入永久卡在 queued。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, fakeJobs, getRec } from './p1-env.ts'
import { startTask, getResult } from '../src/task/lifecycle.ts'
import type { JobsPort } from '../src/core/container.ts'

test('owner (exec.agent.id) is propagated to jobs.start', async () => {
  const env = await makeEnv()
  try {
    let captured: string | undefined
    const port: JobsPort = {
      start(spec) {
        captured = spec.owner
        return Promise.resolve(spec.taskId)
      },
      cancel() {},
    }
    env.deps.jobs = port
    await startTask(env.deps, { item: '香叶 烤鸭饭' }, { owner: 'agent-1' })
    assert.equal(captured, 'agent-1')
  } finally {
    await env.cleanup()
  }
})

test('if jobs.start throws, idempotency rolls back and a later start succeeds (no stuck queued)', async () => {
  const env = await makeEnv()
  try {
    const boom: JobsPort = {
      start() {
        throw new Error('background jobs unavailable: no job controller serves this agent')
      },
      cancel() {},
    }
    env.deps.jobs = boom
    await assert.rejects(() => startTask(env.deps, { item: '香叶 烤鸭饭' }))
    // 幂等映射必须被回滚（否则后续同输入会一直命中 queued）
    assert.equal(env.deps.tasks.table('idempotency').size, 0, 'idempotency rolled back')

    // 换成可用 jobs 端口，同输入应能正常新建并完成
    const jobs2 = fakeJobs()
    env.deps.jobs = jobs2
    const r = await startTask(env.deps, { item: '香叶 烤鸭饭' })
    assert.equal(r.status, 'processing')
    await jobs2.settle()
    const got = await getResult(env.deps, r.taskId)
    assert.equal(got.status, 'completed')
    assert.equal(getRec(env.deps, r.taskId)?.status, 'completed')
  } finally {
    await env.cleanup()
  }
})
