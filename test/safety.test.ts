/**
 * Security boundary tests — these enforce AGENTS.md §0 红线 1:
 * order/payment taps must be blocked at runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTapSafe, looksForbidden } from '../src/core/safety.ts'
import { ForbiddenActionError } from '../src/core/errors.ts'

test('blocks order/payment labels (zh)', () => {
  for (const label of ['提交订单', '立即支付', '确认支付', '去支付', '免密支付']) {
    assert.equal(looksForbidden(label), true, label)
    assert.throws(() => assertTapSafe({ label }), ForbiddenActionError)
  }
})

test('blocks order/payment labels (en, case-insensitive)', () => {
  for (const label of ['Place Order', 'PAY NOW', 'Confirm Payment']) {
    assert.throws(() => assertTapSafe({ label }), ForbiddenActionError)
  }
})

test('blocks when only resourceId matches', () => {
  assert.throws(() => assertTapSafe({ resourceId: 'id/submit_order_btn' }), ForbiddenActionError)
})

test('allows harmless navigation labels', () => {
  for (const label of ['去结算', '选好了', '菜单', '加入购物车', '返回', '查看详情']) {
    assert.equal(looksForbidden(label), false, label)
    assert.doesNotThrow(() => assertTapSafe({ label }))
  }
})
