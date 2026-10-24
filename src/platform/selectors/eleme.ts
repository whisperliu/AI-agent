/**
 * platform/selectors/eleme.ts — 饿了么真机控件选择器集中登记（§3.5.3：App 改版只改这里）。
 * 层：strategy。`resourceId` 允许写"短名"（不带包名），匹配时按**后缀**命中。
 *
 * ⚠️ 状态：**待真机 dump 校准**。饿了么（me.ele 12.9.x）结算页多数金额无稳定 id，
 * 因此与美团一致采用"坐标/行"兜底（见 elemeReal.ts）；此处给出常见 id / 文案候选，
 * 真机首跑命中失败时按 `.price-agent/evidence/*.xml` 回填即可。
 */
export interface ElemeSelectors {
  homeAnchors: string[]
  searchEntry: string[]
  searchInput: string[]
  searchSubmit: string[]
  searchResultTexts: string[]
  storePageTexts: string[]
  dishOpen: string[]
  addToCart: string[]
  viewCart: string[]
  submitOrder: string[]
  settleTitleTexts: string[]
  settleAnchors: string[]
  settleTextAnchors: string[]
  storeName: string[]
  itemName: string[]
  itemSpec: string[]
  itemQty: string[]
  payable: string[]
}

export const ELEME_SELECTORS: ElemeSelectors = {
  // 首页常见搜索区（饿了么首页顶部搜索框）。
  homeAnchors: ['search_layout', 'search_text', 'home_search', 'index_search', 'tab_home'],
  searchEntry: ['search_layout', 'search_text', 'home_search', 'index_search'],
  searchInput: ['search_edit', 'search_input', 'edit_search', 'search_et'],
  searchSubmit: ['search_btn', 'search_confirm', 'tv_search', 'search_button'],
  // 搜索结果页特征。
  searchResultTexts: ['起送', '月售', '评分', '距离', '综合排序', '筛选'],
  // 店铺页特征。
  storePageTexts: ['点餐', '选规格', '加入购物车', '评价', '商家'],
  dishOpen: ['选规格'],
  addToCart: ['加入购物车', 'add_to_cart', 'add_cart', 'add_btn', 'tv_add', 'btn_add'],
  viewCart: ['去结算', '去下单', 'cart_bar', 'go_cart', 'cart_icon'],
  submitOrder: ['submit_order_btn', 'submit_btn', 'confirm_order', 'order_submit'],
  settleTitleTexts: ['确认订单', '提交订单'],
  settleAnchors: ['payable', 'submit_order_btn', 'order_total', 'fee_goods'],
  // 饿了么结算页文案锚点（无 id 时用）。
  settleTextAnchors: [
    '确认订单',
    '订单详情',
    '配送费',
    '打包费',
    '实付',
    '合计',
    '小计',
    '商品金额',
  ],
  storeName: ['store_name', 'shop_name', 'poi_name'],
  itemName: ['item_name', 'food_name', 'product_name'],
  itemSpec: ['item_spec', 'sku_name', 'spec_name'],
  itemQty: ['item_qty', 'qty', 'num'],
  payable: ['payable', 'actual_pay', 'pay_amount', 'total_price', 'order_total'],
}
