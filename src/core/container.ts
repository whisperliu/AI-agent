/**
 * core/container.ts — 依赖装配（§2.1 R2 DI 总线 / §4.3）。
 * 层：infra（装配）。**唯一**决定 mock|adb、tesseract|mock 的地方；其它模块只收接口。
 *
 * 暴露给 task 的 `Deps` 是一组**结构化接口 + 端口**，不直接暴露 ctx.jobs / storageDomain，
 * 以满足 §4.4 R3（tools 不得直连），同时让 task 逻辑可用内存实现完全离线单测。
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { AppConfig } from '../config.ts'
import type { Clock } from './clock.ts'
import { SystemClock } from './clock.ts'
import type { Driver } from '../device/driver.ts'
import { createMockDriver } from '../device/mock.ts'
import { MOCK_SETTLE_PAGES } from '../device/mock-data.ts'
import { createAdbDriver } from '../device/adb.ts'
import type { Ocr } from '../ocr/reader.ts'
import { createMockOcr } from '../ocr/mock.ts'
import { MOCK_OCR_ENTRIES } from '../device/mock-data.ts'
import type { TaskRecord } from '../price/model.ts'

/** 进度端口：屏蔽 `ctx.jobs` 的具体实现（task 只依赖它）。 */
export interface ProgressPort {
  /** 更新"当前进度行"（UI 可实时看到）。 */
  update(line: string): void
  /** 追加一条历史进度（有界）。 */
  append(line: string): void
}

/** 后台任务端口：start 负责真正跑 `work`，并把它与 DSH job 关联。 */
export interface JobsPort {
  /**
   * 启动一个后台任务。`taskId` 为对外稳定任务 id（由 task 层确定性生成，
   * 传入即与 job 记录对齐）。`work` 通过 ProgressPort 汇报进度，并响应 `signal` 取消。
   */
  start(spec: {
    taskId: string
    kind: string
    label: string
    /** 归属会话（= exec.agent.id）。web 下 dsh-tool-jobs 的 controller 按 agent scope 挂载，必须带。 */
    owner?: string
    work: (p: ProgressPort, signal: AbortSignal) => Promise<void>
  }): Promise<string>
  /** 请求取消（对应 job kill），幂等。 */
  cancel(taskId: string): void
}

/** task/* 依赖的注入总线。 */
export interface Deps {
  driver: Driver
  ocr: Ocr
  clock: Clock
  jobs: JobsPort
  /** 任务/幂等持久化领域（storageDomain，schema 校验 + 顺序写）。 */
  tasks: Domain<TaskDomainSpec>
  config: AppConfig
  /** 结果/证据落盘的根目录（.price-agent）。 */
  dataDir: string
  /** 设备 serial（用于设备锁）。 */
  serial: string
  /** 锁文件根目录（默认 `<cwd>/.price-agent/locks`；测试可指向临时目录）。 */
  lockRoot?: string
}

// ── 任务持久化领域（tasks / idempotency 两张表；schema 用 zod，§2.2 复用 storageDomain）──

const TaskRecordSchema = z.object({
  taskId: z.string(),
  idempotencyKey: z.string(),
  status: z.enum([
    'queued',
    'processing',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'expired',
  ]),
  phase: z.string(),
  progress: z.array(z.string()),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  resultPath: z.string().optional(),
  error: z.object({ reason: z.string(), message: z.string() }).optional(),
  runToken: z.string(),
  owner: z.string().optional(),
  validUntil: z.string().optional(),
  consumed: z.boolean().optional(),
})

const IdempotencyRecordSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  snapshotHash: z.string(),
  createdAt: z.string(),
})

export const TaskDomainSpec = defineDomain({
  name: 'price_agent_tasks',
  version: 1,
  tables: {
    tasks: domainTable<string, TaskRecord>(TaskRecordSchema as unknown as z.ZodType<TaskRecord>),
    idempotency: domainTable<
      string,
      { key: string; taskId: string; snapshotHash: string; createdAt: string }
    >(IdempotencyRecordSchema),
  },
})

export type TaskDomainSpec = typeof TaskDomainSpec

/**
 * 按配置组装能力实现（mock|adb、mock|tesseract）。返回不含持久化/任务端口的半成品，
 * 由 index.ts 补上 `tasks`（storageDomain）与 `jobs`（ctx.jobs 适配器）。
 */
export function buildCapabilities(
  config: AppConfig,
  opts: { dataDir: string },
): {
  driver: Driver
  ocr: Ocr
  clock: Clock
  serial: string
  dataDir: string
} {
  const serial = config.device.serial
  const driver =
    config.device.driver === 'adb'
      ? createAdbDriver({
          serial,
          adbPath: config.device.adbPath,
          autoReconnect: config.device.autoReconnect,
          unicodeIme: config.device.unicodeIme || undefined,
          disableAnimations: config.device.disableAnimations,
          stepTimeoutMs: config.task.stepTimeoutMs,
        })
      : createMockDriver({ settlePages: MOCK_SETTLE_PAGES })
  const ocr = createMockOcr(MOCK_OCR_ENTRIES)
  return { driver, ocr, clock: new SystemClock(), serial, dataDir: opts.dataDir }
}
