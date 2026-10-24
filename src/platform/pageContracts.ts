/**
 * platform/pageContracts.ts — 各平台页面契约（§3.5.3 页面转移表）。
 * 层：strategy。只描述"这一页长什么样"，供 device 层的 pageDetect 判定。
 *
 * 为什么放 platform 而不是 device：页面 anchor 是**平台知识**（会随 App 改版变化），
 * device 层只提供通用的 `detectPage(dump, contracts)` 能力。
 */
import type { PageContract } from '../device/pageDetect.ts'
import type { UiSelector } from '../device/driver.ts'
import { MEITUAN_SELECTORS } from './selectors/meituan.ts'

/** 把 selector 短名列表转成 UiSelector（按 resourceId 后缀匹配由 uixml 处理）。 */
function byIds(ids: string[]): UiSelector[] {
  return ids.map((id) => ({ resourceId: id }))
}
function byTexts(texts: string[]): UiSelector[] {
  return texts.map((t) => ({ text: t }))
}

/** 美团页面契约：首页 → 搜索 → 店铺 → 结算。 */
export const MEITUAN_PAGE_CONTRACTS: PageContract[] = [
  {
    page: 'settle',
    // 真机美团结算页几无 resource-id，同时登记文案锚点（外卖配送/到店自取/商品原价/券前…）。
    anchors: [
      ...byIds([...MEITUAN_SELECTORS.settleAnchors]),
      ...byTexts([...MEITUAN_SELECTORS.settleTextAnchors]),
    ],
    requireTexts: [],
  },
  {
    page: 'home',
    anchors: byIds(MEITUAN_SELECTORS.homeAnchors),
  },
  {
    page: 'store',
    anchors: [...byIds(MEITUAN_SELECTORS.storeRow), ...byTexts(['加入购物车', '选规格'])],
  },
]

/** 结算页强锚（"确认订单"标题 + 实付/费用行，任一组命中）。 */
export const MEITUAN_SETTLE_TEXT_ANCHORS = MEITUAN_SELECTORS.settleTitleTexts
