/**
 * platform/selectors/generic.ts — 结算页控件选择器集中登记（§3.5.3：App 改版只改这里）。
 * 层：strategy。各平台共用同一套 mock 约定；真机差异在 P2/P3 按平台登记。
 */
export const GENERIC_SETTLE_SELECTORS = {
  settlePage: 'settle-page',
  storeName: 'store-name',
  storeAmap: 'store-amap',
  itemName: 'item-name',
  itemSpec: 'item-spec',
  itemQty: 'item-qty',
  itemComposition: 'item-composition',
  payable: 'payable',
} as const
