/**
 * price/evidence.ts — 证据 TTL / 完整性 / 缺失降级（docs/module-spec.md §6.5）。
 * 层：pure。时间由调用方注入（不在此取 now）。
 */
import type { Evidence } from './model.ts'

/** 证据是否过期：validUntil 早于 now。无法解析视为过期（保守）。 */
export function isExpired(evidence: Pick<Evidence, 'validUntil'>, now: number | Date): boolean {
  const t = typeof now === 'number' ? now : now.getTime()
  const until = Date.parse(evidence.validUntil)
  if (Number.isNaN(until)) return true
  return until < t
}

/** 证据是否完整：至少有一个可用于复核的原始产出（dump / OCR 文本 / 截图）。 */
export function evidenceComplete(
  evidence: Pick<Evidence, 'rawExtraction' | 'screenshotPath'>,
): boolean {
  const { treeDumpPath, ocrText } = evidence.rawExtraction ?? {}
  return Boolean(treeDumpPath || ocrText || evidence.screenshotPath)
}

/** 给出证据缺失原因（用于 missingReason 降级说明）；完整时返回 undefined。 */
export function evidenceGap(
  evidence: Pick<Evidence, 'rawExtraction' | 'screenshotPath'>,
): string | undefined {
  if (evidenceComplete(evidence)) return undefined
  return '证据缺失：无 dump / OCR 文本 / 截图，需人工复核'
}

/** 距过期剩余毫秒（可能为负）。 */
export function remainingMs(evidence: Pick<Evidence, 'validUntil'>, now: number | Date): number {
  const t = typeof now === 'number' ? now : now.getTime()
  return Date.parse(evidence.validUntil) - t
}
