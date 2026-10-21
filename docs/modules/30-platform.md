# 30 · platform（平台策略）`src/platform/*`

> 层：strategy。依赖 `price/model` 类型与 `device/driver` 接口，**不直接操作 adb、不直接写存储**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `types.ts` | 平台策略契约（唯一真源） | `PlatformStrategy` 接口 |
| `router.ts` | 选择本次参与比价的平台 | `select(config): PlatformId[]` |
| `meituan.ts` / `eleme.ts` | 具体平台策略 | `export const meituan: PlatformStrategy` |
| `selectors/*` | 控件选择器集中登记 | 按页面分组的 selectors |

```ts
interface PlatformStrategy {
  id: string
  appId: string
  openApp(d: Driver): Promise<void>
  search(d: Driver, q: string): Promise<void>
  enterSettlePage(d: Driver, c: ComparisonConditions): Promise<Evidence>
  settleAnchor: string           // 结算页 anchorResourceId
  selectors: Record<string, UiSelector>
}
```

## 实现要点（特有）
- **一个平台 = 一个文件**；新增平台只加文件 + 在 `router` 注册，不改他人。
- 选择器**全部**放 `selectors/`，App 改版只改这里（§3.5.3）。
- 平台只负责"走到结算页并产出 `Evidence`（含费用明细）"；**比价/折算不在这里**（属 price）。
- 每步必须走 `device/state.ts` 的动作+断言；弹窗交 `device/recover.ts` 处理。
- 平台策略配置（`strategies/quota/exclusiveGroup`）从 `config.platforms[id]` 读，**逻辑在 engine**，此处只透传。

## 本模块必须遵守的共享规则（清单）
- 状态机断言与降级矩阵：§3.5.1–§3.5.4
- 页面契约/转移表/选择器规范：§3.5.3
- 数据契约 `ComparisonConditions/Evidence`：§6.2/§6.6

## 测试
- `test/fixtures` 回放：用 `MockDriver` 跑"首页→搜索→结算"脚本，断言每步 anchor 命中。
