/**
 * task/hash.ts — 确定性哈希（幂等键 / 快照 hash / 结果校验和，§7.6 R1）。
 * 层：orchestration。使用 node:crypto（task 层允许）。
 */
import { createHash } from 'node:crypto'

/** 稳定序列化：对象键递归排序，确保同内容同串。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortValue(o[k])
    return out
  }
  return v
}

/** sha256 hex。 */
export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** 对象的稳定哈希。 */
export function hashObject(v: unknown): string {
  return sha256(stableStringify(v))
}
