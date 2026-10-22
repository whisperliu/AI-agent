/**
 * task/idempotency.ts — 幂等键与映射（§7.6）。
 * 层：orchestration。
 *  R1 键 = sha256( snapshot.hash ‖ platformSet(排序) ‖ taskOptionsHash )，键内不含时间窗。
 *  冲突：同 key 但 snapshot.hash 不同 → IdempotencyConflictError（409）。
 */
import type { CompareOptionsSpec, ComparisonConditions } from '../price/model.ts'
import { IdempotencyConflictError } from '../core/errors.ts'
import { hashObject, sha256, stableStringify } from './hash.ts'

/** 影响结果的任务选项 hash（不含平台集，平台集单独参与）。 */
export function optionsHash(options?: CompareOptionsSpec): string {
  return hashObject({
    maxResults: options?.maxResults ?? null,
    useOcr: options?.useOcr ?? false,
  })
}

/** 计算系统幂等键（不含时间窗，§7.6 R1）。 */
export function computeKey(
  snapshot: ComparisonConditions,
  platformIds: string[],
  options?: CompareOptionsSpec,
): string {
  const platformSet = [...platformIds].sort().join(',')
  return sha256(`${snapshot.hash}\u0000${platformSet}\u0000${optionsHash(options)}`)
}

/** 校验同 key 记录的 snapshotHash 是否一致；不一致抛冲突。 */
export function assertSameSnapshot(
  existing: { snapshotHash: string },
  snapshot: ComparisonConditions,
): void {
  if (existing.snapshotHash !== snapshot.hash) {
    throw new IdempotencyConflictError(snapshot.hash)
  }
}

/** 便于测试/调试：展示参与哈希的原始串。 */
export function keyMaterial(
  snapshot: ComparisonConditions,
  platformIds: string[],
  options?: CompareOptionsSpec,
): string {
  const platformSet = [...platformIds].sort().join(',')
  return stableStringify({ hash: snapshot.hash, platformSet, options: options ?? null })
}
