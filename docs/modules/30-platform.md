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
- **真机流程**：首页→搜索→选店→加购→购物车/去结算→**读实付**；每步 `waitAny(anchors)` 复用 `device/steps.waitForAnyState`（验证码/登录即停 + 弹窗恢复 + 超时取证）。**全程只读，绝不点提交订单/支付**（`driver.tap` 内 `assertTapSafe` 兜底）。
- **OCR 质量门**：真机读不到实付 → `confidence='low'` → `price` 层 `needsConfirm=true`（不硬凑算术）。
- **⚠️ 选择器待真机校准**：`MEITUAN_SELECTORS` 为候选集合（短名后缀匹配），真机首跑按 `.price-agent/evidence/*.xml` 回填即可，不动业务逻辑。

## 测试
- `test/fixtures` 回放：用 `MockDriver` 跑"首页→搜索→结算"脚本，断言每步 anchor 命中。
- `test/platform-p3.test.ts`（12 tests，离线）：真机结算页抽取（id 路径 / 文案回退）、`¥28.9 vs ¥289`、`满30减5` 金额、选店导航链路（stub）、**无字 WebView 滑块→NeedsHumanError 且零点击**、升级/定位/加载干扰分类、读不到实付→needsConfirm、危险控件识别。
