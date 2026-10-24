/**
 * device/capture.ts — 失败取证：dump + 截图落本地（§3.5.1 / P2 DoD）。
 * 层：capability（device）。用 `dsh-atomic-write` 原子写（§2.2 复用），
 * 仅落 `.price-agent/evidence/`，不上传、不打印内容（隐私，AGENTS.md §0 红线 5）。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Driver } from './driver.ts'
import { redactScreenshot } from './redact.ts'

export interface CapturedEvidence {
  dumpPath?: string
  screenshotPath?: string
  /** 截图实际是否脱敏（P5）。 */
  redaction: 'none' | 'applied'
  /** 取证期间出现的错误（不影响主错误上报）。 */
  warning?: string
}

export interface CaptureOptions {
  signal?: AbortSignal
  /**
   * 截图默认脱敏（P5，默认 true）。无法解码/无法定位敏感区域时**不保存原图**，
   * 只在 `warning` 里说明（隐私优先，AGENTS.md §0 红线 5）。
   */
  redact?: boolean
}

/**
 * 抓取当前界面证据到 `dir/<name>.xml` 与 `dir/<name>.png`。
 * 任何一步失败都**不抛出**（取证是尽力而为），把 warning 带上。
 */
export async function captureEvidence(
  driver: Driver,
  dir: string,
  name: string,
  opts: CaptureOptions = {},
): Promise<CapturedEvidence> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const out: CapturedEvidence = { redaction: 'none' }
  const redact = opts.redact ?? true
  let xml = ''
  try {
    await mkdir(dir, { recursive: true })
    const dumpPath = join(dir, `${safe}.xml`)
    xml = await driver.dump()
    await writeFileAtomic(dumpPath, xml, { mode: 0o600, dirMode: 0o700 })
    out.dumpPath = dumpPath
  } catch (err) {
    out.warning = `dump 取证失败：${err instanceof Error ? err.message : String(err)}`
  }
  try {
    const screenshotPath = join(dir, `${safe}.png`)
    const png = await driver.screencap()
    if (!redact) {
      await writeFileAtomic(screenshotPath, png, { mode: 0o600, dirMode: 0o700 })
      out.screenshotPath = screenshotPath
    } else {
      const r = redactScreenshot(png, xml)
      if (r.applied && r.png) {
        await writeFileAtomic(screenshotPath, r.png, { mode: 0o600, dirMode: 0o700 })
        out.screenshotPath = screenshotPath
        out.redaction = 'applied'
      } else {
        const w = `截图未落盘（${r.reason ?? '无法脱敏'}）`
        out.warning = out.warning ? `${out.warning}; ${w}` : w
      }
    }
  } catch (err) {
    const w = `截图取证失败：${err instanceof Error ? err.message : String(err)}`
    out.warning = out.warning ? `${out.warning}; ${w}` : w
  }
  return out
}
