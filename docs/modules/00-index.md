# 00 · 入口 `src/index.ts`

> 层：entry（只装配，无业务）。全局分层/边界见 [§4.4](../module-spec.md)。

## 职责
导出 cordis 插件契约：`name`、`inject`、`apply(ctx, config)`、`Config`。按配置装配依赖后注册工具，**不实现任何业务逻辑**。

## 公开 API（仅这些）
```ts
export const name = 'price-agent'
export const inject = ['tools', 'jobs']          // 需要的 DSH 服务
export function apply(ctx: Context, config: Config): void
export { Config } from './config.ts'
```

## 实现要点
- `apply` 只做三件事：① `buildContainer(ctx, config)` 拿到依赖图（core）；② `ctx.tools.register(defineTool(priceAgentTool(deps)))`（tools）；③ 用 `ctx.effect(...)` 注册清理（关闭 storageDomain/释放锁）。
- **禁止**在此写算法、走流程、拼 SQL、直接调 adb。
- 配置在加载期由 `Config`（schemastery）校验，失败即 fail-fast。

## 本模块必须遵守的共享规则（只列清单）
- 分层与依赖方向：§4.4 R1–R6
- 复用优先（不引第三方重复件）：§2.2
- 注入口径（`ctx.fs`/`ctx.jobs`/`storageDomain`）：§2.1 R2/R5

## 测试
- 冒烟：`apply` 后 `ctx.tools` 里能看到 `price_agent`（Mock 环境）。
- 配置非法 → 加载失败并给出字段名。

## 待实现（P1 已完成）
P1 已填入：`apply` 打开 `price_agent_tasks` 存储领域 → `buildCapabilities(ctx,config)` 组装 `Driver/Ocr/Clock`（唯一决定 mock|adb）→ `createJobsPort(ctx)` 适配 `ctx.jobs` → `recoverOnStartup` → `ctx.tools.register(priceAgentTool(deps))`；`ctx.effect` 注册 `domain.close()`。P2 接真机。
