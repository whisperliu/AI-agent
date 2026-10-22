/**
 * device/mock-data.ts — Mock 模式的内置结算页 fixtures（脱敏、小样本，§2.1 R3）。
 * 层：capability（device）。P1 只压两个平台，价格互不相同以便演示"分组比价取最低"。
 *
 * XML 采用统一的 mock resource-id 约定（`settle-page` / `fee-*` / `discount-*` / `payable`），
 * 平台策略用同一套解析器读取；真机 XML 的差异在 P2/P3 由各平台 selectors 处理。
 */

/** 美团：goods 28.9 + delivery 2 + packing 1 = 31.9；满30减5(auto) → 实付 26.9（账平）。 */
const MEITUAN = `<hierarchy>
  <node resource-id="settle-page" text="确认订单" />
  <node resource-id="store-name" text="香叶烤鸭（人民广场店）" />
  <node resource-id="store-amap" text="AMAP-1" />
  <node resource-id="item-name" text="香叶·精品烤鸭饭" />
  <node resource-id="item-spec" text="大份" />
  <node resource-id="item-qty" text="1" />
  <node resource-id="item-composition" text="烤鸭饭" />
  <node resource-id="fee-goods" text="28.90" />
  <node resource-id="fee-delivery" text="2.00" />
  <node resource-id="fee-packing" text="1.00" />
  <node resource-id="discount-coupon" text="满30减5|5.00" />
  <node resource-id="payable" text="26.90" />
</hierarchy>`

/** 饿了么：goods 30 + delivery 2 + packing 1 = 33;促销减6(auto) → 实付 27.0（账平）。 */
const ELEME = `<hierarchy>
  <node resource-id="settle-page" text="确认订单" />
  <node resource-id="store-name" text="香叶烤鸭（人民广场店）" />
  <node resource-id="store-amap" text="AMAP-1" />
  <node resource-id="item-name" text="香叶·精品烤鸭饭" />
  <node resource-id="item-spec" text="大份" />
  <node resource-id="item-qty" text="1" />
  <node resource-id="item-composition" text="烤鸭饭" />
  <node resource-id="fee-goods" text="30.00" />
  <node resource-id="fee-delivery" text="2.00" />
  <node resource-id="fee-packing" text="1.00" />
  <node resource-id="discount-promo" text="店铺满减|6.00" />
  <node resource-id="payable" text="27.00" />
</hierarchy>`

/** platform id → 结算页 XML。 */
export const MOCK_SETTLE_PAGES: Record<string, string> = {
  meituan: MEITUAN,
  eleme: ELEME,
}

/** 默认 Mock OCR 条目（P1 ocr.enabled=false 时不会被调用）。 */
export const MOCK_OCR_ENTRIES = [{ text: '28.90 2.00 1.00 26.90', confidence: 0.95 }]
