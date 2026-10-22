/**
 * task/store.ts — 任务持久化映射（§7.5(1)）。
 * 层：orchestration。**薄封装** `ctx.storageDomain` 的 `tasks` / `idempotency` 表，
 * 只做"领域模型 ↔ 表记录"的映射，不自己读写文件（§2.2）。
 */
import type { IdempotencyRecord, TaskRecord } from '../price/model.ts'
import type { Deps } from '../core/container.ts'

/** 保存/更新一条任务记录。 */
export async function saveTask(deps: Deps, rec: TaskRecord): Promise<void> {
  await deps.tasks.table('tasks').put(rec.taskId, rec)
}

/** 读取任务记录。 */
export function getTask(deps: Deps, taskId: string): TaskRecord | undefined {
  return deps.tasks.table('tasks').get(taskId)
}

/** 列出任务（可按 owner 过滤）。 */
export function listTaskRecords(deps: Deps, owner?: string): TaskRecord[] {
  const out: TaskRecord[] = []
  for (const [, rec] of deps.tasks.table('tasks').entries()) {
    if (!owner || rec.owner === owner) out.push(rec)
  }
  return out
}

/** 读幂等映射。 */
export function getIdempotency(deps: Deps, key: string): IdempotencyRecord | undefined {
  const rec = deps.tasks.table('idempotency').get(key)
  return rec as IdempotencyRecord | undefined
}

/** 写幂等映射（先落盘再执行，§7.6 R3）。 */
export async function putIdempotency(deps: Deps, rec: IdempotencyRecord): Promise<void> {
  await deps.tasks.table('idempotency').put(rec.key, rec)
}

/** 删除幂等映射（TTL 清理 / force 重跑）。 */
export async function deleteIdempotency(deps: Deps, key: string): Promise<boolean> {
  return deps.tasks.table('idempotency').delete(key)
}
