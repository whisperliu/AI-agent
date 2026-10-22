/**
 * task/lifecycle.ts — 开始 / 取消 / 重取 / 重启恢复 / 过期（§7.5、§7.6、§7.7）。
 * 层：orchestration。对外只暴露 startTask/getResult/listTasks/cancel（§4.4 task 公开 API）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Deps, ProgressPort } from '../core/container.ts'
import {
  BusyError,
  IdempotencyConflictError,
  NeedsHumanError,
  StateAssertionError,
  TaskNotFoundError,
} from '../core/errors.ts'
import type {
  CancelReply,
  CompareResult,
  ComparisonConditions,
  GetResultReply,
  StartInput,
  StartReply,
  TaskFailureReason,
  TaskRecord,
  TaskStatus,
  TaskSummary,
} from '../price/model.ts'
import { selectPlatforms } from '../platform/router.ts'
import { runCompare } from './runner.ts'
import { buildSnapshot } from './snapshot.ts'
import { assertSameSnapshot, computeKey } from './idempotency.ts'
import {
  deleteIdempotency,
  getIdempotency,
  getTask,
  listTaskRecords,
  putIdempotency,
  saveTask,
} from './store.ts'
import { sha256 } from './hash.ts'

/** 进程内活跃任务登记（崩溃恢复里区分"processing 但是否有活进程"）。 */
const activeTasks = new Set<string>()

/** 进度行历史上限（有界，§7.5(1)）。 */
const MAX_PROGRESS_LINES = 50

export interface StartOptions {
  /** owner（会话 id），用于 job 归属与 listTasks 过滤。 */
  owner?: string
}

/** 启动一次比价任务（幂等，§7.6 R3）。 */
export async function startTask(
  deps: Deps,
  input: StartInput,
  opts: StartOptions = {},
): Promise<StartReply> {
  const cond = buildSnapshot(input)
  const strategies = selectPlatforms(deps.config, input.platforms)
  const platformIds = strategies.map((s) => s.id)
  const key = input.idempotencyKey ?? computeKey(cond, platformIds, input.options)

  // 幂等检查：先查键（含 TTL），命中则复用；同键异 hash → 409。
  // force=true 时忽略既有映射（卡死/失败态重跑，§7.6 R3）。
  const existing = getIdempotency(deps, key)
  if (existing && input.force) {
    await deleteIdempotency(deps, key)
  } else if (existing) {
    const ageMin = (deps.clock.now() - Date.parse(existing.createdAt)) / 60_000
    const expired = ageMin > deps.config.task.idempotencyTtlMinutes
    if (!expired) {
      assertSameSnapshot(existing, cond)
      const rec = getTask(deps, existing.taskId)
      const status = rec?.status ?? 'processing'
      const message =
        status === 'failed' || status === 'cancelled'
          ? `同输入上次未成功（${status}）；如需重跑请加 force=true`
          : '同输入已有任务，已复用（不重复执行）'
      return { taskId: existing.taskId, status, message }
    }
    await deleteIdempotency(deps, key)
  }

  // 首次：先写"键→taskId"映射与任务记录（先落盘再执行，§7.6 R3 / §7.5(1)）。
  const taskId = `price-compare-${sha256(key + (input.force ? `\u0000force\u0000${deps.clock.now()}` : '')).slice(0, 16)}`
  const runToken = sha256(`${taskId}\u0000${deps.clock.now()}\u0000${Math.random()}`)
  const createdAt = deps.clock.iso()
  await putIdempotency(deps, { key, taskId, snapshotHash: cond.hash, createdAt })
  await saveTask(deps, {
    taskId,
    idempotencyKey: key,
    status: 'queued',
    phase: 'queued',
    progress: [],
    createdAt,
    runToken,
    owner: opts.owner,
  })

  // 启动后台 job（异步返回 taskId，绝不阻塞，§7.4）。
  // 若启动失败（如缺 job controller），必须回滚已写下的幂等映射 + 记录，
  // 否则该输入会被永久卡在 queued（幂等命中却永不执行）。
  try {
    await deps.jobs.start({
      taskId,
      kind: 'price-compare',
      label: `比价: ${input.item}`,
      owner: opts.owner,
      work: (p, signal) => runTask(deps, { taskId, runToken, cond, strategies, input, p, signal }),
    })
  } catch (err) {
    await deleteIdempotency(deps, key)
    await patch(deps, taskId, {
      status: 'failed',
      phase: 'failed',
      finishedAt: deps.clock.iso(),
      error: {
        reason: 'error',
        message: `后台任务启动失败：${err instanceof Error ? err.message : String(err)}`,
      },
    })
    throw err
  }

  return { taskId, status: 'processing', message: '已开始比价，完成后自动推送结果' }
}

interface RunTaskParams {
  taskId: string
  runToken: string
  cond: ComparisonConditions
  strategies: ReturnType<typeof selectPlatforms>
  input: StartInput
  p: ProgressPort
  signal?: AbortSignal
}

/** 后台执行体：状态推进 + 结果原子写 + 终态落库（§7.5）。 */
async function runTask(deps: Deps, params: RunTaskParams): Promise<void> {
  const { taskId, runToken, cond, strategies, input, p, signal } = params
  const lines: string[] = []
  const port: ProgressPort = {
    update: (line) => p.update(line),
    append: (line) => {
      lines.push(line)
      if (lines.length > MAX_PROGRESS_LINES) lines.shift()
      p.append(line)
    },
  }

  activeTasks.add(taskId)
  try {
    await patch(deps, taskId, {
      status: 'processing',
      phase: 'processing',
      startedAt: deps.clock.iso(),
    })
    emit(port, '开始比价…')
    const result = await runCompare(
      deps,
      { taskId, cond, platforms: strategies, options: input.options },
      port,
      signal,
    )

    // 结果原子写文件（§7.5(5)）：写成功后才把记录标 completed。
    const resultPath = await writeResult(deps, taskId, runToken, result)
    const validUntil = new Date(
      deps.clock.now() + deps.config.evidence.ttlMinutes * 60_000,
    ).toISOString()
    await patch(deps, taskId, {
      status: 'completed',
      phase: 'done',
      finishedAt: deps.clock.iso(),
      resultPath,
      validUntil,
      progress: lines,
    })
    emit(port, '完成：已生成分组比价结果')
  } catch (err) {
    const cur = getTask(deps, taskId)
    if (cur && (cur.status === 'cancelled' || cur.status === 'expired')) {
      // 已被取消/过期：保留终态，不覆盖为 failed（取消确认优先，§7.5(4)）。
      return
    }
    if (signal?.aborted) {
      // 直接 job_kill（绕过 price_agent.cancel）也视为取消（§7.2）。
      await patch(deps, taskId, {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: deps.clock.iso(),
      })
      return
    }
    const { reason, message } = classifyError(err)
    await patch(deps, taskId, {
      status: 'failed',
      phase: 'failed',
      finishedAt: deps.clock.iso(),
      error: { reason, message },
      progress: lines,
    })
    emit(port, `失败：${message}`)
  } finally {
    activeTasks.delete(taskId)
  }
}

/** 读取结果（幂等只读，§7.6 R2）。过期 → expired（§7.5(7)）。 */
export async function getResult(deps: Deps, taskId: string): Promise<GetResultReply> {
  const rec = getTask(deps, taskId)
  if (!rec) throw new TaskNotFoundError(taskId)

  if (rec.status === 'expired') return { taskId, status: 'expired', note: '结果已过期，请重新核价' }

  if (rec.status === 'completed' && rec.resultPath) {
    if (rec.validUntil && Date.parse(rec.validUntil) < deps.clock.now()) {
      await patch(deps, taskId, { status: 'expired', consumed: true })
      return { taskId, status: 'expired', note: '结果已过期，请重新核价' }
    }
    const result = await readVerifiedResult(rec)
    await patch(deps, taskId, { consumed: true })
    return { taskId, status: 'completed', result }
  }

  return { taskId, status: rec.status, error: rec.error }
}

/** 列出未消费的已完成任务（补取，§7.5(5)）。 */
export function listTasks(deps: Deps, owner?: string): TaskSummary[] {
  return listTaskRecords(deps, owner)
    .filter((r) => r.status === 'completed' && !r.consumed)
    .map((r) => ({
      taskId: r.taskId,
      status: r.status,
      phase: r.phase,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    }))
}

/** 取消（幂等，§7.6 R2）。 */
export async function cancel(deps: Deps, taskId: string): Promise<CancelReply> {
  const rec = getTask(deps, taskId)
  if (!rec) throw new TaskNotFoundError(taskId)
  if (isTerminal(rec.status)) {
    return { taskId, outcome: 'already-finished', status: rec.status }
  }
  deps.jobs.cancel(taskId)
  await patch(deps, taskId, {
    status: 'cancelled',
    phase: 'cancelled',
    finishedAt: deps.clock.iso(),
  })
  return { taskId, outcome: 'cancelled', status: 'cancelled' }
}

/** 重启恢复：processing/queued 但无活进程 → failed(interrupted)（§7.5(6)）。 */
export async function recoverOnStartup(deps: Deps): Promise<number> {
  let fixed = 0
  for (const rec of listTaskRecords(deps)) {
    if ((rec.status === 'processing' || rec.status === 'queued') && !activeTasks.has(rec.taskId)) {
      await patch(deps, rec.taskId, {
        status: 'failed',
        phase: 'failed',
        error: { reason: 'interrupted', message: '任务在进程重启后中断' },
        finishedAt: deps.clock.iso(),
      })
      fixed++
    }
  }
  return fixed
}

// ── 内部工具 ─────────────────────────────────────────────

function emit(p: ProgressPort, line: string): void {
  p.append(line)
  p.update(line)
}

async function patch(deps: Deps, taskId: string, fields: Partial<TaskRecord>): Promise<void> {
  const cur = getTask(deps, taskId)
  if (!cur) return
  await saveTask(deps, { ...cur, ...fields })
}

async function writeResult(
  deps: Deps,
  taskId: string,
  runToken: string,
  result: CompareResult,
): Promise<string> {
  const payload = JSON.stringify({ runToken, result })
  const path = join(deps.dataDir, 'results', `${taskId}.json`)
  await writeFileAtomic(path, payload, { mode: 0o600, dirMode: 0o700 })
  await writeFileAtomic(`${path}.sha256`, sha256(payload), { mode: 0o600, dirMode: 0o700 })
  return path
}

async function readVerifiedResult(rec: TaskRecord): Promise<CompareResult> {
  const payload = await readFile(rec.resultPath!, 'utf8')
  const checksum = await readFile(`${rec.resultPath}.sha256`, 'utf8').catch(() => '')
  if (checksum && sha256(payload) !== checksum.trim()) {
    throw new Error('结果校验失败（checksum 不匹配），结果不可用')
  }
  const parsed = JSON.parse(payload) as { runToken: string; result: CompareResult }
  if (parsed.runToken !== rec.runToken) {
    throw new Error('结果 runToken 不匹配（可能来自已取消/过期运行），结果不可用')
  }
  return parsed.result
}

function classifyError(err: unknown): { reason: TaskFailureReason; message: string } {
  if (err instanceof NeedsHumanError)
    return { reason: 'needs_human', message: `需要人工介入：${err.reason}` }
  if (err instanceof StateAssertionError)
    return { reason: 'state', message: `页面状态断言失败：${err.expected}` }
  if (err instanceof BusyError) return { reason: 'busy', message: `设备忙：${err.resource}` }
  if (err instanceof IdempotencyConflictError) return { reason: 'error', message: '幂等键冲突' }
  const message = err instanceof Error ? err.message : String(err)
  return { reason: 'error', message }
}

function isTerminal(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'expired'
}
