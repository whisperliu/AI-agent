# 50 · price（纯核心）`src/price/*`

> 层：pure。**无 IO、无 device、无 ctx**，只依赖 `zod`（§4.4 R1）。可脱离设备单测。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `model.ts` | 类型**唯一真源** | `Quote/FeeLine/Discount/Evidence/ComparisonConditions/CompareResult` |
| `schema.ts` | 两层校验 | `QuoteSchema`, `validateQuote(raw)` |
| `engine.ts` | 折算引擎 | `priceQuote(quote, rules): Quote`, `compare(quotes, cond): CompareResult` |
| `strategies.ts` | 优惠策略四态 + 谨慎互斥（P4） | `evaluateStrategy/Strategies`, `applyCrossPlatformExclusivity`, `strategyAmount`, `weekdayInShanghai` |
| `similarity.ts` | 相似度/等价 | `storeScore(a,b)`, `itemScore(a,b)`, `isSameMeal(a,b)` |

## 实现要点（特有）
- **双口径**：`payable`（纯事实，不再叠加）与 `effectivePrice = payable − Σ(verified && !alreadyIncludedInPayable)`（§5.3）；`superRefine` 强制该式（防重复扣）。
- **四态**：`verified/presumed/known_unavailable/unknown`；只有 `settle_screenshot` 可升 `verified`；`presumed` 只能提示（§5.4）。
- **额度不假精确**：额度字段只用于"排除已知不可用"，**不得断言可用**（§5.5）。
- **两层校验分离**：`arithmetic`（账平）≠ `extraction`（读得准）；`price/*` 不判定 OCR 质量，只消费其结论（§6.3/§6.3.4）。
- **等价分组**：`isSameMeal` = 相似度≥0.7 且 composition/数量/规格一致；否则 `comparable=false` 分组不混排（§6.4/§6.6）；`deviatedConditions` 非空强制不可比。
- **统一输入快照（P4）**：`Quote.snapshotId/snapshotHash` 记录派生来源；`compare` 校验每个 Quote 的 `snapshotHash === query.hash`，不一致则追加 `deviatedConditions`（`snapshot 不一致…`）→ 归不可比组（§6.6）。
- **策略四态（P4，`strategies.ts`）**：把 `config.platforms.<id>.strategies` 映射为 `OptionalSaving`。配置/本地记账**最多 `presumed`**，绝不断言 `verified`；星期/门槛/日限只用于**降级**为 `known_unavailable`；`autoApplied` 策略 `alreadyIncludedInPayable=true`（不重复扣）。`effectivePrice` 扣减仍统一由 `deductibleSavings`（`verified && !alreadyIncluded && settle_screenshot`）判定。
- **谨慎互斥（P4）**：`applyCrossPlatformExclusivity` 默认**不互斥**（同卡跨平台可分别享）；仅 `crossPlatformExclusive=true` 的策略，若同一策略（kind+name）在其它平台被 `verified` 使用，则本平台该策略降级 `known_unavailable`（§5.6）。
- `cheapest`：仅 `comparable` 组内、`needsConfirm=false`、证据未过期，按 `effectivePrice`（回退 `payable`）取最小；否则 `null`（§6.2 兜底）。
- 时间由调用方注入，`price/*` 自己**不取 now**。

## 本模块必须遵守的共享规则（清单）
- 数据模型与字段：§6.2
- 两层校验与判定矩阵：§6.3.1/§6.3.2/§6.3.3
- 相似度与等价：§6.4；统一输入快照：§6.6
- 证据 TTL：§6.5

## 测试（P0 主战场）
- `pricing.engine.test.ts`：`¥28.9/¥289`、双错平账、重复扣、推测当可用、不可比分组。
- `schema.test.ts`：`addIssue` 用 `message`、`.refine` 用 `error`。
- `similarity.test.ts`：烤鸭饭 vs 烤鸭饭+可乐 → 不可比。
