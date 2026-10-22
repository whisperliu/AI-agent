/**
 * platform/router.ts — 选择本次参与比价的平台（§30）。
 * 层：strategy。只按配置/入参做选择，不改他人实现。
 */
import type { AppConfig } from '../config.ts'
import { meituan } from './meituan.ts'
import { eleme } from './eleme.ts'
import type { PlatformStrategy } from './types.ts'

const REGISTRY: Record<string, PlatformStrategy> = { meituan, eleme }

/** 所有已登记的 platform id。 */
export function knownPlatforms(): string[] {
  return Object.keys(REGISTRY)
}

/**
 * 选出参与本次比价的平台策略。
 * 优先级：入参 platforms（若给）> 配置 enabled。两者都按 platform 排序保证幂等键稳定。
 */
export function selectPlatforms(config: AppConfig, requested?: string[]): PlatformStrategy[] {
  let ids: string[]
  if (requested && requested.length > 0) {
    ids = requested.filter((id) => REGISTRY[id])
  } else {
    ids = Object.keys(config.platforms).filter(
      (id) => config.platforms[id]?.enabled && REGISTRY[id],
    )
  }
  ids.sort()
  return ids.map((id) => REGISTRY[id]!)
}
