# dsh-price-agent

DSH 插件：在你自己的 Android 手机上打开外卖 App（美团 / 饿了么），按**结算页真实实付**抓价，
按平台策略（信用卡 / 会员 / 红包）折算 `effectivePrice`，横向对比给出**可信的最低价**。

- **只读**：只到结算页读价，**不自动下单、不支付**；遇验证码暂停并请人工处理。
- **隐私**：截图默认脱敏后仅存本地，不上传；信用卡只存"卡种/权益"，不存卡号。

## 状态

**基建阶段（脚手架 + 开发工具链已就绪）**，业务未实现。文档：总纲 [PLAN.md](./PLAN.md) · 模块规范 [docs/module-spec.md](./docs/module-spec.md) · **每模块说明 [docs/modules/](./docs/modules/README.md)** · 任务与验收 [docs/tasks.md](./docs/tasks.md) · 决策 [docs/decisions.md](./docs/decisions.md) · 变更 [CHANGELOG.md](./CHANGELOG.md)。

> 开发某个模块时，**只读 `docs/modules/NN-*.md` 中对应那一份**，不必通读 `module-spec.md`。

## 协作规范（AGENTS.md）

仓库根有 **`AGENTS.md`**（DSH 自动加载）：安全红线（**不自动下单/不支付**、验证码即停、隐私脱敏）、按模块读文档、修改规范、测试要求、提交规范、DoD。**开始任何改动前先读它。**

## 环境（详见 PLAN §4.1）

- WSL2 (Ubuntu 26.04) + Windows；Node v24.22（直接运行 `.ts`）；pnpm 12.14
- DSH `@deepseek-ai/dsh` 0.2.1-rc.2（profile `web`）
- 手机 Android 11+，开启无线调试；`adb`（`apt install android-tools-adb`）

## 目录结构（详见 PLAN §4.3 / §4.4）

```
src/
  index.ts        插件入口（组装）
  config.ts       schemastery 配置
  core/           DI / Clock / 锁
  task/           编排与生命周期（幂等/取消/重取）
  platform/       美团/饿了么策略 + 选择器
  device/         Driver 接口 + adb/mock 实现 + 状态机断言
  price/          纯核心：模型/zod 校验/折算引擎/相似度
  ocr/            OCR 接口 + tesseract/mock
  tools/          defineTool(price_agent)
test/             node --test 单测 + fixtures
```

## 开发工具链

| 工具 | 命令 | 说明 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | `tsc --noEmit`（Node 直接跑 `.ts`，tsc 只查类型） |
| 代码检查 | `pnpm lint` / `pnpm lint:fix` | ESLint 10 flat config + typescript-eslint 8 |
| 格式化 | `pnpm format` / `pnpm format:check` | Prettier 3 |
| 测试 | `pnpm test` / `pnpm test:watch` | 内置 `node --test`（不引 jest/vitest） |
| 全量门禁 | `pnpm check` | typecheck → lint → format:check → test |

### 开发环境注意（本机沙箱）

本机 `$HOME` 只读，pnpm 需要可写的 store/lock 目录，故：

```bash
# 仓库内已提供 .npmrc / pnpm-workspace.yaml（storeDir 指向仓库内 .pnpm-store）
export HOME="$PWD/.home"
export XDG_RUNTIME_DIR="$PWD/.run"   # pnpm 12 的 store 操作锁放这里
pnpm install
```

若在正常（HOME 可写）的开发机上，直接 `pnpm install` 即可，无需上面两个变量。

## 许可

MIT
