/**
 * core/locks.ts — 设备锁 / 快照单飞锁 / 资源写锁（§7.7 R1）。
 * 层：infra。**薄封装** `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`，
 * 不自己实现 wx 锁 / PID / ESRCH 接管（§2.2 复用优先）。
 *
 * 固定获取顺序：设备锁 → 快照锁 → 资源写锁，任何路径不得反向获取（R1）。
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { BusyError } from './errors.ts'

/** 锁句柄的根目录（默认落在 `.price-agent/locks/`，仅本地、不入库）。 */
export function defaultLockRoot(cwd = process.cwd()): string {
  return join(cwd, '.price-agent', 'locks')
}

/**
 * 在某个锁文件上串行执行 `fn`；获取超时映射为 `BusyError`（→ 503 BUSY，§7.7 R4）。
 * @param lockFile 目标锁文件绝对路径（库内部用 `<file>.lock` 做 wx 锁）。
 * @param fn 临界区。
 * @param opts.waitMs 等待超时；默认 5s（dev），测试可调小以验证 BUSY。
 */
export async function withLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 5000
  await mkdir(dirname(lockFile), { recursive: true })
  try {
    return await withFileLock(lockFile, fn, { waitMs, signal: opts.signal })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 库在竞争超时抛 "atomic-write: timed out waiting for the writer lock ..."
    if (/timed out waiting for the writer lock/i.test(msg)) {
      throw new BusyError(lockFile)
    }
    throw err
  }
}

/** 设备锁（全局唯一，粒度=一台设备 serial）。 */
export function withDeviceLock<T>(
  serial: string,
  fn: () => Promise<T>,
  opts: { root?: string; waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const root = opts.root ?? defaultLockRoot()
  return withLock(join(root, `device-${sanitize(serial)}.lock`), fn, opts)
}

/** 快照单飞锁（键=snapshot.hash，合并同输入并发请求）。 */
export function withSnapshotLock<T>(
  hash: string,
  fn: () => Promise<T>,
  opts: { root?: string; waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const root = opts.root ?? defaultLockRoot()
  return withLock(join(root, `snapshot-${sanitize(hash)}.lock`), fn, opts)
}

/** 资源写锁（记账/结果文件）。 */
export function withResourceLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  return withLock(path, fn, opts)
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}
