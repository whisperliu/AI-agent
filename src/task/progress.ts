/**
 * task/progress.ts — 进度阶段与状态机（§7.3）。
 * 层：orchestration。只定义阶段常量与"往 sink 写一行"的纯辅助，不碰 UI。
 */
import type { ProgressPort } from '../core/container.ts'

/** 进度阶段（平台级子状态）。 */
export const PHASES = {
  queued: '排队中',
  opening: '打开 App',
  searching: '搜索',
  settling: '进入结算页',
  pricing: '折算',
  done: '完成',
} as const

/** 往进度端口写一行（同时更新当前行与历史）。 */
export function emit(p: ProgressPort, line: string): void {
  p.append(line)
  p.update(line)
}

/** 生成"第 i/n 个平台 · 阶段"格式的进度行（§7.3）。 */
export function platformLine(
  i: number,
  n: number,
  platform: string,
  phase: string,
  tail = 'OK',
): string {
  return `[${i}/${n}] ${platform} · ${phase} … ${tail}`
}
