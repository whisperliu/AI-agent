# 70 · tools（工具定义）`src/tools/*`

> 层：entry-tool。只依赖 `task/*`、`price/model`、`config`；**不直接碰 device/ocr 实现**（§4.4）。

## 职责
用 `defineTool`（@deepseek-ai/dsh-tools）定义模型可见的 `price_agent` 工具；它是 AI 唯一入口。

## 公开 API
```ts
export function priceAgentTool(deps: Deps): ToolDefinition   // defineTool(...)
```

## 工具方法（暴露给模型/前端）
| 方法 | 入参 | 出参 |
|---|---|---|
| `price_agent`（start） | `item, city?, platforms?, idempotencyKey?` | `{ taskId, status:'processing' }` |
| `getResult` | `taskId` | `{ status, result? }`（幂等只读） |
| `listTasks` | — | 未消费的已完成任务 |
| `cancel` | `taskId` | `{ outcome }` |

## 实现要点（特有）
- **异步**：工具立即返回 `taskId`，绝不阻塞等待（§7.1）；后台由 `task/*` 跑，进度经 `ctx.jobs`。
- 工具内**只调 `task/*`**；参数校验用 zod schema DSL；返回走 `CompareResult`（§6.2）。
- `getResult/cancel` 必须幂等（§7.6 R2 表）。
- 错误映射：`BusyError→503 BUSY`、`StateAssertionError→带 dump/截图证据`、`NeedsHumanError→提示人工`。

## 本模块必须遵守的共享规则（清单）
- 异步契约与返回：§7.4
- 幂等的操作范围：§7.6 R2
- `CompareResult` 结构：§6.2

## 测试
- Mock 环境：`price_agent` → `taskId` → `getResult` → 拿到分组比价表（P1 DoD）。
