# dsh-price-agent

DSH 插件：在你自己的 Android 手机上打开外卖 App（美团 / 饿了么），按**结算页真实实付**抓价，
按平台策略（信用卡 / 会员 / 红包）折算 `effectivePrice`，横向对比给出**可信的最低价**。

- **只读**：只到结算页读价，**不自动下单、不支付**；遇验证码暂停并请人工处理。
- **隐私**：截图默认脱敏后仅存本地，不上传；信用卡只存"卡种/权益"，不存卡号。

## 状态

**P0–P6 完成**：纯核心 + 插件骨架/异步任务/Mock 全链路（P0/P1）→ 真机通道（P2）→ 美团真机全流程抓价（P3）→ 多平台（饿了么）+ 策略四态 + 谨慎互斥 + 统一输入快照分组（P4）→ **P5 打磨**（截图默认脱敏、证据 TTL/保留清理、瞬时异常重试、证据真实绑定、无线调试 mDNS 自动回连）→ **P6 饿了么 canvas OCR 盲导航（真机端到端 PASS ✅）**：`platform/ocrNav.ts`（截图→OCR 逐词→按文案/坐标盲点；canvas 支付红线 `assertOcrTapSafe`；慢设备动态预算 + ROI 加速）+ `elemeReal.runElemeOcrNav`（拼单页守卫、**加购跨重试幂等**）；2026-10-27 真机实测 `payable=¥13.98`、`delta=0` 平账。**2026-10-28 真机双平台端到端 PASS**：同快照（江西小炒·小炒肉木桶饭 微辣）合并为 **1 个可比组**——美团 `¥29.88`(high/免复核)、饿了么 `¥9.88`(medium/需复核)，`cheapest = 美团 ¥29.88`（只取可信最低价）；期间修 `refundedBy` 拆条重复计数、按目标菜名选规格、饿了么网格⊕加购、跨平台同菜分组（规格归一+菜名回填）。`pnpm check` 全绿（**230 tests**，`src/price` 行覆盖 100%（分支 91.44%））。

文档：总纲 [PLAN.md](./PLAN.md) · 模块规范 [docs/module-spec.md](./docs/module-spec.md) · **每模块说明 [docs/modules/](./docs/modules/README.md)** · 任务与验收 [docs/tasks.md](./docs/tasks.md) · 决策 [docs/decisions.md](./docs/decisions.md) · 变更 [CHANGELOG.md](./CHANGELOG.md)。

### 隐私与证据（P5）

- 截图**默认脱敏**（零依赖 PNG 掩码：手机号/门牌/收件人/支付信息填黑）；**无法脱敏则不落图**。
- 证据只存本地 `.price-agent/`（gitignore），按 `evidence.ttlMinutes` + `retainDays/retainMax` 清理。
- 抓价遇到**验证码/登录/风控立即停止**（`NeedsHumanError`），**瞬时故障才重试**；下单/支付控件永不触碰、永不重试。

## P2 真机快速上手（只读、不会下单/支付）

```bash
# 1) 准备 adb（本沙箱 HOME 只读，必须给 adb 一个可写 HOME）
mkdir -p .home/andhome
HOME=$(mktemp -d) .home/android-sdk/platform-tools/adb version   # 或用系统 adb

# 2) §8.4 无线调试最小实验（判定门槛；填手机「无线调试」页面的 IP:端口）
ADB=.home/android-sdk/platform-tools/adb HOME=$(mktemp -d) \
  ./scripts/device-min-experiment.sh 192.168.1.8 5555

# 3) 只读演练 / 能力探测报告（落到 .price-agent/reports/）
ADB_PATH=$PWD/.home/android-sdk/platform-tools/adb HOME=$(mktemp -d) \
  node scripts/device-rehearsal.mjs --serial 192.168.1.8:5555 --open com.sankuai.meituan
```

在 GUI 内也可直接让 AI 调 `price_agent({action:'selfCheck'})` / `price_agent({action:'probe'})`（需先把配置 `device.driver` 改成 `adb`）。

> 开发某个模块时，**只读 `docs/modules/NN-*.md` 中对应那一份**，不必通读 `module-spec.md`。

## 协作规范（AGENTS.md）

仓库根有 **`AGENTS.md`**（DSH 自动加载）：安全红线（**不自动下单/不支付**、验证码即停、隐私脱敏）、按模块读文档、修改规范、测试要求、提交规范、DoD。**开始任何改动前先读它。**

## 环境（详见 PLAN §4.1）

- WSL2 (Ubuntu 26.04) + Windows；Node v24.22（直接运行 `.ts`）；pnpm 12.14
- DSH `@deepseek-ai/dsh` 0.2.1-rc.2（profile `web`）
- 手机 Android 11+，开启无线调试；`adb`（`apt install android-tools-adb`，或用仓库内 `.home/android-sdk/platform-tools/adb`）

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
| 全量门禁 | `pnpm check` | typecheck → lint → format:check → boundary → test |
| 证据文本检查 | `node scripts/evidence-inspect.mjs <dump.xml> [--settle\|--clickable] [--filter kw…]` | 把真机 dump 解析成**紧凑文本+坐标**，避免逐张读整屏 PNG 吃满上下文（见 AGENTS.md §2「真机调试省上下文」） |
| 截图文本化/裁剪 | `node scripts/screen-inspect.mjs <shot.png> --ocr [--roi x,y,w,h] [--filter kw…]` ／ `--crop x,y,w,h --scale 0.5 --out tiny.png` | canvas 自绘无 dump 时，把截图 **OCR 成文本** 或**只裁关键区出小图**（打印估算视觉 token），替代直读整屏 PNG |

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
