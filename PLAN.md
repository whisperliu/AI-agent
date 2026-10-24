# 手机外卖比价 Agent —— 项目总纲（Plan / Index）

> 目标：让 DSH 里的 AI 助手在你说"我想吃香叶的烤鸭饭"时，自动调用一个自定义插件 `dsh-price-agent`：插件打开你手机上的外卖 App（美团 / 饿了么），按 App 内**真实到手价**（含配送费、打包费、红包、会员券、信用卡立减）把同一顿饭的报价抓回来，横向对比，列出**可信的最便宜**下单方案。

## 文档地图（Documentation Map）

本项目文档从一份大文档拆为 **一套四件**。**章节编号全局统一（§0–§13）**，全文对 `§x.y` 的引用跨文件依然有效。

| 文档 | 定位 | 内容（章节） |
|---|---|---|
| **PLAN.md**（本文件） | **项目总纲**：目标、结论、需求、文档地图、状态、怎么用 | §0 结论 / §1 需求 |
| [`docs/module-spec.md`](docs/module-spec.md) | **模块规范**（What & How，Normative，共享/跨模块） | §2 架构 · §3 难点 · §4 环境/技术栈/目录/边界 · §5 配置策略 · §6 数据模型 · §7 异步任务 · §8 WSL2 |
| [`docs/modules/`](docs/modules/README.md) | **每模块说明**（只写模块特有内容；**开发某模块只读它**） | 00 入口 · 05 配置 · 10 core · 20 task · 30 platform · 40 device · 50 price · 60 ocr · 70 tools |
| [`docs/tasks.md`](docs/tasks.md) | **开发任务与验收**（Who/When，DoD） | §9 分阶段计划 P0–P5 + 验收标准 |
| [`docs/decisions.md`](docs/decisions.md) | **决策记录**（Why，ADR-lite） | §10 风险合规 · §11 已锁定决策 · §12 为何不用官方 API · §13 版本摘要 |
| [`CHANGELOG.md`](CHANGELOG.md) | **全量变更时间线**（每次改动的 Why/What/State） | 逐条历史 |

### 章节 → 文件速查

| 章节 | 文件 |
|---|---|
| §0 结论 · §1 需求 | `PLAN.md` |
| §2 总体架构 · §2.1 解耦规范 · §2.2 复用优先清单 | `docs/module-spec.md` |
| §3 关键难点与路线（§3.1–§3.5） | `docs/module-spec.md` |
| §4 运行环境/技术栈/目录结构/模块边界（§4.1–§4.4） | `docs/module-spec.md` |
| §5 配置与平台策略（§5.1–§5.6） | `docs/module-spec.md` |
| §6 数据模型（§6.1–§6.6） | `docs/module-spec.md` |
| §7 异步任务（§7.1–§7.7） | `docs/module-spec.md` |
| §8 WSL2 细节（含 §8.4 最小实验） | `docs/module-spec.md` |
| §9 分阶段计划与 DoD | `docs/tasks.md` |
| §10 风险合规 · §11 决策 · §12 官方 API · §13 版本摘要 | `docs/decisions.md` |

## 项目状态（快照）

| 项 | 状态 |
|---|---|
| 阶段 | **P0–P4 完成**：纯核心 + 插件骨架/异步任务/Mock 全链路（P0/P1）+ 真机通道（P2）+ 美团真机全流程抓价（P3）+ **多平台（饿了么）+ 策略四态 + 谨慎互斥 + 统一输入快照分组（P4）**；下一步 **P5 打磨** |
| 代码 | `src/*` 全部模块落地；`price_agent` 异步工具可用（Mock/真机）；P4 新增 `price/strategies.ts`（策略四态+互斥）、`platform/elemeReal.ts`、`platform/settleRows.ts`、`platform/navigator.ts`，并贯通 `snapshotId/hash` |
| 工具链 | TypeScript 5.9 / ESLint 10 / Prettier 3 / `node --test`；`pnpm check` 全绿（120 tests，`src/price` 行覆盖 97%+） |
| 文档 | 本套四件（本文 + `docs/` 三件）+ `CHANGELOG.md` |
| 已锁定决策 | Android 全自动 adb 无线调试；首期美团+饿了么；结算页实付为准；招行周三+美团神券基准；先 P0+P1（Mock 先行）；无线调试方案 c（详见 §11） |

## 怎么用这套文档

1. **新人 / 评审**：先读本文件 §0 结论 → 再按需跳 `docs/module-spec.md`。
2. **实现（按模块）**：**只读** `docs/modules/NN-*.md` 中对应那一份（+ 其"共享规则清单"里点到的 §号）。**不要整份重读 `module-spec.md`**，它是共享/跨模块规范，供查证而非通读。
3. **查"为什么"**：看 `docs/decisions.md` 与 `CHANGELOG.md`。
4. **改文档**：模块内的东西改 `docs/modules/*`；跨模块契约（§6 数据模型、§7 异步/幂等/并发、§4.4 边界）才改 `module-spec.md`；**不要改章节编号**。

---

## 0. 先看结论（TL;DR）

- 能做成，但**核心难点不是 DSH 插件，而是"打开手机 App 并抓到真实价格"**这一层。
- **路线 A（已锁定，Android + adb 无线调试）**：DSH 插件通过 `adb` 驱动 **Android 手机上的真实 App**，模拟"打开 App → 搜索 → 选门店 → 进结算页 → 读取实付价"，把价格读回来给 AI 比价。
- **路线 B（仅备用）**：平台开放平台 API（美团/饿了么商家侧）。面向商家/服务商，普通个人拿不到、有资质门槛，**不作为主路径**。
- **iPhone 不可控**，不纳入本期（见 §3.2）。
- **"到手价"必须在 App 的结算页里读**：红包/满减/信用卡立减只有到结算环节才真实生效，搜索列表页价格不准——这是整个方案的设计基准。
- **v0.4 九条一致性与可靠性约束**（本轮新增，详见对应小节）：
  1. **双口径防重复计算**：`payable`（结算页实付，纯事实）与 `effectivePrice`（仅扣"已验证且未含在实付里"的优惠）；每条优惠带 `alreadyIncludedInPayable`（§5.3）。
  2. **额度规则不假精确**：额度字段只用于"排除已知不可用"，不得用于"断言可用"（§5.5）。
  3. **统一输入快照**：所有平台从同一 `snapshotId/hash` 派生，条件偏离即归入不可比组（§6.6）。
  4. **任务绝不重复执行 + 结果不丢**：幂等键 + 单飞锁 + 真机互斥 + `runToken` + 原子写结果（§7.5）。
  5. **WSL2 无线调试最小可验证实验**：10 分钟判定通过/失败，作为 P2 门槛（§8.4）。
  6. **口径冲突已消解**：结算页实付 vs 含信用卡最低价，用双口径分列（§5.3）。
  7. **合规口径全文统一**：不承诺"不违反条款"，而是"低频只读、不自动下单/支付、不突破风控"（§10）。
  8. **OCR 质量评估独立于 zod**：先评识别质量，再算术校验，OCR 永不单独产出 `high`（§6.3.4）。
  9. **每阶段有可判定验收标准（DoD）**（§9）。
- **v0.5 三条明文规范（Normative，本轮新增）**：
  10. **解耦规范（§2.1）**：单向分层依赖、DI 总线（Driver/Ocr/Clock/Fs/Jobs 注入）、Mock 契约（切换 `mock|adb` 不改业务代码）、纯核心边界、与 DSH 运行时/前端解耦。
  11. **幂等规范（§7.6）**：键的确定算法（**不含时间窗**）、必幂等/必不幂等操作清单、同键同结果语义、同键异参 `409`、键与结果的保留期 `idempotencyTtl`、崩溃恢复边界。
  12. **并发控制规范（§7.7）**：三层锁固定顺序（设备锁→快照单飞锁→文件锁）、串行队列语义、竞态清单与对策、文件锁可接管（心跳 30s）、`503 BUSY` 语义。
- **v0.6 复用优先（本轮新增，防重复造轮子）**：
  13. **复用优先清单（§2.2）**：3 处已自写能力改为复用 DSH 内置——持久化→`ctx.storageDomain`、原子写/锁→`dsh-atomic-write`、任务→`ctx.jobs`；另复用 `dsh-native-command`（adb）、`cordis-plugin-timer`（超时）、`dsh-user-questions`（人工介入）、`dsh-output-retention`（截断）。并明确**保留自建**的业务本体（device/price/platform/ocr）与**禁止引入**的第三方件。
- **v0.7 四项工程基线（本轮新增，Normative）**：
  14. **运行环境（§4.1）**：WSL2/Ubuntu 26.04、Node v24.22 直跑 `.ts`、pnpm 12.14、DSH 0.2.1-rc.2、Android 11+、adb、tesseract.js(WASM)、零原生编译；含开工前环境自检。
  15. **技术栈（§4.2）**：TS(ESM)+schemastery+zod4+defineTool+cordis+storageDomain+atomic-write+ctx.jobs+runNativeCommand+fast-xml-parser+tesseract.js+`node --test`；依赖收敛为 zod/schemastery(+2 可选)。
  16. **目录结构（§4.3）**：完整树 + `package.json` 关键字段（exports/dsh.bundle/engines/peer/deps/scripts）。
  17. **模块边界（§4.4）**：分层图 + 每模块"职责/公开 API/允许依赖/禁止"表 + 6 条可 CI 校验的硬规则（price 纯核心无 IO、task 不 import 设备实现、共享类型唯一真源、循环依赖=0 等）。

> **已锁定 7 项决策（见 §11）。** 交付节奏：先做 **P0 算法 + P1 插件骨架（Mock 数据，含异步任务流）**，再进 P2 真机。

---

## 1. 需求拆解

把一句话需求拆成可实现的 5 个能力：

| # | 能力 | 说明 | 归属模块 |
|---|---|---|---|
| C1 | 把"我想吃香叶的烤鸭饭"变成结构化查询 | 菜品关键词、门店名、城市/位置、预算偏好、优惠策略 | `price_agent` 工具（LLM 侧） |
| C2 | 在指定平台 App 内检索并进入结算页 | 打开 App、搜索关键词、选门店/规格、进结算页 | `device_driver`（adb） |
| C3 | 从结算页抓取"实付价"与费用明细 | 商品价、配送费、打包费、红包抵扣、会员券、信用卡立减、实付总额 | `device_driver` + OCR/控件解析 |
| C4 | 按平台策略计算"最终到手价" | 把各平台绑定的信用卡/会员/红包规则折算进去，统一口径 | `pricing` 引擎 |
| C5 | 对比所有平台，输出最低价方案 | 排序、标注差异、给出"为什么更便宜" | `price_agent` 工具 |

**关键口径（务必对齐）**：比价的"价" = **结算页实付金额**（含所有自动生效的优惠）。需要手动领券/绑卡才能触发的优惠，**不计入主价**，只作为提示（避免乱点、防止误下单）。

---

## 附录：拆分说明（v0.8.0）

- 原 `PLAN.md`（v0.7.0，1252 行，§0–§13）拆为：`PLAN.md`（§0–§1）+ `docs/module-spec.md`（§2–§8）+ `docs/tasks.md`（§9）+ `docs/decisions.md`（§10–§13）。
- **章节编号保持不变**，故所有 `§x.y` 引用（含代码注释、README、CHANGELOG 中的引用）无需改动即仍指向正确内容。
- 迁移记录见 `CHANGELOG.md` 第 15 条。

*项目总纲 · 文档版本 v0.8.0*
