/**
 * test/p1-env.ts — P1 测试公用环境（内存实现，离线、确定性）。
 * 非测试文件本身（不匹配 *.test.ts）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Config, type AppConfig } from '../src/config.ts'
import type { Deps, JobsPort, ProgressPort, TaskDomainSpec } from '../src/core/container.ts'
import { buildCapabilities } from '../src/core/container.ts'
import { FakeClock } from '../src/core/clock.ts'
import type { TaskRecord } from '../src/price/model.ts'

/** 内存版任务领域：实现 Deps 需要的 `tasks.table()` 子集。 */
class MemTable<V extends { [k: string]: unknown }> {
  private m = new Map<string, V>()
  get(key: string): V | undefined {
    return this.m.get(key)
  }
  *entries(): IterableIterator<[string, V]> {
    for (const e of this.m.entries()) yield e
  }
  *keys(): IterableIterator<string> {
    for (const k of this.m.keys()) yield k
  }
  get size(): number {
    return this.m.size
  }
  async put(key: string, value: V): Promise<void> {
    this.m.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.m.delete(key)
  }
  async update(key: string, fn: (cur: V) => V): Promise<V> {
    const cur = this.m.get(key)
    if (cur === undefined) throw new Error('missing-key')
    const next = fn(cur)
    this.m.set(key, next)
    return next
  }
}

class MemDomain {
  private tables = new Map<string, MemTable<Record<string, unknown>>>()
  table<N extends string>(name: N) {
    let t = this.tables.get(name)
    if (!t) {
      t = new MemTable<Record<string, unknown>>()
      this.tables.set(name, t)
    }
    return t
  }
}

/** 可控的 jobs 端口：记录 work 启动；可手动等待其完成。 */
export interface FakeJobs extends JobsPort {
  /** 已启动的 work promise（可 await）。 */
  readonly running: Promise<void>[]
  /** 等待所有已启动 work 结束。 */
  settle(): Promise<void>
  /** 触发对某 taskId 的取消（abort 该任务）。 */
  cancelTask(taskId: string): void
}

export function fakeJobs(): FakeJobs {
  const running: Promise<void>[] = []
  const controllers = new Map<string, AbortController>()
  return {
    running,
    start({ taskId, work }): Promise<string> {
      const controller = new AbortController()
      controllers.set(taskId, controller)
      const progress: ProgressPort = { update: () => {}, append: () => {} }
      const p = work(progress, controller.signal)
      running.push(p)
      return Promise.resolve(taskId)
    },
    cancel(taskId: string): void {
      controllers.get(taskId)?.abort('cancelled')
    },
    cancelTask(taskId: string): void {
      controllers.get(taskId)?.abort('cancelled')
    },
    async settle(): Promise<void> {
      await Promise.allSettled(running)
    },
  }
}

export interface P1Env {
  deps: Deps
  clock: FakeClock
  jobs: FakeJobs
  dataDir: string
  cleanup(): Promise<void>
}

/** 构造一个离线 P1 环境（Mock 驱动 + 内存存储 + 假时钟 + 假 jobs）。 */
export async function makeEnv(over: Partial<AppConfig> = {}): Promise<P1Env> {
  const config = Config({
    device: { driver: 'mock', serial: 'auto' },
    ...over,
  }) as AppConfig
  const dataDir = await mkdtemp(join(tmpdir(), 'price-agent-'))
  const clock = new FakeClock(Date.parse('2026-10-22T12:00:00+08:00'))
  const caps = buildCapabilities(config, { dataDir })
  const jobs = fakeJobs()
  const deps: Deps = {
    ...caps,
    clock,
    jobs,
    tasks: new MemDomain() as unknown as Domain<TaskDomainSpec>,
    config,
    dataDir,
    serial: 'auto',
    lockRoot: join(dataDir, 'locks'),
  }
  return {
    deps,
    clock,
    jobs,
    dataDir,
    async cleanup() {
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/** 读取任务记录（便捷）。 */
export function getRec(deps: Deps, taskId: string): TaskRecord | undefined {
  return deps.tasks.table('tasks').get(taskId) as TaskRecord | undefined
}
