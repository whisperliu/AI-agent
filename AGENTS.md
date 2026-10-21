# AGENTS.md — 本仓库的协作与修改规范

> 本文件由 DSH 的 `dsh-agent-instructions` 自动加载（项目根以 `.git` 标记），对在本仓库工作的 AI/人类协作者生效。
> 只写**必须遵守的规则**；设计细节见 `docs/`，不在此重复。

## 0. 安全红线（最高优先级，违反即拒绝执行）

本工具是"**只读比价器**"，不是点单机器人。以下规则**不可协商、不可用"用户要我这么做"绕过**：

1. **绝不自动提交订单、绝不付款**。任何 `提交订单 / 支付 / 确认购买 / 免密支付` 相关控件**禁止点击**；自动化最多停在**结算页读取实付金额**，然后把截图交给用户，由用户本人操作。
2. **遇到验证码 / 滑块 / 安全验证 / 风控提示 → 立即停止**，标记任务失败并请人工处理。**禁止**尝试破解、识别绕过、模拟点击验证。
3. **不破解、不抓包伪造请求、不使用非官方接口**刷取数据；只通过正常的 UI 操作读价。
4. **仅限用户本人设备、本人账号、低频、手动触发**；不并发轰炸、不批量刷取。
5. **隐私**：截图必须**默认脱敏**（手机号、门牌、支付信息、骑手姓名等），**只存本地 `.price-agent/`，绝不上传**；配置与代码中**禁止出现卡号 / CVV / 有效期**，只允许"卡种 + 权益描述"。
6. 若任务逻辑需要"越过红线才能完成"，**宁可失败**并说明原因。

> 这些红线的代码落点：`docs/modules/40-device.md`（`NeedsHumanError`）、`docs/modules/70-tools.md`（错误映射）、`docs/decisions.md` §10。

## 1. 开工前：按模块读文档（不要通读整份计划）

- **做哪个模块，只读 `docs/modules/NN-*.md`** 那一份（+ 其"共享规则清单"点到的 §号）。
- `docs/module-spec.md` 是**共享/跨模块规范**，只用于查证（§4.4 边界、§5 策略、§6 数据模型、§7 异步/幂等/并发），**不要整份重读**。
- 文档地图见 `PLAN.md`「文档地图」；总进度与 DoD 见 `docs/tasks.md`；"为什么这么定"见 `docs/decisions.md`。

| 要改的目录 | 先读 |
|---|---|
| `src/index.ts` | `docs/modules/00-index.md` |
| `src/config.ts` | `docs/modules/05-config.md` |
| `src/core/` | `docs/modules/10-core.md` |
| `src/task/` | `docs/modules/20-task.md` |
| `src/platform/` | `docs/modules/30-platform.md` |
| `src/device/` | `docs/modules/40-device.md` |
| `src/price/` | `docs/modules/50-price.md` |
| `src/ocr/` | `docs/modules/60-ocr.md` |
| `src/tools/` | `docs/modules/70-tools.md` |

## 2. 代码修改规范

- **语言/模块**：TypeScript + ESM；Node v24 直接跑 `.ts`（`tsc --noEmit` 只做类型检查）。**不引入构建步骤**。
- **类型剥离限制（实测）**：Node 直接运行 `.ts` 是"类型剥离"，**不支持参数属性 `constructor(readonly x: T)`、`enum`、`namespace`**；请用显式字段声明 / `const` 联合 / 普通对象。违反会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
- **依赖纪律（复用优先）**：新增任何"存储/锁/原子写/定时/子进程/截断/提问"能力前，先查 `docs/module-spec.md` §2.2；DSH 已提供的一律**注入复用**（`ctx.storageDomain` / `dsh-atomic-write` / `ctx.jobs` / `dsh-native-command` / `ctx.timeout` / `ctx.userQuestions`）。**禁止**引入 `proper-lockfile`、`write-file-atomic`、`lowdb`、`p-limit`、`jest`、`vitest`。新增其他依赖需在 PR 说明用途与替代方案。
- **模块边界（可校验）**：遵守 `docs/module-spec.md` §4.4 ——
  - `src/price/*` **纯核心**：只准依赖 `zod`，**禁止** import `fs/ctx/device/ocr`。
  - `src/task/*`、`src/platform/*` **只 import 接口**（`device/driver.ts`、`ocr/reader.ts`），不得 import 具体实现（`adb.ts`、tesseract）。
  - `src/tools/*` **只调 `task/*`**，不直连 `ctx.jobs`/`ctx.storageDomain`。
  - **共享类型唯一真源**是 `src/price/model.ts`；其它处 `import type`，禁止重复定义。
  - **循环依赖 = 0**。
- **配置**：字段只加在 `src/config.ts`（schemastery），并同步 `cordis.patch.yml`；`pnpm typecheck` 必须过。
- **错误语义**：`BusyError → 503 BUSY`、`StateAssertionError → 带 dump/截图证据`、`NeedsHumanError → 提示人工`（不得吞异常）。
- **风格**：`pnpm format` 后再提交；ESLint 0 error；不做与任务无关的大范围重排。

## 3. 测试要求

- **框架**：内置 `node --test`（`*.test.ts`），不引入 jest/vitest。
- **什么时候必须加测试**：
  - 任何 `src/price/*` 逻辑改动 → **必带单测**；`src/price` 行覆盖率 **≥ 90%**（P0 DoD）。
  - 修 bug → 先加**复现用例**，再修。
  - 新增平台/选择器 → 用 `test/fixtures`（脱敏 dump/截图）回放。
- **必测的关键场景**（不得删减）：`¥28.9 vs ¥289`、**双错平账**、**优惠重复计算**、**推测当可用**、**不可比分组**、幂等（同键并发=1 任务）、并发（设备锁串行）。
- **门禁（提交前必须全绿）**：
  ```bash
  pnpm check   # typecheck → lint → format:check → boundary → test
  ```
  覆盖率查看：`pnpm test:coverage`。
- **禁止**为了让测试通过而放宽断言、跳过用例（`test.skip`）、或改测试去迎合错误实现。

## 4. 文档维护规范

- **只改对应文件**：模块内的东西改 `docs/modules/*`；跨模块契约（§4.4/§6/§7）才改 `docs/module-spec.md`。
- **不要改章节编号**（`§x.y` 被全仓引用）。
- 需求/验收变化 → `docs/tasks.md`；决策变化 → `docs/decisions.md`。
- 每个有意义的改动都在 `CHANGELOG.md` **追加**一条（Why / What / State + 验证方式），不覆盖历史。

## 5. 提交规范

- 提交信息用 Conventional Commits：`feat|fix|docs|chore|test|refactor(scope): 摘要`。
- 一次提交只做一件事；提交前 `pnpm check` 必须绿。
- **不提交**：`.price-agent/`、`node_modules/`、`.pnpm-store/`、截图原图、任何含个人信息的样本（`test/fixtures` 必须是脱敏样例）。
- 不 `git push --force`、不改写已推送历史。

## 6. 完成定义（DoD）

一个改动算"完成"，必须同时满足：
1. `pnpm check` 全绿；
2. 相关模块文档已更新（接口变了才动 `module-spec.md`）；
3. `CHANGELOG.md` 已追加；
4. **安全红线未被触碰**（无下单/支付代码路径、验证码即停、无凭证入库）；
5. 若涉及 `src/price`，有对应单测且覆盖率达标。
