/**
 * price/strategies.ts — 平台优惠策略的四态评估与谨慎互斥（docs/module-spec.md §5.1–§5.6）。
 * 层：pure。无 IO、无 ctx；时间由调用方注入。
 *
 * 核心原则（§5.4/§5.5）：
 *  - 配置/本地记账只能产生 `presumed`（参考提示），**绝不**断言 `verified`；
 *  - 只有结算页实时实证（sourceOfTruth=settle_screenshot）才能升 `verified` 并计入 effectivePrice；
 *  - 额度字段只用于"排除明确已知不可用"，绝不用来"断言可用"；
 *  - 跨平台默认**不互斥**（同一张卡在两个平台可分别享），仅显式 `crossPlatformExclusive` 才互斥（§5.6）。
 *
 * 这里只负责"把配置策略映射成 OptionalSaving（四态）+ 谨慎互斥"，
 * 真正的 `effectivePrice` 扣减由 `schema.deductibleSavings` 统一判定（verified && !alreadyIncluded）。
 */
import type { DiscountKind, OptionalSaving } from './model.ts'
import { round2 } from './schema.ts'

export type Weekday =
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export interface StrategyConditions {
  /** 订单门槛（元）；未达门槛 → known_unavailable。 */
  minSpend?: number
  /** 仅该星期生效（英文枚举，避免 0-based 歧义）。 */
  weekday?: Weekday
}

export interface StrategyDiscount {
  type: 'fixed' | 'percent'
  /** fixed=减免金额（元）；percent=折扣百分比（0–100）。 */
  amount: number
  /** percent 的封顶金额（元）。 */
  cap?: number
}

export interface StrategyQuota {
  dailyLimit: number | null
  monthlyLimit: number | null
  totalQuota: number | null
  lastUsedAt: string | null
}

/** 平台策略配置（与 config.platforms.<id>.strategies 结构对齐；此处纯类型避免依赖 schemastery）。 */
export interface StrategySpec {
  id: string
  kind: DiscountKind
  name: string
  condition: StrategyConditions
  discount: StrategyDiscount
  autoApplied: boolean
  quota: StrategyQuota
  exclusiveGroup?: string
  crossPlatformExclusive: boolean
}

export interface EvaluateContext {
  platform: string
  /** 结算页实付（用于门槛判断与 percent 折算的基数）；纯事实。 */
  payable: number
  /** 当前时间（毫秒或 Date），用于星期/日限判定。 */
  now: number | Date
}

const WEEKDAY_ORDER: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/** 计算"上海时区"的星期（0=周日）。北京时间无夏令时，直接 +8h 取 UTC 日即可，确定性、无副作用。 */
export function weekdayInShanghai(now: number | Date): Weekday {
  const ms = typeof now === 'number' ? now : now.getTime()
  const day = new Date(ms + 8 * 60 * 60_000).getUTCDay()
  return WEEKDAY_ORDER[day] ?? 'monday'
}

/** 计算"上海时区"的日期键（YYYY-MM-DD），用于日限判定。 */
function shanghaiDateKey(now: number | Date): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  return new Date(ms + 8 * 60 * 60_000).toISOString().slice(0, 10)
}

/** 策略减免金额（fixed / percent，percent 封顶）。 */
export function strategyAmount(spec: StrategySpec, payable: number): number {
  if (spec.discount.type === 'fixed') return round2(Math.max(0, spec.discount.amount))
  const pct = Math.max(0, spec.discount.amount)
  const raw = round2((payable * pct) / 100)
  const capped =
    spec.discount.cap !== null && spec.discount.cap !== undefined
      ? Math.min(raw, spec.discount.cap)
      : raw
  return round2(Math.max(0, capped))
}

/** 单条策略 → 四态 OptionalSaving（配置来源最多 presumed）。 */
export function evaluateStrategy(spec: StrategySpec, ctx: EvaluateContext): OptionalSaving {
  const base: OptionalSaving = {
    kind: spec.kind,
    platform: ctx.platform,
    id: spec.id,
    name: spec.name,
    amount: strategyAmount(spec, ctx.payable),
    scope: 'order',
    source: 'tree',
    autoApplied: spec.autoApplied,
    // 默认已抵扣策略（如美团神券）视为已含在实付里，effectivePrice 不再重复扣（§5.3）。
    alreadyIncludedInPayable: spec.autoApplied,
    availability: 'presumed',
    sourceOfTruth: 'platform_config',
  }

  // 1) 星期不匹配 → 明确不可用（§5.5：条件属可本地可靠推导）。
  if (spec.condition.weekday && spec.condition.weekday !== weekdayInShanghai(ctx.now)) {
    return {
      ...base,
      availability: 'known_unavailable',
      availabilityReason: `非活动日（仅${spec.condition.weekday}）`,
    }
  }

  // 2) 未达门槛 → 明确不可用。
  if (
    spec.condition.minSpend !== null &&
    spec.condition.minSpend !== undefined &&
    ctx.payable < spec.condition.minSpend
  ) {
    return {
      ...base,
      availability: 'known_unavailable',
      availabilityReason: `未达门槛（需满 ¥${spec.condition.minSpend}）`,
    }
  }

  // 3) 今日已用（仅当用户确认过真实"已用"）→ 降级 known_unavailable（§5.5，只降级不升级）。
  if (
    spec.quota.dailyLimit !== null &&
    spec.quota.dailyLimit !== undefined &&
    spec.quota.lastUsedAt
  ) {
    const used = Date.parse(spec.quota.lastUsedAt)
    if (Number.isFinite(used) && shanghaiDateKey(used) === shanghaiDateKey(ctx.now)) {
      return {
        ...base,
        availability: 'known_unavailable',
        availabilityReason: '今日已用（本地记账）',
      }
    }
  }

  // 4) 其余一律 presumed：配置已知，但本次结算页未实证 → 仅供参考，不计入 effectivePrice。
  return {
    ...base,
    availability: 'presumed',
    availabilityReason: spec.autoApplied
      ? '配置默认已抵扣（已含在实付，不重复扣）'
      : '配置已知优惠，本次未在结算页实证（仅供参考，不计入主价）',
  }
}

/** 批量评估一个平台的全部策略 → OptionalSaving[]。 */
export function evaluateStrategies(specs: StrategySpec[], ctx: EvaluateContext): OptionalSaving[] {
  return specs.map((s) => evaluateStrategy(s, ctx))
}

export interface PlatformSavings {
  platform: string
  /** 该平台的策略配置（含 crossPlatformExclusive / exclusiveGroup）。 */
  specs: StrategySpec[]
  /** 该平台的预估 savings（evaluateStrategies 的产出，原地更新 availability）。 */
  savings: OptionalSaving[]
}

/**
 * 跨平台"谨慎互斥"（§5.6）：
 *  - **默认不互斥**：`crossPlatformExclusive=false`（含缺省）的策略，其它平台用了也不影响本平台；同一张卡跨平台可分别享。
 *  - 仅当策略显式 `crossPlatformExclusive=true` 时：若"同一策略"（同 id 或同 kind+name）在**其它平台**已被 `verified` 使用，
 *    则把本平台该策略降级为 `known_unavailable`（原因：跨平台互斥）。
 *
 * 纯函数式原地更新 `groups[].savings`，返回被降级的策略 id 列表（便于测试/日志）。
 */
export function applyCrossPlatformExclusivity(groups: PlatformSavings[]): string[] {
  const downgraded: string[] = []

  // 收集"在任一平台被 verified 使用"的策略签名。
  const verifiedKeys = new Set<string>()
  for (const g of groups) {
    const specById = new Map(g.specs.map((s) => [s.id, s]))
    for (const s of g.savings) {
      const spec = specById.get(s.id)
      if (spec?.crossPlatformExclusive && s.availability === 'verified') {
        verifiedKeys.add(`${g.platform}\u0000${specKey(spec)}`)
      }
    }
  }
  if (verifiedKeys.size === 0) return downgraded

  for (const g of groups) {
    const specById = new Map(g.specs.map((s) => [s.id, s]))
    for (const s of g.savings) {
      const spec = specById.get(s.id)
      if (!spec?.crossPlatformExclusive) continue // 默认不互斥：直接跳过
      // 其它平台（不同 platform）是否已验证使用同一策略？
      const conflict = [...verifiedKeys].some((k) => {
        const [p, key] = k.split('\u0000')
        return p !== g.platform && key === specKey(spec)
      })
      if (conflict && s.availability === 'presumed') {
        s.availability = 'known_unavailable'
        s.availabilityReason = '跨平台互斥（该卡片活动已在其它平台使用）'
        downgraded.push(s.id)
      }
    }
  }
  return downgraded
}

/** 策略签名：优先用 kind+归一化名称，跨平台识别"同一张卡/同一活动"。 */
function specKey(spec: StrategySpec): string {
  return `${spec.kind}:${spec.name.replace(/\s+/g, '')}`
}
