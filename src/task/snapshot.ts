/**
 * task/snapshot.ts — 统一输入快照（§6.6）。
 * 层：orchestration。先建唯一快照，所有平台从它派生；快照只读，改条件=新快照/新任务。
 */
import type { ComparisonConditions, StartInput } from '../price/model.ts'
import { hashObject } from './hash.ts'

/**
 * 由用户输入构造规范化快照。P1 不做地理编码/别名库，city 缺省为上海，lat/lng 用
 * 固定占位（mock 阶段不触网）；真机阶段将接入地理编码（§6.6）。
 */
export function buildSnapshot(input: StartInput): ComparisonConditions {
  const item = input.item.trim()
  const deliverTo = {
    city: input.city ?? '上海',
    lat: 31.2304,
    lng: 121.4737,
  }
  const fixedAtMs = Date.now()
  const base = {
    item,
    qty: 1,
    spec: [] as string[],
    composition: [] as string[],
    deliverTo,
  }
  const hash = hashObject(base)
  return {
    snapshotId: `snap-${hash.slice(0, 12)}`,
    ...base,
    fixedAt: new Date(fixedAtMs).toISOString(),
    hash,
  }
}
