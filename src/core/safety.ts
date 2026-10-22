/**
 * Safety guard: hard-blocks any tap on order/payment controls.
 * Layer: core (no deps). Enforces AGENTS.md §0 红线 1 at runtime,
 * regardless of what upper-layer logic attempts.
 */
import { ForbiddenActionError } from './errors.ts'

/**
 * Text fragments that indicate an order/payment action. Matching is intentionally
 * conservative and multilingual; adding to it makes the guard stricter (safer).
 */
export const FORBIDDEN_TEXTS: readonly string[] = [
  // zh
  '提交订单',
  '确认下单',
  '立即支付',
  '去支付',
  '确认支付',
  '免密支付',
  '立即购买',
  '确认购买',
  '提交支付',
  '去结算并支付',
  // en
  'place order',
  'submit order',
  'confirm order',
  'pay now',
  'confirm payment',
  'checkout & pay',
]

/** Does a control label look like order/payment? Case-insensitive, `_`/`-` normalized. */
export function looksForbidden(label: string | undefined | null): boolean {
  if (!label) return false
  const s = String(label).toLowerCase().replace(/[_-]+/g, ' ')
  return FORBIDDEN_TEXTS.some((t) => s.includes(t.toLowerCase()))
}

/**
 * Throw if the intended tap target is an order/payment control.
 * Call this immediately before every driver.tap in the automation flow.
 *
 * Inspects `resourceId`, `label`/content-desc and `text`, because a tap
 * selector may target a control by any of them (a gap found in P2: a selector
 * expressed only as `{ text: '提交订单' }` must also be blocked).
 */
export function assertTapSafe(target: {
  label?: string
  resourceId?: string
  text?: string
}): void {
  const hay = `${target.label ?? ''} ${target.resourceId ?? ''} ${target.text ?? ''}`
  if (looksForbidden(hay)) throw new ForbiddenActionError(hay.trim())
}
