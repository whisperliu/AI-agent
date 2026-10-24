/**
 * platform/selectors/meituan.ts — 美团真机控件选择器集中登记（§3.5.3：App 改版只改这里）。
 * 层：strategy。
 *
 * ⚠️ 状态：**待真机 dump 校准**。以下为按美团 Android 常见 resource-id 约定 + 通用可访问性
 * 文案给出的候选集合；真机首跑若命中失败，按 `.price-agent/evidence/*.xml` 回填真实 id 即可，
 * 无需改动业务逻辑（这正是"选择器全部集中在此"的目的）。
 *
 * 说明：`resourceId` 允许写"短名"（不带包名），匹配时按 **后缀** 命中，兼容不同包名/版本。
 */
export interface MeituanSelectors {
  /** 各页面 anchor（任一命中即认该页）。 */
  homeAnchors: string[]
  searchInput: string[]
  searchSubmit: string[]
  storeRow: string[]
  addToCart: string[]
  viewCart: string[]
  submitOrder: string[]
  settleTitleTexts: string[]
  settleAnchors: string[]
  /** 结算页字段。 */
  storeName: string[]
  itemName: string[]
  itemSpec: string[]
  itemQty: string[]
  payable: string[]
  /** 费用 / 优惠行（按文案解析，见 extract-real.ts）。 */
  feeLineTexts: string[]
  discountLineTexts: string[]
}

export const MEITUAN_SELECTORS: MeituanSelectors = {
  // 真机实测（TB321FU, 美团 2026-10）：首页搜索区为 search_layout_area / search_button。
  homeAnchors: ['search_layout_area', 'search_button', 'tab_home', 'homepage_search'],
  // 搜索页真机 id：search_edit_text(EditText) + search_button(TextView)。
  searchInput: ['search_edit_text', 'search_layout_area', 'search_edit', 'search_input'],
  searchSubmit: ['search_button', 'search_btn', 'search_confirm', 'tv_search'],
  storeRow: ['poi_name', 'shop_name', 'store_name', 'poi_title'],
  addToCart: ['add_to_cart', 'add_cart', 'add_btn', 'tv_add', 'btn_add'],
  viewCart: ['cart_bar', 'go_cart', 'cart_icon', 'shopping_cart'],
  submitOrder: ['submit_order_btn', 'submit_btn', 'confirm_order', 'order_submit'],
  settleTitleTexts: ['确认订单', '提交订单'],
  settleAnchors: ['payable', 'submit_order_btn', 'order_total', 'fee_goods'],
  storeName: ['store_name', 'poi_name', 'shop_name'],
  itemName: ['item_name', 'food_name', 'product_name'],
  itemSpec: ['item_spec', 'sku_name', 'spec_name'],
  itemQty: ['item_qty', 'qty', 'num'],
  payable: ['payable', 'actual_pay', 'pay_amount', 'total_price', 'order_total'],
  feeLineTexts: ['配送费', '打包费', '餐盒费', '服务费', '小计', '起送'],
  discountLineTexts: ['满减', '优惠', '红包', '券', '立减', '折扣', '减'],
}
