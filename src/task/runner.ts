/**
 * task/runner.ts — 单次比价流程编排（§7，§20-task）。
 * 层：orchestration。只依赖抽象（Driver/Ocr 接口、PlatformStrategy 接口、price 纯函数）。
 *
 * 职责：设备锁内串行驱动各平台 → 产出原始事实 → price 折算 → 分组比价。
 */
import type { Deps, ProgressPort } from '../core/container.ts'
import { withDeviceLock } from '../core/locks.ts'
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

      const quotes: Quote[] = []
      const n = plan.platforms.length
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw new Error('cancelled')
        const strategy = plan.platforms[i]!
        p.update(platformLine(i + 1, n, strategy.id, PHASES.opening))
        const facts = await strategy.enterSettlePage(deps.driver, plan.cond)
        p.update(platformLine(i + 1, n, strategy.id, PHASES.settling, verdictOf(facts)))
        const draft = draftFromFacts(
          facts,
          strategy.id,
          plan,
          deps,
          `${plan.taskId}:${strategy.id}`,
        )
        quotes.push(priceQuote(draft))
      }
      p.update('完成 · 正在折算分组比价')
      if (signal?.aborted) throw new Error('cancelled')
      return compare(quotes, plan.cond, { taskId: plan.taskId, now: deps.clock.now() })
    },
    { waitMs: deps.config.task.lockWaitMs, root: deps.lockRoot },
  )
}

function verdictOf(facts: RawQuoteFacts): string {
  return `实付 ¥${facts.payable.toFixed(2)}（${facts.confidence === 'high' ? 'tree 读取' : 'OCR/推算'}）`
}

/** 原始事实 → 引擎输入草稿（补 evidence / extraction，交给 price 判定）。 */
export function draftFromFacts(
  facts: RawQuoteFacts,
  platform: string,
  plan: RunPlan,
  deps: Deps,
  quoteId: string,
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

  return {
    platform,
    store,
    item,
    fees: facts.fees,
    discounts: facts.discounts,
    payable: facts.payable,
    extraction: { confidence: facts.confidence, byField: facts.byField },
    evidence: {
      quoteId,
      platform,
      storeName: facts.storeName,
      itemSpec: `${facts.itemName}${facts.itemSpec ? ' ' + facts.itemSpec : ''} x${facts.qty}`,
      qty: facts.qty,
      feeBreakdown: facts.fees,
      rawExtraction: { treeDumpPath: `${deps.dataDir}/evidence/${quoteId}.xml` },
      screenshotPath: undefined,
      capturedAt: new Date(now).toISOString(),
      validUntil: new Date(now + ttlMs).toISOString(),
      redaction: 'applied',
    },
  }
}
