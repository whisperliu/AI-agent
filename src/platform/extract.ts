/**
 * platform/extract.ts — 从结算页 dump 抽取原始事实（P1 mock 约定）。
 * 层：strategy。只把中性 XML 映射为 `RawQuoteFacts`；不做比价/折算（属 price）。
 */
import type { ComparisonConditions, DiscountKind, FeeKind } from '../price/model.ts'
import type { Driver } from '../device/driver.ts'
import { assertState } from '../device/state.ts'
import { parseNodes, textOf } from './xml.ts'
import type { RawQuoteFacts } from './types.ts'

/** 结算页 anchor（断言命中）。 */
export const SETTLE_ANCHOR = 'settle-page'

const FEE_KINDS: readonly FeeKind[] = [
  'goods',
  'delivery',
  'packing',
  'service',
  'small_order',
  'tip',
  'other',
]
const DISCOUNT_KINDS: readonly DiscountKind[] = [
  'coupon',
  'membership',
  'credit_card',
  'promo',
  'delivery_waiver',
]

/** 从当前 dump 抽取原始事实；缺结算页 anchor 抛 StateAssertionError。 */
export function extractSettleFacts(
  driverDump: string,
  platform: string,
  cond: ComparisonConditions,
): RawQuoteFacts {
  const dump = driverDump
  assertState(dump, { presentResourceIds: [SETTLE_ANCHOR] })

  const nodes = parseNodes(dump)
  const fees: RawQuoteFacts['fees'] = []
  const discounts: RawQuoteFacts['discounts'] = []

  for (const n of nodes) {
    const id = n.resourceId ?? ''
    if (id.startsWith('fee-') && n.text) {
      const kind = id.slice('fee-'.length)
      fees.push({
        kind: (FEE_KINDS as readonly string[]).includes(kind) ? (kind as FeeKind) : 'other',
        label: kind,
        amount: parseMoney(n.text),
        source: 'tree',
      })
    } else if (id.startsWith('discount-') && n.text) {
      const kind = id.slice('discount-'.length)
      const [name, amt] = n.text.split('|')
      discounts.push({
        kind: (DISCOUNT_KINDS as readonly string[]).includes(kind)
          ? (kind as DiscountKind)
          : 'promo',
        platform,
        id: `${platform}-${kind}`,
        name: name ?? kind,
        amount: parseMoney(amt ?? '0'),
        scope: 'order',
        source: 'tree',
        autoApplied: true,
        alreadyIncludedInPayable: true,
      })
    }
  }

  const qty = Number.parseInt(textOf(dump, 'item-qty') ?? '1', 10)
  const payable = parseMoney(textOf(dump, 'payable') ?? '')

  return {
    storeName: textOf(dump, 'store-name') ?? cond.item,
    storeAmapId: textOf(dump, 'store-amap'),
    itemName: textOf(dump, 'item-name') ?? cond.item,
    itemSpec: textOf(dump, 'item-spec'),
    qty: Number.isFinite(qty) && qty > 0 ? qty : cond.qty,
    composition: textOf(dump, 'item-composition')
      ?.split(/[+、,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    fees,
    discounts,
    payable,
    confidence: 'high',
    byField: { payable: 'tree' },
    dump,
  }
}

/** 打开平台 App 并进入结算页（P1 mock：点击 open-<platform> 后 dump）。 */
export async function enterViaOpenTag(
  driver: Driver,
  platform: string,
  cond: ComparisonConditions,
): Promise<RawQuoteFacts> {
  await driver.tap({ resourceId: `open-${platform}`, label: `打开 ${platform}` })
  const dump = await driver.dump()
  return extractSettleFacts(dump, platform, cond)
}

function parseMoney(s: string): number {
  const n = Number.parseFloat(String(s).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : Number.NaN
}
