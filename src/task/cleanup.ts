/**
 * task/cleanup.ts — 证据/结果按 TTL + 保留上限清理（P5 打磨 · §6.5 / decisions §10-8）。
 * 层：orchestration（只碰本地 `.price-agent/` 目录，不碰设备/存储服务）。
 *
 * 规则（§6.5）：保留"最近 retainMax 条 **或** retainDays 天"，**取先到者**——
 * 即超过天数的一律删；未超天数的按"条"数只留最新 retainMax 组。
 * 证据文件命名 `<quoteId>.xml` / `<quoteId>.png`，同一 quoteId 视为一组。
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface CleanupOptions {
  /** 证据根目录（通常是 `<dataDir>/evidence`）。 */
  dir: string
  /** 保留最多多少组（quoteId）；<=0 表示不按条数限制。 */
  retainMax: number
  /** 保留多少天；<=0 表示不按天数限制。 */
  retainDays: number
  /** 当前时间（毫秒），由调用方注入（可测）。 */
  now: number
}

export interface CleanupStats {
  /** 删除的文件数。 */
  deleted: number
  /** 保留的文件数。 */
  kept: number
  /** 因超期删除的文件数。 */
  expired: number
  /** 因超出保留上限删除的文件数。 */
  overLimit: number
}

interface Group {
  key: string
  files: { path: string; mtime: number }[]
  newest: number
}

/**
 * 清理目录里的证据文件。目录不存在视为"无需清理"（返回 0，不抛）。
 * 任何单个文件删除失败不中断整体（尽力而为，统计里不计数）。
 */
export async function cleanupEvidence(opts: CleanupOptions): Promise<CleanupStats> {
  const stats: CleanupStats = { deleted: 0, kept: 0, expired: 0, overLimit: 0 }
  let names: string[]
  try {
    names = await readdir(opts.dir)
  } catch {
    return stats
  }
  const groups = new Map<string, Group>()
  for (const name of names) {
    if (!name.endsWith('.xml') && !name.endsWith('.png')) continue
    const path = join(opts.dir, name)
    let mtime: number
    try {
      const st = await stat(path)
      if (!st.isFile()) continue
      mtime = st.mtimeMs
    } catch {
      continue
    }
    const key = name.replace(/\.(xml|png)$/, '')
    const g = groups.get(key) ?? { key, files: [], newest: 0 }
    g.files.push({ path, mtime })
    g.newest = Math.max(g.newest, mtime)
    groups.set(key, g)
  }

  const ageLimitMs = opts.retainDays > 0 ? opts.retainDays * 24 * 60 * 60_000 : Infinity
  // 先按天数删（严格超期才删，避免边界抖动）。
  const survivors: Group[] = []
  for (const g of groups.values()) {
    if (opts.now - g.newest > ageLimitMs) {
      for (const f of g.files) {
        if (await tryUnlink(f.path)) {
          stats.deleted++
          stats.expired++
        }
      }
    } else {
      survivors.push(g)
    }
  }

  // 再按条数保留最新（按组的最新 mtime 降序）。
  survivors.sort((a, b) => b.newest - a.newest)
  for (let i = 0; i < survivors.length; i++) {
    const g = survivors[i]!
    if (opts.retainMax > 0 && i >= opts.retainMax) {
      for (const f of g.files) {
        if (await tryUnlink(f.path)) {
          stats.deleted++
          stats.overLimit++
        }
      }
    } else {
      stats.kept += g.files.length
    }
  }
  return stats
}

/** 清理过期的结果文件（`<dataDir>/results/*.json{,.sha256}`），只删超 retainDays 的。 */
export async function cleanupResults(opts: CleanupOptions): Promise<CleanupStats> {
  const stats: CleanupStats = { deleted: 0, kept: 0, expired: 0, overLimit: 0 }
  let names: string[]
  try {
    names = await readdir(opts.dir)
  } catch {
    return stats
  }
  const ageLimitMs = opts.retainDays > 0 ? opts.retainDays * 24 * 60 * 60_000 : Infinity
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.sha256') && !name.endsWith('.sha256'))
      continue
    const path = join(opts.dir, name)
    try {
      const st = await stat(path)
      if (!st.isFile()) continue
      if (opts.now - st.mtimeMs > ageLimitMs) {
        if (await tryUnlink(path)) {
          stats.deleted++
          stats.expired++
        }
      } else {
        stats.kept++
      }
    } catch {
      continue
    }
  }
  return stats
}

async function tryUnlink(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}
