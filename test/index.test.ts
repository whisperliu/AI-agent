/**
 * index.test.ts — 装配冒烟：apply() 注册 price_agent；defineTool 工厂有效；
 * 通过工具 execute 走完 start → getResult 全链路（用假 ctx 服务，离线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { Config } from '../src/config.ts'
import type { AppConfig } from '../src/config.ts'
import { makeEnv } from './p1-env.ts'

interface Captured {
  def?: {
    name: string
    execute: (a: unknown, e: unknown) => Promise<unknown>
  }
}

function fakeCtx(env: Awaited<ReturnType<typeof makeEnv>>) {
  const captured: Captured = {}
  const dones: Promise<unknown>[] = []
  const ctx = {
    storageDomain: { open: async () => env.deps.tasks },
    jobs: {
      start(spec: { run: (job: unknown) => { done: Promise<unknown>; cancel: () => void } }) {
        const handle = { id: 'job-1', updateProgress: () => {}, append: () => {} }
        const hooks = spec.run(handle)
        dones.push(hooks.done)
        return 'job-1'
      },
    },
    tools: {
      register(def: unknown) {
        captured.def = def as Captured['def']
        return () => {}
      },
    },
    effect(fn: () => () => unknown) {
      fn()
      return { dispose: async () => {} }
    },
  }
  return { ctx, captured, dones }
}

test('apply registers price_agent and the tool runs start→getResult', async () => {
  const env = await makeEnv()
  const dataDir = await mkdtemp(join(tmpdir(), 'price-agent-idx-'))
  const prev = process.env.DSH_PRICE_AGENT_DATA
  process.env.DSH_PRICE_AGENT_DATA = dataDir
  try {
    const config = Config({ device: { driver: 'mock', serial: 'auto' } }) as AppConfig
    const { ctx, captured, dones } = fakeCtx(env)
    await apply(ctx as never, config)
    assert.ok(captured.def, 'tool registered')
    assert.equal(captured.def!.name, 'price_agent')

    const startReply = (await captured.def!.execute(
      { action: 'start', item: '香叶 烤鸭饭' },
      { agent: undefined },
    )) as { reply: { taskId: string } }
    assert.match(startReply.reply.taskId, /^price-compare-/)

    await Promise.allSettled(dones) // 等后台 work 完成

    const got = (await captured.def!.execute(
      { action: 'getResult', taskId: startReply.reply.taskId },
      { agent: undefined },
    )) as { reply: { status: string; result?: { cheapest: { platform: string } | null } } }
    assert.equal(got.reply.status, 'completed')
    assert.equal(got.reply.result?.cheapest?.platform, 'meituan')
  } finally {
    process.env.DSH_PRICE_AGENT_DATA = prev
    await rm(dataDir, { recursive: true, force: true })
    await env.cleanup()
  }
})
