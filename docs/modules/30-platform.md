# 30 · platform（平台策略）`src/platform/*`

> 层：strategy。依赖 `price/model` 类型与 `device/driver` 接口，**不直接操作 adb、不直接写存储**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `types.ts` | 平台策略契约（唯一真源） | `PlatformStrategy`, `RawQuoteFacts` |
| `router.ts` | 选择本次参与比价的平台 | `selectPlatforms(config, requested?)`, `knownPlatforms()` |
| `meituan.ts` / `eleme.ts` | 具体平台策略 | `export const meituan/eleme: PlatformStrategy` |
| `extract.ts` | 结算页 dump → 原始事实 | `extractSettleFacts`, `enterViaOpenTag`, `SETTLE_ANCHOR` |
| `xml.ts` | uiautomator XML 最小解析（零依赖） | `parseNodes/textOf/hasResourceId` |
| `selectors/*` | 控件选择器集中登记 | `GENERIC_SETTLE_SELECTORS`、`MEITUAN_SELECTORS` |
| `meituanReal.ts` | **美团真机适配**（P3）：纯提取 + 真机流程 | `extractMeituanSettle`、`extractMeituanSettleFromDump`、`runMeituanReal`、`createNavigator`、`Navigator`、`parseMoneyText`、`isDangerNode` |
| `pageContracts.ts` | 各平台页面契约（§3.5.3 转移表） | `MEITUAN_PAGE_CONTRACTS` |

```ts
interface PlatformStrategy {
  id: string
  appId: string
  settleAnchor: string                 // 结算页 anchorResourceId
  selectors: Record<string, string>
  enterSettlePage(d: Driver, c: ComparisonConditions): Promise<RawQuoteFacts>
}
```

> 边界：platform 只 import `device/driver.ts` 接口类型，**不** import 设备实现；XML 解析放 `xml.ts`（不去 import `device/*`）。

## 实现要点（特有）
- **一个平台 = 一个文件**；新增平台只加文件 + 在 `router` 注册，不改他人。
- 选择器**全部**放 `selectors/`，App 改版只改这里（§3.5.3）。
- 平台只负责"走到结算页并产出 `Evidence`（含费用明细）"；**比价/折算不在这里**（属 price）。
- 每步必须走 `device/state.ts` 的动作+断言；P2 起可用 `device/steps.ts` 的 `tapAndExpect/waitForState`（动作+断言+超时+恢复+失败留证）与 `device/recover.ts` 处理弹窗；验证码/登录由 `recover.ts` 抛 `NeedsHumanError`。
- 真机 XML 的解析用 `device/uixml.ts`（含 bounds，可点）；`pageDetect.ts` 做"当前在哪一页"的多信号判定（§3.5.4）。
- 平台策略配置（`strategies/quota/exclusiveGroup`）从 `config.platforms[id]` 读，**逻辑在 engine**，此处只透传。

## 本模块必须遵守的共享规则（清单）
- 状态机断言与降级矩阵：§3.5.1–§3.5.4
- 页面契约/转移表/选择器规范：§3.5.3
- 数据契约 `ComparisonConditions/Evidence`：§6.2/§6.6

## P3 真机抓价（美团）

- **驱动解耦（DoD②）**：`meituan.enterSettlePage` 按驱动能力自动选路 —— 无 `probe` 的 `MockDriver` 走 `enterViaOpenTag`（回放 `open-meituan` 后的结算页 dump）；真机 adb（有 `probe`）走 `runMeituanReal`。**上层 `task/runner` 不改**。
- **分层**：`meituanReal.ts` 属 strategy，只 import `device/driver.ts`（接口）、`device/uixml.ts`（纯解析）、`device/steps.ts`（§30 明确允许平台使用的"动作+断言+恢复"原语）。**不 import** `device/adb.ts` 等具体实现（`check-boundary` R2 已校验）。
- **纯提取可离线测**：`extractMeituanSettle(nodes, cond, dump)` 不碰设备，按 `resource-id`（`fee_<kind>` / `discount_<kind>` / `payable`）优先、文案兜底（`配送费 ¥2.00`、`满30减5 -¥5.00`）。金额解析优先取 `¥` 前缀，避免"满30减5"误取 30。
- **真机流程（已全自动跑通，2026-10-24）**：首页→搜索→选店→选规格/加购→去结算→**读实付**；每步 `waitAny(anchors)` 复用 `device/steps.waitForAnyState`（验证码/登录即停 + 弹窗恢复 + 超时取证）。**全程只读，绝不点提交订单/支付**（`driver.tap`/`driver.tapPoint` 内 `assertTapSafe` 兜底）。真机实证：`enterSettlePage(driver)` 从首页全自动跑到结算，返回 `payable=19.9, balanced, needsConfirm=false`。
- **真机导航要点（实跑校准）**：
  - **resource-id 后缀匹配**：真机 id 带包名前缀（`com.sankuai.meituan:id/search_layout_area`），选择器写短名；`state.hasResourceId`/`uixml.findBySelector` 均按**后缀**匹配。
  - **首页搜索入口**是 `search_layout_area`（非 EditText），点入 SearchActivity 才出现 `search_edit_text`（`searchEntry` 与 `searchInput` 分开）。
  - **店铺页大图 banner 导致 dump 无法 idle/陈旧**：先下滚 1–2 屏越过 banner 再等锚点；滚动后**用文案点击**（坐标会失效）。
  - **去结算偶发点不中**：点后校验结算锚点，未进则最多重试 3 次。
  - **结果卡无 id/文案钩子**：用安全的 `driver.tapPoint(x,y)`——先解析该点命中节点的 text/desc/id 过 `assertTapSafe`（命中支付即拒）再点。
- **OCR 质量门**：真机读不到实付 → `confidence='low'` → `price` 层 `needsConfirm=true`（不硬凑算术）。
- **真机实测（TB321FU / 美团 2026-10）已校准**：首页 `search_layout_area`/`search_button`；搜索页 `search_edit_text`/`search_button`；店铺页 `选规格`→`加入购物车`→`去结算`（文案）；**结算页（OrderConfirmActivity）几乎全无 resource-id**，改由"坐标/行"抽取（见下）。
- **坐标/行抽取（P3 真机核心）**：`extractMeituanSettle` 在无 resource-id 时按视觉布局抽取——
  - `buildRows` 按 y 中心聚成"行"、行内按 x 排序；`amountNearLabel` 找"标签（商品原价/打包费/用户配送费/券前…）→ 同一行右侧最近金额"；
  - 门店 = 商品行上方最近、左对齐、非价格的文本；商品 = 与查询词相似度最高（`price/similarity.itemScore`）的非价格文本；规格/数量取同区块邻近文本（"1 人份，不辣" / "x1"）；
  - 优惠只认**明确已减**（带 `-¥`/已减/共减），另把"待使用/去使用"红包识别为 `optionalSavings`（`availability='presumed'`，**不计入实付、effectivePrice 也不扣**）。
  - 实付两种变体：A「券前 ¥X 共减¥Y」（取"券前"右侧）；B 神抢手/一口价店「¥X 共减¥Y」**无券前标签**（取"共减"左侧最近金额）。
  - 真机实证：A 变体 商品原价 29.98+打包 2+用户配送 3.9−减免 3.9−商家代金券 1 = **30.98**；B 变体 26.98+配送 3.9−减免 3.9−代金券 7.08 = **19.9**（均 balanced、needsConfirm=false）。
- **文案锚点**：`settleTextAnchors`（外卖配送/到店自取/商品原价/用户配送费/券前/实付）作为无 id 时的结算页判定；`Navigator.waitAny` 同时支持 resourceId 与文案锚点。**注意：`共减` 会出现在店铺页购物车条，不能作结算页锚点（会误判）。**
- **短路（最安全路径）**：`runMeituanReal` 进入时先探测"是否已在结算页"（1.5s），命中则**直接读实付、零点击**；否则走完整"首页→搜索→选店→加购→去结算"。
- **验证码红线**：首页冷启动偶发弹**字序验证码**（"请按语序依次点击下图文字"，无字 WebView）。`classifyObstruction` 判 `captcha`（`textless-webview`），真实代码路径抛 `NeedsHumanError` 且零点击（已加回归）；遇之**立即停止、交人工**。
- **⚠️ 尚未走通的真机阻碍**：（1）**冷启动全流程**（首页→搜索）仍需 ADBKeyboard 注入中文搜索词（见 40-device），且大量控件为混淆短 id（`h5x/myj/vqq`），全流程逐页校准仍需人工在旁；（2）店铺页菜单/加购控件随 App 版本变化，需按真机 dump 持续回填 `selectors/meituan.ts`。当前**已稳定走通并可验收**的是：**结算页 → 读实付**（含坐标抽取、短路零点击）。

## 测试
- `test/fixtures` 回放：用 `MockDriver` 跑"首页→搜索→结算"脚本，断言每步 anchor 命中。
- `test/platform-p3.test.ts`（16 tests，离线）：真机结算页抽取（id 路径 / 文案回退）、`¥28.9 vs ¥289`、`满30减5` 金额、选店导航链路（stub）、**无字 WebView 滑块→NeedsHumanError 且零点击**、升级/定位/加载干扰分类、读不到实付→needsConfirm、危险控件识别；
  **真机结算页（脱敏 fixture `meituan-settle.real-device.xml`，无 resource-id）→ 坐标/行抽取 balanced**、"待使用红包"不进已减（回归）、已在结算页短路零点击、真机付款按钮"极速支付"被识别为危险控件。
