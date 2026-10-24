/**
 * task/runner.ts — 单次比价流程编排（§7，§20-task）。
 * 层：orchestration。只依赖抽象（Driver/Ocr 接口、PlatformStrategy 接口、price 纯函数）。
 *
 * 职责：设备锁内串行驱动各平台 → 产出原始事实 → price 折算 → 分组比价。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Deps, ProgressPort } from '../core/container.ts'
import { withDeviceLock } from '../core/locks.ts'
import { withRetry } from '../core/retry.ts'
import { redactScreenshot } from '../device/redact.ts'
import type {
  CompareOptionsSpec,
  CompareResult,
  ComparisonConditions,
  Item,
  Quote,
  QuoteDraft,
  Store,
} from '../price/model.ts'
import { compare, priceQuote } from '../price/engine.ts'
import { itemScore } from '../price/similarity.ts'
import { applyCrossPlatformExclusivity, evaluateStrategies } from '../price/strategies.ts'
import type { PlatformSavings, StrategySpec } from '../price/strategies.ts'
import type { OptionalSaving } from '../price/model.ts'
import type { PlatformStrategy, RawQuoteFacts } from '../platform/types.ts'
import { platformLine, PHASES } from './progress.ts'

export interface RunPlan {
  taskId: string
  cond: ComparisonConditions
  platforms: PlatformStrategy[]
  options?: CompareOptionsSpec
}

/** 在设备锁内串行驱动所有平台并比价（§7.7 R1：进入前先拿设备锁）。 */
export async function runCompare(
  deps: Deps,
  plan: RunPlan,
  p: ProgressPort,
  signal?: AbortSignal,
): Promise<CompareResult> {
  return withDeviceLock(
    deps.serial,
    async () => {
      // 能力探测：仅当驱动支持（真机 adb）时跑一次，结果写入进度（§3.5.4(1)）。
      // Mock 驱动无 probe，P1 行为不变。
      const probeable = deps.driver as { probe?: () => Promise<unknown> }
      if (typeof probeable.probe === 'function') {
        p.update('能力探测 · 读取设备与页面识别质量')
        try {
          const probe = (await probeable.probe()) as {
            canDump?: boolean
            canScreenshot?: boolean
            quality?: { recommend?: string; treeRichness?: number }
          }
          p.update(
            `能力探测 · dump=${probe.canDump ? 'OK' : 'FAIL'} 截屏=${probe.canScreenshot ? 'OK' : 'FAIL'} 识别建议=${probe.quality?.recommend ?? '?'}`,
          )
        } catch (err) {
          p.update(
            `能力探测失败（继续尝试读价）：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      const drafts: QuoteDraft[] = []
      const savingsGroups: PlatformSavings[] = []
      const nowMs = deps.clock.now()
      const n = plan.platforms.length
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw new Error('cancelled')
        const strategy = plan.platforms[i]!
        p.update(platformLine(i + 1, n, strategy.id, PHASES.opening))
        // 瞬时故障重试（P5）：仅对 adb 掉线 / dump idle 失败等可重试错误；
        // 验证码/支付/业务终态错误由 core/retry 直接抛出（不重试，红线）。
        const facts = await withRetry(
          () =>
            strategy.enterSettlePage(deps.driver, plan.cond, {
              ocr: deps.ocr,
              dataDir: deps.dataDir,
            }),
          {
            attempts: deps.config.task.retryAttempts,
            signal,
            onRetry: ({ attempt, error }) =>
              p.update(
                platformLine(
                  i + 1,
                  n,
                  strategy.id,
                  `瞬时故障重试 #${attempt}（${error instanceof Error ? error.message : String(error)}）`,
                ),
              ),
          },
        )
        p.update(platformLine(i + 1, n, strategy.id, PHASES.settling, verdictOf(facts)))
        const quoteId = `${plan.taskId}:${strategy.id}`
        const bound = await bindEvidence(deps, facts, quoteId)
        const draft = draftFromFacts(facts, strategy.id, plan, deps, quoteId, bound)
        // 平台级策略（§5.1–§5.5）→ 四态 OptionalSaving；与结算页 presumed 红包合并。
        const specs = strategySpecsFor(deps.config, strategy.id)
        const orderAmount = orderAmountOf(facts)
        const configSavings = evaluateStrategies(specs, {
          platform: strategy.id,
          payable: orderAmount,
          now: nowMs,
        })
        savingsGroups.push({ platform: strategy.id, specs, savings: configSavings })
        draft.optionalSavings = mergeSavings(facts.optionalSavings ?? [], configSavings)
        drafts.push(draft)
      }
      // 跨平台谨慎互斥（§5.6）：默认不互斥，仅显式 crossPlatformExclusive 才降级。
      const downgraded = applyCrossPlatformExclusivity(savingsGroups)
      if (downgraded.length > 0) p.update(`策略互斥 · 已按跨平台互斥降级：${downgraded.join(', ')}`)
      p.update('完成 · 正在折算分组比价')
      if (signal?.aborted) throw new Error('cancelled')
      const quotes: Quote[] = drafts.map((d) => priceQuote(d))
      return compare(quotes, plan.cond, { taskId: plan.taskId, now: deps.clock.now() })
    },
    { waitMs: deps.config.task.lockWaitMs, root: deps.lockRoot },
  )
}

function verdictOf(facts: RawQuoteFacts): string {
  return `实付 ¥${facts.payable.toFixed(2)}（${facts.confidence === 'high' ? 'tree 读取' : 'OCR/推算'}）`
}

/** 取某平台配置里的策略（与 price/strategies.StrategySpec 结构对齐）。 */
export function strategySpecsFor(config: Deps['config'], platformId: string): StrategySpec[] {
  const p = config.platforms[platformId]
  return (p?.strategies ?? []) as unknown as StrategySpec[]
}

/** 订单原价（用于门槛判断与 percent 折算基数）：费用合计（非 derived，未减优惠）。 */
function orderAmountOf(facts: RawQuoteFacts): number {
  const gross = facts.fees.filter((f) => f.source !== 'derived').reduce((s, f) => s + f.amount, 0)
  return gross > 0 ? gross : facts.payable
}

/** 合并"结算页 presumed 红包"与"配置策略四态"（按 id 去重，结算页实证优先）。 */
function mergeSavings(fromPage: OptionalSaving[], fromConfig: OptionalSaving[]): OptionalSaving[] {
  const byId = new Map<string, OptionalSaving>()
  for (const s of fromPage) byId.set(s.id, s)
  for (const s of fromConfig) if (!byId.has(s.id)) byId.set(s.id, s)
  return [...byId.values()]
}

/** 原始事实 → 引擎输入草稿（补 evidence / extraction，交给 price 判定）。 */
export interface BoundEvidence {
  dumpPath?: string
  screenshotPath?: string
  redaction: 'none' | 'applied'
  missingReason?: string
}

export function draftFromFacts(
  facts: RawQuoteFacts,
  platform: string,
  plan: RunPlan,
  deps: Deps,
  quoteId: string,
  bound?: BoundEvidence,
): QuoteDraft {
  const now = deps.clock.now()
  const ttlMs = deps.config.evidence.ttlMinutes * 60_000

  const store: Store = {
    name: facts.storeName,
    amapId: facts.storeAmapId,
    matchedScore: 1,
  }
  const item: Item = {
    name: facts.itemName,
    spec: facts.itemSpec,
    qty: facts.qty,
    matchedScore: itemScore(facts.itemName, plan.cond.item),
    composition: facts.composition,
  }

  const deviatedConditions = detectDeviations(facts, plan.cond, item)

  return {
    platform,
    store,
    item,
    fees: facts.fees,
    discounts: facts.discounts,
    payable: facts.payable,
    optionalSavings: facts.optionalSavings,
    deviatedConditions: deviatedConditions.length > 0 ? deviatedConditions : undefined,
    snapshotId: plan.cond.snapshotId,
    snapshotHash: plan.cond.hash,
    extraction: { confidence: facts.confidence, byField: facts.byField },
    evidence: {
      quoteId,
      platform,
      storeName: facts.storeName,
      itemSpec: `${facts.itemName}${facts.itemSpec ? ' ' + facts.itemSpec : ''} x${facts.qty}`,
      qty: facts.qty,
      feeBreakdown: facts.fees,
      rawExtraction: {
        treeDumpPath: bound?.dumpPath,
        // 饿了么 canvas 自绘没有可读控件树，OCR 文本就是原始识别结果（§6.5）。
        ocrText: facts.byField.payable === 'ocr' ? facts.dump : undefined,
        ocrBoxes: facts.ocrWords?.map((w) => ({
          text: w.t,
          confidence: w.c,
          bbox: [w.bbox.x, w.bbox.y, w.bbox.w, w.bbox.h] as [number, number, number, number],
        })),
      },
      screenshotPath: bound?.screenshotPath,
      capturedAt: new Date(now).toISOString(),
      validUntil: new Date(now + ttlMs).toISOString(),
      redaction: bound?.redaction ?? 'none',
      missingReason: bound?.missingReason,
    },
  }
}

/**
 * 证据落盘与脱敏（§6.5 · P5）：
 *  - dump 原样原子写（`evidence/<quoteId>.xml`，权限 600）；
 *  - 截图**默认脱敏**后落盘；无法解码/无法定位敏感区域 → **不落原图**（隐私优先）并记 missingReason；
 *  - 任一步失败都**不抛**（证据是尽力而为），把 missingReason 带上，交 price 层降级。
 */
export async function bindEvidence(
  deps: Deps,
  facts: RawQuoteFacts,
  quoteId: string,
): Promise<BoundEvidence> {
  const dir = join(deps.dataDir, 'evidence')
  const out: BoundEvidence = { redaction: 'none' }
  const gaps: string[] = []
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    out.missingReason = `证据目录创建失败：${err instanceof Error ? err.message : String(err)}`
    return out
  }

  // 1) dump 原始识别结果
  if (facts.dump && facts.byField.payable !== 'ocr') {
    const dumpPath = join(dir, `${quoteId}.xml`)
    try {
      await writeFileAtomic(dumpPath, facts.dump, { mode: 0o600, dirMode: 0o700 })
      out.dumpPath = dumpPath
    } catch (err) {
      gaps.push(`dump 落盘失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 2) 截图（脱敏后落盘）
  if (facts.screenshot && facts.screenshot.length > 0) {
    const shotPath = join(dir, `${quoteId}.png`)
    if (!deps.config.evidence.redact) {
      try {
        await writeFileAtomic(shotPath, facts.screenshot, { mode: 0o600, dirMode: 0o700 })
        out.screenshotPath = shotPath
        out.redaction = 'none'
      } catch (err) {
        gaps.push(`截图落盘失败：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      const r = redactScreenshot(facts.screenshot, facts.dump ?? '')
      if (r.applied && r.png) {
        try {
          await writeFileAtomic(shotPath, r.png, { mode: 0o600, dirMode: 0o700 })
          out.screenshotPath = shotPath
          out.redaction = 'applied'
        } catch (err) {
          gaps.push(`截图落盘失败：${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        // 无法确认脱敏 → 绝不保存原图（隐私红线）。
        gaps.push(`截图未落盘（${r.reason ?? '无法脱敏'}）`)
      }
    }
  }

  if (gaps.length > 0) out.missingReason = gaps.join('；')
  // 最终兜底：完全没有可复核证据（无 dump / 无脱敏图 / 无 OCR 文本）也要如实说明。
  if (!out.dumpPath && !out.screenshotPath && !(facts.byField.payable === 'ocr' && facts.dump)) {
    const w = '证据缺失：无 dump / OCR 文本 / 截图，需人工复核'
    out.missingReason = out.missingReason ? `${out.missingReason}；${w}` : w
  }
  return out
}

/**
 * 快照偏离检测（§6.6）：平台返回的条件若与统一输入快照不一致 → 归入"不可比组"。
 * 目前比对可稳定判定的：数量、规格（若快照固定了规格而平台明确给出不同规格）。
 * 商品名/门店的等价由 price/similarity 在分组时判定，不在此重复。
 */
export function detectDeviations(
  facts: RawQuoteFacts,
  cond: ComparisonConditions,
  item: Item,
): string[] {
  const out: string[] = []
  if (Number.isFinite(facts.qty) && facts.qty !== cond.qty) {
    out.push(`qty: 期望 ${cond.qty} 份，平台为 ${facts.qty} 份`)
  }
  const wantSpec = (cond.spec ?? []).map((s) => s.trim()).filter(Boolean)
  const gotSpec = (facts.itemSpec ?? '').trim()
  if (wantSpec.length > 0 && gotSpec) {
    const ok = wantSpec.some((w) => gotSpec.includes(w) || w.includes(gotSpec))
    if (!ok) out.push(`spec: 期望「${wantSpec.join('/')}」，平台为「${gotSpec}」`)
  }
  void item
  return out
}
