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
  /** 首页搜索**入口**（点击后进入搜索页）。真机：`search_layout_area`。 */
  searchEntry: string[]
  /** 搜索页输入框（进入搜索页后才有）。真机：`search_edit_text`。 */
  searchInput: string[]
  searchSubmit: string[]
  /** 搜索结果里的店铺行（可能无稳定 id；无则按首张结果卡尽力而为）。 */
  storeRow: string[]
  /** 搜索结果页特征文案（用于判定"已到结果页"）。 */
  searchResultTexts: string[]
  /** 店铺页特征文案（用于判定"已到店铺页"）。 */
  storePageTexts: string[]
  /** 店铺页：打开菜品规格（真机为文案"选规格"）。 */
  dishOpen: string[]
  /** 规格弹层：加入购物车（文案"加入购物车"）。 */
  addToCart: string[]
  /** 店铺页底部购物车/去结算（文案"去结算"）。 */
  viewCart: string[]
  submitOrder: string[]
  settleTitleTexts: string[]
  settleAnchors: string[]
  /**
   * 结算页**文案锚点**（真机美团结算页几乎无 resource-id，须靠文案判定）。
   * 任一命中即认"在结算页"。
   */
  settleTextAnchors: string[]
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
  // 首页点搜索入口 → SearchActivity；搜索页才有 search_edit_text。
  searchEntry: ['search_layout_area', 'homepage_search', 'search_button'],
  searchInput: ['search_edit_text', 'search_edit', 'search_input'],
  searchSubmit: ['search_button', 'search_btn', 'search_confirm', 'tv_search'],
  // 真机搜索结果店铺无稳定 id（混淆短名），按"点击首张结果卡"的通用兜底在 meituanReal 处理。
  storeRow: ['poi_name', 'shop_name', 'store_name', 'poi_title'],
  // 真机搜索结果页特征（起送/距离/月售/外卖 等）。
  searchResultTexts: ['起送', '月售', '距离', '外卖', '综合排序'],
  // 真机店铺页特征（点菜/选规格/评价/商家/加入购物车）。
  storePageTexts: ['点菜', '选规格', '加入购物车', '评价', '商家'],
  // 真机店铺页：菜品"选规格"是文案；加购在规格弹层"加入购物车"；底部"去结算"。
  dishOpen: ['选规格'],
  addToCart: ['加入购物车', 'add_to_cart', 'add_cart', 'add_btn', 'tv_add', 'btn_add'],
  viewCart: ['去结算', 'cart_bar', 'go_cart', 'cart_icon', 'shopping_cart'],
  submitOrder: ['submit_order_btn', 'submit_btn', 'confirm_order', 'order_submit'],
  settleTitleTexts: ['确认订单', '提交订单'],
  settleAnchors: ['payable', 'submit_order_btn', 'order_total', 'fee_goods'],
  // 真机实测（TB321FU / 美团 2026-10）：结算页顶部"外卖配送/到店自取"、费用行"商品原价/打包费/用户配送费"、
  // 底部"券前/实付"——这些文案稳定，作为无 id 时的锚点。
  // 注意："共减"会在**店铺页购物车条**出现（"到手约 ¥15.98 共减¥16"），不能作结算页锚点（会误判店铺页为结算页）。
  settleTextAnchors: ['外卖配送', '到店自取', '商品原价', '用户配送费', '确认订单', '券前', '实付'],
  storeName: ['store_name', 'poi_name', 'shop_name'],
  itemName: ['item_name', 'food_name', 'product_name'],
  itemSpec: ['item_spec', 'sku_name', 'spec_name'],
  itemQty: ['item_qty', 'qty', 'num'],
  payable: ['payable', 'actual_pay', 'pay_amount', 'total_price', 'order_total'],
  feeLineTexts: ['配送费', '打包费', '餐盒费', '服务费', '小计', '起送'],
  discountLineTexts: ['满减', '优惠', '红包', '券', '立减', '折扣', '减'],
}
