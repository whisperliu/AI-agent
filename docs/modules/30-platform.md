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
| `meituanReal.ts` | **美团真机适配**（P3）：纯提取 + 真机流程 | `extractMeituanSettle`、`extractMeituanSettleFromDump`、`runMeituanReal`、`isDangerNode` |
| `elemeReal.ts` | **饿了么真机适配**（P4/P6）：纯提取 + 真机流程（OCR 盲导航） | `extractElemeSettle`、`extractElemeSettleFromDump`、`runElemeReal`、`runElemeOcrNav`、`elemeAnchors`、`ELEME_LAYOUT`、`supportsOcrNav`、`isGroupOrderPage`、`locateFirstDish(Spec)Y` |
| `ocrNav.ts` | **OCR 盲导航原语**（P6，canvas 自绘专用，平台共享） | `createOcrNav`、`wordAtPoint`、`wordsNearPoint`、`assertOcrTapSafe`、`describeWords` |
| `settleRows.ts` | 结算页"坐标/行"抽取**通用原语**（平台共享）：聚行/标签→金额/结果卡/可点文案 | `buildRows`、`amountNearLabel`、`amountFromRow`、`amountLeftOfAnchor`、`parseMoneyText`、`firstResultCardCenter`、`firstActionableCenter` |
| `navigator.ts` | 真机导航原语（平台共享，包装 Driver） | `createNavigator`、`Navigator`、`textAnchorRegex` |
| `selectors/eleme.ts` | 饿了么选择器集中登记 | `ELEME_SELECTORS` |
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

## P4 多平台（饿了么）与共享原语

- **驱动解耦（同美团）**：`eleme.enterSettlePage` 按驱动能力选路——无 `probe` 的 Mock 走 `enterViaOpenTag`；真机 adb 走 `runElemeReal`。`task/runner` 不改。
- **共享而非复制**：把"坐标/行抽取 + 结果卡/可点文案"抽到 `settleRows.ts`、把 `Navigator` 抽到 `navigator.ts`（均无平台知识），美团/饿了么各自只保留**平台特有**的锚点/文案/关键词。`meituanReal.ts` 仍 re-export `createNavigator/Navigator/buildRows` 等保持旧 API 不变。
- **饿了么真机边界（登录+canvas 自绘，2026-10 实测）**：
  - 未登录触发**实名/短信验证** → 按红线 §0-2 立即停止零点击（用户已自行登录）。
  - **整个 App 是 canvas/TMS 自绘**：`uiautomator dump` 全页仅 1 个 `water_mark_view`，首页/搜索/结果/店铺/**结算页**均无可读文本节点 → **控件树路径不可行，只能 OCR**。
  - `runElemeReal` 走 OCR：`tryReadSettle` 控件树优先，读不到实付且注入 `ctx.ocr` 时 → 截图 + `settlePanelRoi`（`tms_fragment_container` 右栏）→ `extractElemeSettleFromOcr`。`confidence` 永不 high，低置信/不平 → `needsConfirm`。
  - **真机实测**：payable=**¥20.8** 稳定读出（截图"立即支付 ¥20.8"）；一次 OCR 丢"打包费 ¥1"数字 → delta −1 → 如实 `low/needsConfirm`。
  - 导航（搜索/加购/去结算）在 canvas 下只靠 resourceId 锚点 + 坐标点按；**全自动逐页校准不如美团稳定**（canvas 无文案钩子），当前可稳定验收的是**已在结算页时的 OCR 读数**。
  - **P6 OCR 盲导航（canvas 全自动）**：`ocrNav.ts` 把"截图→tesseract 逐词（屏幕像素绝对坐标）→按文案/坐标定位→`tapPoint` 盲点"封装成原语；`elemeReal.runElemeOcrNav` 用它把「首页→搜索→选店→选规格→去结算→读实付」全程跑通（布局坐标见 `ELEME_LAYOUT`，换机型需重校准）。**canvas 无控件树 → `tapPoint` 的 `assertTapSafe` 抓不到画布上的"支付"文案，故每次点击前额外用 `assertOcrTapSafe` 按 OCR 邻域文字做支付红线拦截**（这是 canvas 场景唯一有效防线）。「拼单详情」页有 `合计/去结算` 但金额是整单总额，用 `isGroupOrderPage` 拦住不读、如实交人工（不自动取消他人拼单）。加购**只点一次**（非幂等、有副作用）。
  - **慢设备适配（2026-10-27 真机 PASS）**：本机（TB321FU/1600×2560/WASM）**全屏 OCR 单帧 6.2s**，原 6–8s 预算只够看 1 帧 → 转场期一帧读歪即整条失败。`ocrNav.waitFor` 改为：**至少 2 次 look** + 预算按**首帧实测耗时**动态放大（`max(perTimeout, first×2.5+1.5s)`）+ 8 帧硬上限，异常文案带「看了 N 帧 / 预算 Ns」。另 `waitFor(pred, what, ms, roi)` 支持 ROI：**底部条 ROI 仅 ~1s/帧**，`ELEME_ROI.bottomBar` 用于轮询「去结算/领券结算」，把等待从"3 帧/18s"提到"多帧/6s"。
  - **加购跨重试幂等（红线）**：`runElemeOcrNav` 的重试是整条重走，若失败在加购之后会**重复加购**（真机实测同菜 ×4、账单 13.98→125.92）。现用跨重试共享 `AddToCartState`：加购成功即置位，后续重试跳过加购；已点「选规格」但未确认加购成功则**如实失败不再重试**（宁失败不重复加购）。
  - **真机读数（2026-10-27）**：`payable=¥13.98`、`confidence=medium`、`delta=0.00`（2+9+11.98=22.98 − 免配送费 9 = 13.98），与结算页「立即支付 ¥13.98」一致；全流程 87.6s。
  - **失败自解释（省上下文）**：`createOcrNav().waitFor` 超时抛出的异常**自带末帧 OCR 文本（带 y 坐标、截断到 ~20 行/60 词）**，排查"卡在哪页"看异常即可，**不必再 `read_image` 读整屏图**（2026-10-26 教训：一次饿了么调试读了 28 张整屏图致上下文超出）。
- **两条静默错价防线（2026-10-27 双平台真机）**：① **件数核对**——结算页「共 N 件」作为页面事实回传，`detectDeviations` 在 N≠期望 时判不可比（购物车跨任务累积会让"多件费用×多件实付"算术自洽，静默错价）；饿了么加购前还**要求购物车为空**，非空即交人工（不自动清空，避免删用户商品）。② **诚实抽取**——`extractElemeSettleFromOcr` 不再伪造 `storeName/itemName=cond.item`，改为从版面事实抽店名/菜名/规格（剥"区购/堂食店/蜂鸟准时达"角标与 OCR 前缀噪声），抽不到才退回查询词、规格绝不伪造。
- **加购与重试幂等（红线）**：`PlatformStrategy.idempotentEnter=false`（饿了么）→ runner **跳过外层重试**，避免"内外两层重试相乘"重复加购（真机曾 1→3 件）；规格窗**可能不出现**（默认规格菜品），此时以"底部购物车条出现"判定加购成功。
- **离线全流程回放（P6 收尾，`test/ocrNavFlow.test.ts`）**：`runElemeOcrOnce/runElemeOcrNav` 接受可选 `sleep` 注入（默认 `sleepMs`），使整条"首页→搜索→选店→选规格→去结算→读实付"可在**无真机**时用假驱动回放。4 例钉住：正常走查读出 payable 且 6 次 `tapPoint` 顺序正确（搜索框/输入框/第一家店/选规格/选好了/去结算）、**加购（选规格）只点 1 次**、验证码→`NeedsHumanError(captcha)` 读 1 帧即停（`attempts=3` 也不重试）、拼单详情页→`NeedsHumanError` 在加购**之前**拦截且不重试、瞬时故障（launchApp 抛 timeout）整条重试一次后成功。意义：设备离线时改这段代码不再"盲改"。
- **OCR 逐词框留存（P5）**：`extractElemeSettleFromOcr` 返回 `ocrWords`（原始 `t/c/bbox`），`task/runner` 写入 `evidence.rawExtraction.ocrBoxes`，便于人工按坐标复核金额；截图（已脱敏）同时作为证据落盘。
- **fixture**：`test/fixtures/eleme-settle.real-device.xml`（脱敏；30+3+1−5=29 balanced、`confidence=high`）。

## 测试
- `test/fixtures` 回放：用 `MockDriver` 跑"首页→搜索→结算"脚本，断言每步 anchor 命中。
- `test/platform-p4.test.ts`（16 tests）：饿了么结算页抽取（id / 坐标行双路径）→ balanced；策略四态（星期/门槛/日限/autoApplied）；跨平台默认不互斥 + 显式互斥降级；统一快照派生与偏离归不可比组；effectivePrice 双口径无重复扣；Mock 双平台全链路。
- `test/platform-p3.test.ts`（16 tests，离线）：真机结算页抽取（id 路径 / 文案回退）、`¥28.9 vs ¥289`、`满30减5` 金额、选店导航链路（stub）、**无字 WebView 滑块→NeedsHumanError 且零点击**、升级/定位/加载干扰分类、读不到实付→needsConfirm、危险控件识别；
  **真机结算页（脱敏 fixture `meituan-settle.real-device.xml`，无 resource-id）→ 坐标/行抽取 balanced**、"待使用红包"不进已减（回归）、已在结算页短路零点击、真机付款按钮"极速支付"被识别为危险控件。

## 2026-10-28 · 双平台联跑暴露的「选错菜 / 重复加购 / 空车误判」加固

真机双平台复跑发现：即使从干净车开始，美团仍会累积成 3 件、饿了么总选成近名菜（小炒猪肝/小炒田螺肉），
导致两平台不可比、`cheapest=null`。定位为三个自动化缺陷并修复（离线回放 + `pnpm check` 全绿）：

1. **按目标菜名选规格（两平台，静默错价防线）**：此前两平台都是"点**第一个**菜的选规格"，`cond.item`
   只用于最终归组、不参与加购选择 → 必然选错菜（美团菜单第一个菜、饿了么首卡都可能不是查询词）。
   新增共享纯函数 `settleRows.dishMatchScore(candidate,target)`（**精确=1.0 / 前缀包含=0.92 / 其余退回
   `similarity.itemScore`**）与 `settleRows.findDishAddTarget(nodes,target)`（按菜名定位其「选规格」中心）；
   饿了么因是 OCR 逐词，另加 `elemeReal.locateElemeDishAddTarget(words,target)`（给每个「选规格」词配同行/邻近菜名词判分）。
   **关键**：`itemScore` 对近名菜不可靠——`小炒田螺肉木桶饭` vs `小炒肉木桶饭` 高达 **0.90**，故认定阈值取
   `DISH_MATCH_MIN=0.92`，只有精确/包含才认命；**匹配不到 → `NeedsHumanError('environment', 未找到目标菜品)` 交人工，绝不再乱点近名菜**。
2. **美团加购前空车守卫 + 非幂等入口（红线）**：美团缺饿了么那样的加购前判空；且 `retryAttempts=2` 会整条重走、
   在已有购物车上再加一件（真机实测 ×3）。修：① `meituanReal.assertMeituanCartEmpty` 在加购前判空，非空即交人工
   （绝不自动清空）；② `meituan.idempotentEnter=false` 让 runner 跳过外层重试（美团的"去结算"已自带 3 次点按重试）。
   **判空信号只认「已添加 N 件(N>0)」**——实测首页/店铺底部可能有"2 件失效商品 / 结算0件"这类陈旧残留也显示"去结算"，
   用它判空会误判（已加回归）。
3. **美团店名抽取修复**：`locateStoreItemSpec` 的"商品行上方最近文本"会误吸到「x1」/「1人份，不辣」/「买贵必赔」角标
   （真机曾 `storeName='x1'`）。改为**优先按店名形态**（`XX(XX店)/路店/分店/店$`）在菜品行上方宽窗内找，并排除纯价格、
   `x1` 件数标记、无文字碎片；找不到才回退最近文本。

**诚实的边界（仍未达成的验收项）**：上述三修让两平台"**选对菜 / 不重复加购 / 不误判空车**"，
真机复跑中二者均**如实通过各自守卫或交人工**（饿了么店铺页 OCR 把三道菜挤成一行、且首屏无「选规格」按钮 →
`NeedsHumanError(未找到目标菜品)`；美团→冷启动弹**字序图形验证码** → `NeedsHumanError(captcha)` 零点击）。
**"双平台同快照选出最低价"的端到端验收仍未完成**：饿了么网格卡片（⊕ 加购按钮、无「选规格」文案、菜名多菜挤一行）
需专门做"按列切分 + ⊕ 加购"的独立选取策略，属后续工作；且复跑期间美团结账反复弹验证码需用户本人通过。
**全程只读、未点提交/支付、验证码即停零绕过**。

## 2026-10-28 · 饿了么「网格卡片」布局：按列切卡 + ⊕ 加购（真机端到端 PASS）

真机发现饿了么多数店铺菜单是**多列网格卡片**（与"选规格按钮"布局不同）：菜名在上、价格行在下、加购是价格行右缘一个
**橙色 ⊕（OCR 读不到）**，且**多道菜名被 OCR 挤成同一行**、尾部还常被读花（`小炒肉木桶饭`→`小炒肉木人`）。此前"按菜名配选规格"
找不到按钮即交人工。新增：

- **`elemReal.locateElemeGridAddTarget(words,target)`**：把菜名行按 **x 间隔切列卡片**（真机三列 x0≈41/564/1086，间距>450），
  按 `dishMatchScore` 命中目标卡；⊕ 坐标 = **菜名起点 + `ELEME_GRID_ADD_OFFSET`(dx437,dy159)**。真机实测 ⊕ 中心
  (477/1001/1523, 2005) 与推导 (478/1001/1523, 2005) **完全吻合**。
- **`settleRows.dishMatchScore` 尾噪容错**：新增"公共前缀 ≥ max(3,⌈0.7·较短⌉) 且两侧余量 ≤2 字 → 0.93"规则，
  命中 `小炒肉木人`/`小炒肉木桶镀`；而近名菜 `小炒田螺肉`(0.90)/`腐竹炒肉`(0.625) 仍拒（不误加别列）。
- **进店后等网格渲染 + 回顶再向下查找**：进店常停在**上次浏览的品类页**，目标菜在**顶部热销横排**；一味向下会越找越远。
  改为：当前帧无价格先补等 ≤8s（帧已就绪则不额外等，避免离线回放漂移）→ 未命中先上滑回顶 → 再逐屏向下找 ≤4 屏。
- **规格弹窗确认跨布局**：确认按钮 y 因弹窗而异（选规格≈2432 / 网格⊕ 橙色条≈2462）；先点标准位，**仅当弹窗仍可见**才补点低位，
  绝不重复确认（加购非幂等红线）。
- **真机 PASS（2026-10-28，TB321FU）**：`payable=¥9.88`、`balanced=true`、`delta=0`（2+3.9+7.88−3.9=9.88，与「立即支付 ¥9.88」一致），
  全程只读、未点支付。`cheapest=null` 因**单平台无可比对象**；结算页菜名 OCR 仍糊（`小炒内木情所Y`）→ 如实 `needsConfirm=true`
  （点击弹窗证明**加购选中的确为目标菜**，仅回读糊）。双平台对比仍受**美团字序验证码**阻断（需用户本人过）。
