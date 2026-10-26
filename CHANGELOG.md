# 项目变更记录 · CHANGELOG

> 项目：**dsh-plugin-price-agent**（手机外卖比价 DSH 插件）
> 说明：从项目建立开始，**每一次变动**都按「**时间 / 为什么（Why） / 做了什么（What） / 更新后状态（State）**」记录在此。
> 约定：后续每轮改动（文档、代码、配置）都在本文件**追加**一条，不要覆盖旧条目；`PLAN.md` 的版本号变化对应到这里的文档类条目。

---

## 项目当前状态（快照）

| 项 | 状态 |
|---|---|
| 阶段 | **P0+P1 完成** + **P2 真机通道代码完成**（真机 §8.4 PASS 待用户连机判定），下一步 P3 单平台抓价 |
| 代码 | P0 `src/price/*`；P1 `core/task/platform/device/ocr/tools`（Mock 全链路）；P2 `device/{adb,uixml,probe,recover,pageDetect,steps,capture}` + `probe/selfCheck`；**82 测试**、price 行覆盖 95.5% |
| 规范 | **`AGENTS.md`**（自动加载）：安全红线 / 按模块读文档 / 修改 / 测试 / 提交 / DoD |
| 文档 | **总纲** `PLAN.md` + **共享规范** `docs/module-spec.md`（§2–§8）+ **每模块说明** `docs/modules/*`（只写模块特有）+ **任务** `docs/tasks.md`（§9）+ **决策** `docs/decisions.md`（§10–§13）+ 本 `CHANGELOG.md` |
| Git | `main`；`f88433d`(init) → `74af302`(骨架) → `55f5516`(工具链) → `e6a8b35`(文档拆分) → `3cf19c1`(模块文档) → 本次(AGENTS+基础工程) |
| 已锁定决策 | Android 全自动 adb 无线调试；首期美团+饿了么；结算页实付为准；招行周三+美团神券基准；先 P0+P1（Mock 先行）；无线调试方案 c |
| 环境（已实测） | WSL2 / Ubuntu **26.04.1 LTS**；Node **v24.22.0**；pnpm **12.14.0**；npm 11.19.1；**adb 未安装** |

---

## 变更时间线

### [1] 2026-10-21 21:47–21:56 · 仓库初始化
- **为什么**：为项目建立版本管理起点。
- **做了什么**：`git init`，生成初始提交 `f88433d chore: init repository`（空仓库，无业务文件）。
- **更新后状态**：仅有 `.git`，工作区为空；远端为 `git@github.com:whisperliu/AI-agent.git`。

---

### [2] 2026-10-21 22:27–22:29 · 需求登记 + 架构/环境调研（第 1 轮对话）
- **为什么**：用户提出完整需求，并要求**先出详细方案 MD、看过再决定是否执行**。
  需求要点：用 DSH + AI 沟通"想吃什么"→ 调用自写插件 → 打开手机上的外卖 App（如美团）→ 搜索门店、取菜单价格与**到手费用（含红包）**→ 支持**按平台配置信用卡/会员折扣策略**并计入价格 → 对比各外卖平台，**列出最低价**。
- **做了什么**：
  1. 调研 DSH 插件机制：`defineTool` + `ctx.tools.register`（工具注册）、`cordis.patch.yml` / `package.json.dsh.bundle.patch`（插件打包与注入），参考内置包 `@deepseek-ai/dsh-tool-todo`、`dsh-experimental-tool-worktree`。
  2. 摸清宿主环境：**WSL2 / Ubuntu 26.04**、Node v24.22.0、pnpm 12.14.0、**无 adb**、无 Android SDK。
  3. 确认关键事实：美团/饿了么**消费者侧无公开价格 API**；iPhone 无合法自动化通道；"到手价"须到**结算页**才真实。
- **更新后状态**：方案设计成型，尚无论文件落盘。

---

### [3] 2026-10-21 22:29–22:40 · 创建 `PLAN.md` v0.1
- **为什么**：用户要求先给详细方案（MD）评审，不直接执行。
- **做了什么**：新建 `PLAN.md`（约 344 行），包含：目标与结论、需求拆解 C1–C5、总体架构图、设备驱动路线 A/B、iPhone 说明、插件工程结构、平台/用户策略模型、数据模型、`price_agent` 工具接口、WSL2 环境约束、分阶段计划 P0–P5、风险合规、**7 个待确认决策点**、不用官方 API 的理由。
- **更新后状态**：`PLAN.md` v0.1 评审稿；**未改任何代码**。

---

### [4] 2026-10-21 22:39–22:40 · `PLAN.md` 升级 **v0.2**（按用户评审意见）
- **为什么**：用户提出 4 条工程改进 + 对 7 个决策点的回复，要求据此强化方案。
- **做了什么**（对应文档章节）：
  1. **新增 §3.5 前置规范与状态验证**：每步"动作 + Layout XML 断言 + 超时 + 弹窗/授权/加载恢复"，杜绝盲等；补页面契约、状态转移表、选择器优先级、超时预算。
  2. **新增 §6.3 zod 数值勾稽校验**：`商品+配送+打包−自动优惠 ≈ 实付`（±1.5 元或 5%），防 OCR 把 `¥28.9` 读成 `¥289`；失败分级处理。
  3. **重写 §7 异步任务架构**：`price_agent` 立即返回 `taskId`，用 DSH 内置 `ctx.jobs`（`dsh-jobs-local`）+ `JobHandle.updateProgress` 后台流式进度，复用 `dsh-client-ui-jobs`，规避 Tool 超时。
  4. **加固 §5.1 信用卡/平台券排他逻辑**：`id / quota{dailyLimit, monthlyLimit, totalQuota, lastUsedAt} / exclusiveGroup`，避免算出"享受不到"的虚低价；配套 `.price-agent/state.json` 记账。
  5. **深化 §6 数据模型**：门店加 `amapId/platformShopId`，商品加 `spec/matchedScore`，新增 `needsConfirm`、`evidence.extraction`。
  6. **§11 由"待确认"改为"已锁定决策"**；P1 明确包含异步任务流 + Mock 先行。
  7. 新增 §13 变更记录（文档自身版本历史）。
- **更新后状态**：`PLAN.md` = **v0.2（582 行）**；方案评审中；**仍无代码改动**。

---

### [5] 2026-10-21 22:47 · 建立项目变更记录 `CHANGELOG.md`（本条）
- **为什么**：用户要求"记录项目开始的每一次变动：为什么、做了什么、更新之后状态"。
- **做了什么**：新建本 `CHANGELOG.md`，补齐 [1]–[4] 历史条目并建立可复用的记录模板与状态快照；在 `PLAN.md` §13 增加指向本文件的交叉引用。
- **更新后状态**：文档双件 `PLAN.md`(v0.2) + `CHANGELOG.md`；代码仍未开始；等待用户确认开工 P0+P1。

---

### [6] 2026-10-21 22:51–22:56 · `PLAN.md` 升级 **v0.2.2**（按用户逐条缺陷审查修正）
- **为什么**：用户对 §6.3 / §5.1 / §6.2 / §7 / §8 / §3.x 提出 3 个代码级 bug、5 条"建议斟酌"与 3 个"小问题"，要求追加修订。
- **做了什么**（逐条对照）：
  1. **§6.3 zod 两处 bug 修正**：① `QuoteSchema` 补 `item` 字段（此前 `q.item?.qty` 恒 undefined→1，量级校验失效）；② `.refine` 第二参统一改用 zod4 推荐的 `{ error, path }`（`message` 仍兼容但属旧写法；本地 zod 4.6.7 实测两者均可）。
  2. **§6.3 容差收紧 + 配置化**：`max(1.5, 5%)` → `min(1.0, 5%)`，并可经 `platforms[x].priceToleranceYuan` 按平台配置（§4 示例已补该字段）。
  3. **§6.2 `cheapest` 兜底**：类型改 `Quote | null`，新增"全部 `needsConfirm` → `cheapest: null` 且 notes 提示'无可信结果，请人工核对'"的约定。
  4. **§5.1 weekday 歧义**：`weekday: 3` → `weekday: 'wednesday'`，并注明亦可 1–7（1=周一）。
  5. **§6.2 `Discount` 增 `platform`**；§5.4 记账键改为 `platform + strategyId`，让跨平台排他真正可落地。
  6. **§3.3/§6.2 `fees.listPrice`**：列表页价留痕，明确"不参与比价计算"。
  7. **§7 命名统一**：一律 `taskId`，删除 jobId 混用（§7.1 时序、§7.2 对接点）。
  8. **§8 版本改实测表**：本机实测 `node -v`=v24.22.0、`pnpm -v`=12.14.0、npm=11.19.1、`lsb_release -a`=Ubuntu 26.04.1 LTS (resolute)、内核 6.18.54.1 WSL2、`which adb`=未安装；并新增 §8.3「adb 探活与掉线重连」（每次任务前 `adb devices`，掉线自动重连一次，仍失败即报错提示）。
  9. **§4 目录树**补 `PLAN.md`、`CHANGELOG.md`。
- **验证方式**：`node -v`/`pnpm -v`/`npm -v`/`lsb_release -a`/`uname -r`/`which adb` 实跑确认（见 §8 表）；`grep` 复核无残留 `message:`/`jobId`/`weekday: 3`/`q.item?.qty`。
- **更新后状态**：`PLAN.md` = **v0.2.2**；代码仍**未开始**；仍为方案评审阶段。

---

### [7] 2026-10-21 22:56–23:02 · `PLAN.md` 升级 **v0.3.0**（六大结构性加固）
- **为什么**：用户指出 6 处结构性缺陷：① 价格校验只做算术勾稽、存在"双错也通过"的逻辑漏洞；② 信用卡/额度记账不可靠（本地记账当事实）；③ "同一顿饭"比较条件不完整；④ Android 自动化缺真实设备验证闭环；⑤ 异步任务缺完整生命周期（异常退出/取消/重启/过期/通知丢失）；⑥ 价格证据缺有效期与可追溯规范。
- **做了什么**：
  1. **§6.3 价格校验改两层**：`arithmetic`（算术自洽）与 `extraction`（识别可信度）**分开评定**；费用/优惠完整分类（`FeeLine` 带 `source`，`Discount` 带 `scope/source`）；"双错平账"判定矩阵；OCR 命中最高 `medium`；"勾稽通过≠金额正确"。
  2. **§5.4/§5.5 优惠四态**：`verified/presumed/known_unavailable/unknown` + `sourceOfTruth`；本地记账只降不升；`exclusiveGroup` 仅显式互斥，新增 `crossPlatformExclusive:false`（同卡跨平台默认不互斥）。
  3. **§6.2/§6.4 等价与分组**：新增 `ComparisonConditions`（数量/规格/加料/套餐组成/地址/送达时间）、`item.composition`；`CompareResult` 改 `groups[]`（不可比不混排）；`cheapest` 仅在同可比组内取。
  4. **§3.5.4 设备验证闭环**：新增能力探测 `probe`、多信号页面识别 `pageDetect`、截图基线对照、每平台"识别方式适用矩阵"、只读演练；不假定控件树一定可靠。
  5. **§7.5 任务全生命周期**：`tasks/*.json` 持久化、幂等 `idempotencyKey`、超时终止、取消确认、`getResult/listTasks` 重取、重启恢复、结果 `expired`；**完成状态与通知送达解耦**。
  6. **§6.5 证据规范**：`quoteId` 绑定、`capturedAt/validUntil` TTL、原始识别结果、`redaction`、清理、缺失降级；过期提示重新核价、禁止旧价当现价。
  7. 配套：§4 目录树新增 `device/probe.ts`、`device/pageDetect.ts`、`task/store.ts`、`task/lifecycle.ts`、`price/evidence.ts` 及 `lifecycle.test.ts`/`equivalence.test.ts`；§8 存储补 `tasks/`；§9 阶段计划（P0/P2/P4）与 §10 风险同步更新。
- **验证方式**：`grep` 复核无残留 `§6.6`/`usableNow`/`goods: money` 等旧结构；章节编号（5.1–5.5 / 6.1–6.5 / 7.1–7.5）连续一致。
- **更新后状态**：`PLAN.md` = **v0.3.0**（约 815 行）；代码仍**未开始**；仍为方案评审阶段。

---

### [8] 2026-10-21 23:04–23:10 · `PLAN.md` 升级 **v0.3.1**（Quote 与 QuoteSchema 对齐）
- **为什么**：用户指出 "Quote 与 QuoteSchema 尚未保持一致"——上一轮我把 §6.2 的 `Quote` 扩成完整模型，但 §6.3 的 `QuoteSchema` 仍停留在早期精简版，二者字段对不上，会导致实现时按 schema 落库却丢字段。
- **做了什么**：
  1. **§6.3.2 重写 `QuoteSchema`**，与 §6.2 `Quote` **逐字段 1:1**：补 `store`、`item.composition`、`arithmetic`、`extraction`、`needsConfirm`、`optionalSavings`、`evidence`；`DiscountLine`→`DiscountSchema` 并补齐 `kind/id/name`；配套 `ArithmeticSchema/ExtractionSchema/EvidenceSchema/OptionalSavingSchema`。
  2. **新增 `superRefine` 交叉校验**：`arithmetic.expected`/`balanced` 必须与 `fees/discounts/payable` 重算一致。
  3. **修正 zod 用法 bug**：实测 `ctx.addIssue` 用 `error` 会降级为 "Invalid input"，**必须用 `message`**；`.refine` 用 `{ error, path }`。文档已按实测分别书写。
  4. §6.2 末尾补"接口 ↔ schema 1:1 对应"说明。
- **验证方式（本地 zod 4.6.7 实跑）**：有效样例通过且 `qty`/`matchedScore` 默认值补齐；缺 `store`/`evidence` 被拒；`arithmetic.balanced=false` 撒谎、`arithmetic.expected=99` 撒谎均被 `superRefine` 精确指到字段报错；`addIssue` 的 `error` vs `message` 行为已逐项实测确认。
- **更新后状态**：`PLAN.md` = **v0.3.1**（约 860 行）；`Quote` 与 `QuoteSchema` 字段集合经脚本比对完全一致；代码仍**未开始**。

---

### [9] 2026-10-21 23:04–23:20 · `PLAN.md` 升级 **v0.4.0**（九项一致性与可靠性加固）
- **为什么**：用户一轮提出 9 个问题：① 优惠金额可能被重复计算；② 优惠额度规则无法可靠推导；③ 价格比较缺少统一输入快照；④ 异步任务需避免重复执行与结果丢失；⑤ WSL2 无线调试缺最小可验证实验；⑥ "结算页实付"与"含信用卡最低价"口径冲突；⑦ 合规描述前后不一致；⑧ OCR 校验不能替代识别质量评估；⑨ 开发计划缺明确的验收标准。
- **做了什么**：
  1. **重复计算（§5.3）**：`payable`（纯事实）与 `effectivePrice` 双口径；`Discount.alreadyIncludedInPayable/refundedBy`；`effectivePrice` 只扣 `verified && !alreadyIncludedInPayable`；`superRefine` 强制校验（实测重复扣/推测扣被拒）。
  2. **额度可推导性（§5.5）**：额度字段只用于"排除已知不可用"，禁止断言"可用"；`totalQuota` 不可观测一律 `unknown`；原 §5.5 记账下沉为 §5.6。
  3. **统一输入快照（§6.6）**：`snapshotId/hash`；所有 Quote 由同一快照派生；`deviatedConditions` 非空即归入不可比组。
  4. **任务不重复/结果不丢（§7.5）**：幂等键 + 单飞锁 + 真机互斥 + `runToken` + `tmp→rename` 原子写 + `checksum`；通知仅优化。
  5. **WSL2 最小实验（§8.4）**：10 分钟可判定脚本 + 通过标准 + 排障表，作 P2 门槛。
  6. **口径冲突（§5.3/§6.2）**：双口径分列，`cheapest` 按 `effectivePrice`（回退 `payable`）并同报两列。
  7. **合规统一（§3.1/§10）**：删除"不违反条款"，统一为"低频只读、不自动下单/支付、不突破风控、风险不为零、用户自担"。
  8. **OCR 质量评估（§3.3/§6.3.4）**：四步质量门（逐字段置信/二次比对/ROI 对照/合理性先验）；zod 仅算术护栏；OCR 永不单独 `high`。
  9. **验收标准（§9）**：每阶段补可判定 DoD（P0 五类用例+90% 覆盖；P1 幂等/取消/重取/过期；P2 §8.4 实验；P3 干扰注入；P4 快照一致）。
  10. 附带：`item.listPrice` 纳入 `Quote`/`QuoteSchema`；schema 增 `effectivePrice/deviatedConditions/listPrice`；§8 存储引用改 §5.6。
- **验证方式（本地 zod 4.6.7 实跑，直接抽取文档内 schema 执行）**：编译通过；有效样例通过且 `qty` 默认补齐；**重复扣、推测扣、缺 `store`、`balanced` 撒谎**四类负例均被 `superRefine`/结构校验拒绝。
- **更新后状态**：`PLAN.md` = **v0.4.0**（约 993 行）；代码仍**未开始**；仍为方案评审阶段。

---

### [10] 2026-10-21 23:17–23:30 · `PLAN.md` 升级 **v0.5.0**（三条明文规范）
- **为什么**：用户指出三处"有体现但无明文规范"：① 解耦（文档多处提 Mock/前后端解耦，无强制规范）；② 幂等"明显缺失"（仅有"幂等键"一句，无键算法/语义/冲突/保留期）；③ 并发控制（只有一个"单飞锁"词，无锁层次/竞态对策）。
- **做了什么**：
  1. **新增 §2.1 解耦规范**：R1 单向分层依赖；R2 DI 总线（Driver/Ocr/Clock/Fs/Jobs 注入，禁硬编码）；R3 Mock 契约（`mock|adb` 切换不改业务代码，`device/mock.ts`、`ocr/mock.ts`）；R4 纯核心（pricing 无 IO）；R5 与 DSH 运行时解耦（状态落 `.price-agent/`）；R6 前端解耦。
  2. **新增 §7.6 幂等规范**：键算法 `sha256(snapshot.hash ‖ 平台集 ‖ taskOptionsHash)`（**移除旧口径中混入的"时间窗"**）；必幂等/必不幂等操作清单；同键同结果语义（运行中/完成/失败/`force`）；同键异参 `409 IDEMPOTENCY_KEY_REUSED`；`idempotencyTtl` 保留期；崩溃恢复边界。
  3. **新增 §7.7 并发控制规范**：三层锁固定顺序（设备锁→快照单飞锁→文件锁，防死锁）；adb 单设备串行队列+排队提示；竞态清单与对策（`runToken` 丢弃迟到写、`state.json` 文件锁、先写键再执行、跨会话文件锁）；锁心跳 30s 可接管、`503 BUSY`。
  4. **§7.5(2) 收敛**为引用 §7.6/§7.7，删重复；**§4 目录树**增 `core/{container,clock,locks}.ts`、`device/mock.ts`、`ocr/mock.ts`、`task/idempotency.ts` 及 `idempotency/concurrency/decoupling` 测试；**§9 P1 DoD** 增补解耦/幂等/并发验收点。
- **验证方式**：结构检查（无重复标题、代码围栏 24 个成对）；`grep` 确认旧"hash + 时间窗"口径已清除；三处新规范小节均存在。
- **更新后状态**：`PLAN.md` = **v0.5.0**（约 1120 行）；代码仍**未开始**；仍为方案评审阶段。

---

### [11] 2026-10-21 23:30–23:45 · `PLAN.md` 升级 **v0.6.0**（复用优先，消除重复造轮子）
- **为什么**：用户问"文档内是否存在重复造轮子的风险"。核查 DSH 内置包后确认**确有 3 处**：文档自写了持久化 JSON 存储、原子写/文件锁、后台任务调度，而这些 DSH 已内置。
- **核查依据（实际读取 DSH 包）**：`dsh-base` 已挂载 `storage`/`storage-json`(`root=$DSH_HOME/storages`)/`storage-domain`、`jobs`(`dsh-jobs-local`)、`tool-jobs`、`timer`、`user-questions`、`subprocess`；`dsh-atomic-write` 提供 `writeFileAtomic`+`withWriterLock`（wx lock/PID/ESRCH 接管）；`dsh-native-command` 提供 `runNativeCommand`；`dsh-output-retention` 提供截断。
- **做了什么**：
  1. **新增 §2.2 复用优先清单**：逐项列出"早期自写→改为复用→依据"，含 7 类能力。
  2. **修订正文口径**：§2.1 R2/R5（Fs/Jobs 复用、存储用 storageDomain+atomic-write）、§5.6 记账（写 `ledger` 表）、§7.5(1)(5)(6)（storageDomain/`writeFileAtomic`，删自写 tmp→rename）、§7.7 R1/R3/R4（复用 `withWriterLock` 作设备锁/快照锁/资源写锁，删 `proper-lockfile` 语义与自写 30s 心跳）、§8.5（持久化位置改 storageDomain）、§4 依赖说明（列复用 seam、禁第三方重复件）。
  3. **明确保留自建=业务本体**：device/price/platform/ocr/tools 五大模块。
  4. **派生规则**：实现前查清单、只允许薄封装（adb→runNativeCommand、store→storageDomain 映射）、禁引 `proper-lockfile/write-file-atomic/lowdb/p-limit`。
  5. **§9 DoD**：P0 增"纯核心无 IO"，P1 增"抽查无自写存储/锁/spawn"。
- **验证方式**：`grep` 确认正文不再出现自写 `tmp→rename`/`state.json`/`proper-lockfile` 等旧口径（仅 §2.2 对照表保留"早期草稿"描述）；结构检查无重复标题、围栏成对。
- **更新后状态**：`PLAN.md` = **v0.6.0**（约 1157 行）；代码仍**未开始**；仍为方案评审阶段。

---

### [12] 2026-10-21 23:45–23:58 · `PLAN.md` 升级 **v0.7.0**（四项工程基线 Normative）
- **为什么**：用户要求明确"运行环境、技术栈、目录结构、模块边界"——此前只有零散提及（§4 一棵树、§8 环境表），缺规范性、缺技术选型、缺边界约束。
- **做了什么**：把 §4 拆成四个 Normative 小节：
  1. **§4.1 运行环境**：WSL2/Ubuntu 26.04、**Node v24.22 直跑 `.ts`**（实测）、pnpm 12.14、DSH 0.2.1-rc.2、Android 11+、adb（未装）、**tesseract.js(WASM)**（实测无系统 tesseract）、零原生编译；加环境自检命令。
  2. **§4.2 技术栈**：14 项选型表（TS/schemastery/zod4/defineTool/cordis/storageDomain/atomic-write/ctx.jobs/runNativeCommand/timer/userQuestions/fast-xml-parser/tesseract.js/node --test/ctx.logger）+ 依赖收敛。
  3. **§4.3 目录结构**：完整树（含 tsconfig、.gitignore、platform/types.ts、price/model.ts 类型真源）+ `package.json` 关键字段示意。
  4. **§4.4 模块边界**：分层依赖图 + 9 模块"职责/公开 API/允许依赖/禁止"表 + 6 条 CI 可校验硬规则。
  5. 同步：§8 声明"基线见 §4.1"；§9 P1 DoD 增边界可校验项。
- **验证方式**：实测 `node t.ts`→42、`node --test t.test.ts`→1 pass；`which tesseract`/`which tsc` 均为空（据此选 WASM 与 `node --test`）；结构检查无重复标题、围栏成对（28）。
- **更新后状态**：`PLAN.md` = **v0.7.0**（约 1252 行）；代码仍**未开始**；仍为方案评审阶段。

---

### [13] 2026-10-21 23:58–00:08 · 初始化仓库基线 + 建立基础目录骨架（首次代码提交）
- **为什么**：用户要求"初始化 Git 仓库并建立基础目录"。核查发现 Git **已存在**（`main`、初始提交 `f88433d`、远端 `origin`），故本步实际做"建立 §4.3 目录骨架 + 基线配置 + 首次提交"。
- **做了什么**：
  1. **目录骨架**：`src/{core,task,platform,platform/selectors,device,price,ocr,tools}`、`test/fixtures`，各置 `.gitkeep`（空目录可入 Git）。
  2. **基线配置**：`package.json`（`type:module`、`exports`、`dsh.bundle.patch`、`engines.dsh=0.2.1-rc.2`、peer/deps/optional/dev、`scripts.test=node --test`）、`tsconfig.json`（`noEmit`、`allowImportingTsExtensions`、strict）、`.gitignore`（忽略 `.price-agent/`、node_modules、原始截图）、`cordis.patch.yml`（mock 驱动 + 平台/超时/TTL/OCR 开关）、`README.md`。
  3. **最小可加载骨架**：`src/index.ts`（`name/inject/apply/Config`，apply 暂为空）、`src/config.ts`（schemastery `Config`）。
- **验证方式**：`package.json` JSON 解析通过；`import('./src/index.ts')` 报 `ERR_MODULE_NOT_FOUND`（仅因依赖未装，证明**语法通过**）；`node --test` 可运行（0 用例）；`git status` 确认新增文件。
- **更新后状态**：仓库基线建立；`src/` 骨架就位；业务实现待 P0/P1；本次将打首个代码提交。

---

### [14] 2026-10-22 00:08–00:30 · 配置开发工具链（TypeScript / ESLint / Prettier / 测试）
- **为什么**：用户要求配置 TS、ESLint、测试框架与格式化工具，作为写业务前的质量基座。
- **做了什么**：
  1. **TypeScript**：`tsconfig.json`（`noEmit`、`allowImportingTsExtensions`、strict、`noUncheckedIndexedAccess`、`types:["node"]`）；`typescript@5.9.3`（**必须 5.x**：typescript-eslint 8 要求 `<6.1`，而 latest 是 7.x）。
  2. **ESLint**：`eslint.config.js` flat config（`@eslint/js` + `typescript-eslint` recommended + `eslint-config-prettier` 兜底）；规则含 `consistent-type-imports`、`no-unused-vars(argsIgnorePattern:'_'`)、`eqeqeq`。
  3. **Prettier**：`.prettierrc.json`（无分号/单引号/`printWidth:100`/LF）+ `.prettierignore`；格式化了 `src/*`、`cordis.patch.yml`。
  4. **测试**：内置 `node --test`（不引 jest/vitest，`@types/node` 提供 `node:test` 类型）；加冒烟测试 `test/config.test.ts`（验 `Config` 默认值）。
  5. **脚本**：`typecheck/lint/lint:fix/format/format:check/test/test:watch/check`，其中 `check` 串联四道门禁。
  6. **环境适配**：本机 `$HOME` 只读、pnpm 12 的 store 操作锁写 `XDG_RUNTIME_DIR`（`/run/user/…` 只读）。添加 `.npmrc`(registry) + `pnpm-workspace.yaml`(`storeDir:.pnpm-store`、`strictDepBuilds:false`)；安装需 `HOME=$PWD/.home XDG_RUNTIME_DIR=$PWD/.run pnpm install`（README 已注明）。`.gitignore` 忽略 `.pnpm-store/.home/.run/.npm-cache` 等。
- **验证方式（均实跑）**：`tsc --noEmit` 通过；`eslint .` 0 问题；`prettier --check .` 全通过；`node --test` 1 pass；`pnpm run check` 四道门禁全绿。安装：`pnpm install` 成功（`@eslint/js@10.0.1`/`eslint@10.13.0`/`prettier@3.9.10`/`typescript@5.9.3`/`typescript-eslint@8.72.0`）。
- **更新后状态**：工具链可用；`pnpm check` 绿；业务实现仍待 P0/P1。

---

### [15] 2026-10-22 00:30–00:50 · 拆分 `PLAN.md` 为「总纲 + 模块规范 + 任务 + 决策」
- **为什么**：原 `PLAN.md` 1252 行把"总纲/规范/任务/决策"混在一起，检索与维护困难。用户要求拆成一整套职责分明的文档。
- **做了什么**：
  1. **`PLAN.md` → 项目总纲（Hub）**：目标、**文档地图**、章节→文件速查、项目状态、怎么用；保留 §0 结论 + §1 需求。
  2. **`docs/module-spec.md`（§2–§8）**：架构 / 难点 / 环境·技术栈·目录·边界 / 配置策略 / 数据模型 / 异步任务 / WSL2 —— 规范主体。
  3. **`docs/tasks.md`（§9）**：P0–P5 分阶段计划 + 每阶段 DoD + 当前进度。
  4. **`docs/decisions.md`（§10–§13）**：风险合规 / 已锁定决策 / 为何不用官方 API / 版本级摘要。
  5. **关键手法：章节编号全局不变（§0–§13）**，故全仓对 `§x.y` 的引用（正文、代码注释、README、CHANGELOG）**无需修改**即仍指向正确内容；每份文档头部标注"章节号沿用拆分前"并给出跨文件导航。
  6. `README.md` 状态行的文档指引改为四件套链接。
- **验证方式**：脚本比对拆分前（`git show HEAD:PLAN.md`）与拆分后 4 文件的**编号标题集合**——53 个编号标题 **完全一致（无缺失/无重复）**；`§` 引用无新增悬空（仅历史记录里原有的 `§8.3/8.5` 保留原样）；所有 Markdown 相对链接可达（修正 `docs/decisions.md` 内一处 `CHANGELOG` 链接为 `../CHANGELOG.md`）；代码围栏成对（module-spec 28）。
- **更新后状态**：文档四件套就位（总纲/规范/任务/决策）+ CHANGELOG；内容零丢失；代码仍待 P0/P1。

---

### [16] 2026-10-22 00:50–01:10 · 新增「每模块说明文档」并确立按模块阅读规范
- **为什么**：用户要求 ① 不要每次重读整份计划；② 每个模块的说明文档只写该模块特有的东西。
- **做了什么**：
  1. 新增 `docs/modules/`：`README.md`（索引与阅读规则）+ 9 份模块文档（00 入口 / 05 配置 / 10 core / 20 task / 30 platform / 40 device / 50 price / 60 ocr / 70 tools）。
  2. 每份只写**模块特有**：职责、公开 API（代码块）、内部实现要点、测试、**共享规则清单（仅标题+§号，不复制正文）**。
  3. 确立阅读规范：**按模块开发只读该模块那一份**；`module-spec.md` 仅作共享/跨模块查证，不通读。写入 `PLAN.md`「怎么用」第 2 条、`module-spec.md` §4.4 提示、`README.md`、`docs/modules/README.md`。
- **验证方式**：所有模块文档相对链接可达（0 broken）；9 份文档齐全且各自只含本模块内容（无重复任务/决策等全局内容）。
- **更新后状态**：文档 = 总纲 + 共享规范 + 9 模块说明 + 任务 + 决策 + CHANGELOG；阅读路径按模块收敛。

---

### [17] 2026-10-22 01:10–01:35 · 建立 AGENTS.md 与基础工程（含安全边界可执行化）
- **为什么**：用户要求建立 `AGENTS.md` 和基础工程，明确**修改规范、测试要求、不能自动提交订单或付款的安全边界**。
- **做了什么**：
  1. **`AGENTS.md`**（DSH `dsh-agent-instructions` 自动加载，根以 `.git` 标记）：§0 安全红线（禁止下单/支付、验证码即停、不破解/不抓包、本人设备低频、隐私脱敏、宁失败不越线）、§1 按模块读文档（禁止通读整份计划）、§2 修改规范（含**类型剥离限制**：不支持参数属性/enum/namespace）、§3 测试要求（price 覆盖率≥90%、必测场景、`pnpm check` 门禁）、§4 文档维护、§5 提交规范、§6 DoD。
  2. **基础工程**：`src/core/errors.ts`（`BusyError/StateAssertionError/NeedsHumanError/ForbiddenActionError`）、`src/core/safety.ts`（`assertTapSafe`，**程序化拦截**下单/支付点击）、`scripts/check-boundary.mjs`（**零依赖**静态校验 §4.4 分层规则 R1–R4 + 循环依赖）、`.editorconfig`。
  3. **脚本/门禁**：`boundary`、`test:coverage`（Node 内置 coverage）；`check` 串联 `typecheck → lint → format:check → boundary → test`。
  4. **ESLint**：新增 JS 脚本的 Node globals；TS 关闭 `no-undef`（tsc 负责）。
  5. 同步：`docs/modules/10-core.md`（safety/errors）、`docs/modules/40-device.md`（tap 前必过护栏）、`docs/module-spec.md` §4.4（循环依赖改由脚本校验）、§4.1（类型剥离限制）、`README.md`（指向 AGENTS.md）。
- **验证方式（均实跑）**：`pnpm check` 全绿（typecheck/lint/format/boundary/5 tests）；边界检查**负例**验证——临时在 `src/price/` import `node:fs` → R1 报错退出 1，删除后恢复通过；安全护栏 `test/safety.test.ts` 4 例（中文/英文大小写/仅 resourceId/无害标签）。
- **更新后状态**：`AGENTS.md` 生效；安全边界**代码可执行**（非仅文档）；门禁新增边界检查；业务仍待 P0/P1。

---

### [18] 2026-10-22 01:35–02:10 · P0：price 纯核心 + 测试（覆盖率达标）
- **为什么**：按 `docs/tasks.md` 的 P0 开工——实现比价纯核心（双口径、四态、两层校验、等价分组）并达成 DoD。
- **做了什么**（仅 `src/price/*`，严格遵守 §4.4 纯核心：只依赖 `zod`）：
  1. `model.ts`：类型唯一真源（`Quote/FeeLine/Discount/OptionalSaving/Evidence/ComparisonConditions/CompareResult` + 引擎输入 `QuoteDraft/EvidenceDraft`）。
  2. `schema.ts`：zod4 校验；`superRefine` 交叉校验 `arithmetic`/`balanced` 是否诚实、`effectivePrice` 是否重复扣；导出 `expectedPayable/deductibleSavings/toleranceFor`。
  3. `engine.ts`：`assess()`（两层结论 + §6.3.1 矩阵）、`priceQuote()`（`effectivePrice = payable − Σ(verified && !已含)`）、`compare()`（按等价分组；**cheapest 只在单一可比组内取，禁止跨组混排**）。
  4. `similarity.ts`（门店/商品相似度 + `isSameMeal` 含套餐组成/数量/规格）、`evidence.ts`（TTL/完整性/缺失说明）。
- **关键修复（实现中发现的设计缺陷）**：初版 `cheapest` 取"所有可比组内全局最小"——这正是 §6.2/§6.4 禁止的**跨组混排**。已改为"仅当存在唯一可比组时才在组内取最小；多组则分组呈现、不选全局最低"。
- **验证方式（实跑）**：`pnpm check` 全绿（typecheck/lint/format/**boundary 9 files**/36 tests）；`pnpm test:coverage` = `src/price` **行 95.51% / 分支 76.23% / 函数 92.31%**（阈值 line≥90/branch≥70/funcs≥80 通过）。测试覆盖：`¥28.9→¥289`、**双错平账**（算平但 OCR→medium→needsConfirm）、**重复扣**（verified 但 alreadyIncluded 不重复扣）、**推测当可用**（presumed 不减价）、**不可比分组**、过期证据排除、`deviatedConditions` 强制不可比、相似度/证据 TTL。
- **更新后状态**：P0 完成，`src/price` 可用且被测试锁定；下一步 P1（插件骨架 + 异步任务 + Mock）。

---

### [19] 2026-10-22 08:20 · P1：插件骨架 + 异步任务 + Mock 全链路（解耦/幂等/并发/取消/重取/过期）
- **为什么**：按 `docs/tasks.md` 的 P1 开工——把 P0 纯核心接成一个可在 DSH 里"一句话 → taskId → 实时进度 → 分组比价 → 证据过期/重取"跑通的异步工具，并落实 §2.1 解耦、§7.5 生命周期、§7.6 幂等、§7.7 并发。
- **做了什么**（新增/改动文件）：
  1. **共享类型**：`src/price/model.ts` 增 `TaskStatus/TaskFailureReason/TaskRecord/IdempotencyRecord/StartInput/StartReply/GetResultReply/CancelReply/TaskSummary/CompareOptionsSpec`（唯一真源，其它模块 `import type`）。
  2. **core**：`clock.ts`（`SystemClock`+可推进 `FakeClock`）、`locks.ts`（薄封装 `dsh-atomic-write` 的 `withFileLock`，超时→`BusyError`）、`container.ts`（`Deps/JobsPort/ProgressPort` 契约 + `buildCapabilities` 组合根 + `TaskDomainSpec` zod 领域）、`jobs-adapter.ts`（`ctx.jobs`→`JobsPort` 适配）。`errors.ts` 增 `IdempotencyConflictError/TaskNotFoundError`。
  3. **device/ocr**：`driver.ts` 接口、`mock.ts`（点击 open-<platform> 回放结算页 dump）、`mock-data.ts`（脱敏 fixtures）、`adb.ts`（runNativeCommand 骨架，P2 完善）、`state.ts`（断言）；`ocr/reader.ts`+`mock.ts`。
  4. **platform**：`types.ts`（`PlatformStrategy/RawQuoteFacts`）、`extract.ts`（dump→事实）、`xml.ts`（零依赖 XML 解析）、`selectors/generic.ts`、`meituan.ts`/`eleme.ts`、`router.ts`。
  5. **task**：`snapshot.ts`（§6.6 快照）、`hash.ts`（sha256/稳定序列化）、`idempotency.ts`（键=sha256(snapshot.hash‖平台集‖options)，**不含时间窗**）、`store.ts`（storageDomain 薄封装）、`progress.ts`、`runner.ts`（设备锁内串行驱动 + `draftFromFacts`→`priceQuote`→`compare`）、`lifecycle.ts`（`startTask/getResult/listTasks/cancel/recoverOnStartup`；结果 `writeFileAtomic`+checksum+runToken；过期→`expired`；取消确认不覆盖终态）。
  6. **tools/index**：`tools/price-agent.ts`（`defineTool` 单工具多 action `start/getResult/listTasks/cancel` + 可离线单测的 `dispatch` + 比价表 `formatCompareResult`）；`src/index.ts` 装配（打开领域→能力→jobs 端口→恢复→注册工具）；`config.ts` 增 `task.lockWaitMs` 与默认值；`cordis.patch.yml` 同步。
  7. **门禁**：`scripts/check-boundary.mjs` 增 R5（device/ocr 不得 import price/task/platform/tools）、R6（core 不得 import task/tools 或 device 实现；仅 `container.ts` 为组合根例外）、R3 增 `dsh-jobs`。
- **验证方式（实跑）**：`pnpm check` 全绿（typecheck/lint/format/**boundary 35 files**/**54 tests**）；`pnpm test:coverage` 仍 **src/price 行 95.51% / 分支 78.33% / 函数 92.31%**（≥阈值）。新增测试覆盖 P1 DoD：①全链路 `start→getResult` 出分组比价表（美团 26.9 < 饿了么 27.0 → cheapest=meituan）；②解耦（切 mock/adb 不改业务，price 脱离设备单测）；③幂等（同键并发 10 次=1 任务、同键异参冲突、键不含时间窗）；④并发（设备锁下两任务串行不交叉、锁超时→BusyError=BUSY）；⑤取消（运行中取消→cancelled 且不被 failed 覆盖）；⑥重取（重启恢复 processing→failed(interrupted)、getResult 可重复）；⑦过期（TTL 后→expired，不返回旧价）；⑧结果原子写+checksum/runToken 校验。
- **复用说明（§2.2）**：新增依赖 `@deepseek-ai/dsh-atomic-write`（原子写/文件锁）、`@deepseek-ai/dsh-jobs`（jobs 类型 + JobKindMap 合并）、`@deepseek-ai/dsh-storage-domain`（schema 校验持久 KV）；未自写存储/锁/任务调度。
- **安全红线**：无下单/支付路径；`assertTapSafe` 仍在每次 `driver.tap` 前调用；Mock 不触网、无凭证入库。
- **更新后状态**：**P1 完成**，`price_agent` 异步工具在 Mock 数据下可用；下一步 P2（真机通道）。

### [20] 2026-10-22 12:50 · 把插件接入 web GUI 的运维脚本（profile 只读环境下的两种装法）
- **为什么**：本会话沙箱 `/` 为只读挂载，无法写 `~/.dsh/profiles/web`；需要一个可复现、已实测能真实加载插件的方式接入 GUI。
- **做了什么**：
  1. `scripts/install-into-web-profile.sh`：在可写 `~/.dsh` 的宿主机 shell 里，把仓库软链到 `profiles/<p>/node_modules/dsh-price-agent` 并在 `cordis.patch.yml` 去重追加 `insert`（含 `.bak` 备份、可写性/依赖预检、幂等）。已用模拟 profile 实测两次运行只插 1 段。
  2. `scripts/web-plugin.patch.yml`：`dsh --patch` 运行时叠加层，仅新增 `price-agent`（绝对路径加载 `src/index.ts`），沿用 profile 自身模型路由。
- **验证方式（实跑）**：
  - 用**隔离 `DSH_HOME`** 构造与真实 web 同构的 profile：`--dump-config` 组合树含 `price-agent`；`dsh --profile web` 真实启动 → HTTP 401（token 门），无 import/配置错误。
  - 差分对照：坏路径 → `ERR_MODULE_NOT_FOUND`；真实路径 → 正常启动。证明是"真加载"而非仅合并。
  - 另起**备用 GUI**（工作区内 `DSH_HOME`，端口 3096，`--patch scripts/web-plugin.patch.yml`）实测：`:3096` root→401、带 token→303，且不影响现网 `:3080`。
- **未做/边界**：因只读挂载，未直接改写现网 `:3080` 的 profile（需用户手动重启以加载）。
- **更新后状态**：接入 GUI 两条路径就绪并实测；插件本体仍为 Mock 驱动。

### [21] 2026-10-22 12:58 · 修复：接入现网 web 后真调用暴露的 job owner 缺陷 + 幂等卡死回滚
- **为什么**：方式 A 装进 `:3080` 后插件确实加载（`price_agent` 已出现在工具集），但真调用报
  `background jobs unavailable: no job controller serves this agent`——`dsh-tool-jobs` 的 controller 按 agent scope 挂载，job 必须带 `owner = exec.agent.id`（DSH 自带 bash 亦如此），我们漏传。
- **做了什么**：
  1. owner 贯通：`exec.agent.id` → `dispatch(…,{owner})` → `startTask(opts.owner)` → `deps.jobs.start({owner})`；`jobs-adapter` 改为**每次调用**用 `spec.owner`（不再构造期固定）。
  2. **幂等卡死回滚**：`jobs.start` 抛错时回滚已写的 `idempotency` 映射并把任务置 `failed`，避免"幂等命中却永不执行、永久 queued"。
  3. `force=true` 重跑选项（§7.6 R3）；复用失败/取消记录时给出诚实提示"如需重跑请加 force=true"。
- **验证方式（实跑）**：`pnpm check` 全绿（typecheck/lint/format/boundary/**56 tests**）；新增 `test/jobs-owner.test.ts`（owner 必传、jobs.start 失败→幂等回滚且后续同输入可新建并完成）。真实 `:3080` 复现并定位（存储里 `price-compare-…` 卡在 `queued/error=null`）。
- **边界**：运行中的 `:3080` 仍是旧代码（Node 不热更服务端插件），需**再重启一次**加载修复。
- **更新后状态**：接入 web 的可用性缺陷已修；重启后即可在 GUI 内真实比价。

### [22] 2026-10-22 13:05 · 新增会话对话记录（元数据追踪）
- **为什么**：用户要求把本次会话每一轮对话记录下来，便于元数据追踪与复盘。
- **做了什么**：新增 `docs/conversation-log.md`——含会话元数据、逐轮(人类请求)表、逐轮 Why/What/Verify 详情、关键修复/决策、交付物清单，以及附录 JSON 机器可读元数据（session/turns/fixes/deliverables）。把系统时间采样/ job 通知 / 工具重试等非人类消息折叠，仅保留实际人类请求轮次。
- **验证方式**：时间戳取自会话采样/提交记录/文件 mtime；提交与文件清单与仓库实际状态核对一致。`*.md` 已在 `.prettierignore` 中，不影响门禁。
- **更新后状态**：会话可追溯；后续轮次可继续追加到该文件。

### [23] 2026-10-22 13:11 · 会话收尾：对话记录最终快照（P1 收工）
- **为什么**：用户收尾「P1收工」，按约定生成对话记录的最终快照。
- **做了什么**：`docs/conversation-log.md` 补全时间跨度(08:14→13:11)与结束状态、追加轮次12、更新 JSON `end` 与页脚。
- **验证方式**：仅文档变更；`pnpm check` 56 tests 绿。
- **更新后状态**：P1 阶段收尾；后续从 P2 真机（adb）继续。

### [24] 2026-10-22 13:25 · P2：真机通道 + 能力探测 + 弹窗恢复 + 只读演练
- **为什么**：按 `docs/tasks.md` P2 开工——把 Mock 能力换成可驱动真机的 adb 通道，落实"连接/重连 + 能力探测 + 页面识别 + 每步动作×断言×超时×恢复 + 失败截图/dump 留证"，并给出 §8.4 无线调试最小实验与只读演练脚本。
- **做了什么**：
  1. **device 层新增/重写**：`adb.ts`（真实 adb 驱动：`AdbRunner` 注入边界、`ensureConnected` 探活+掉线 `adb connect` 重连 1 次、`dump` 直出/回退 `/sdcard`、`tap` 按 bounds 中心点、`input` 转义、`swipe`、`screencap` 走 `pull` 二进制、`probe` 采集机型/分辨率/前台包名/识别质量）；`uixml.ts`（含 bounds/class/clickable 的 XML 解析）；`probe.ts`（`analyzeDump` 树丰富度+降级建议、PNG 校验、`wm size`/前台包名解析）；`recover.ts`（验证码/登录/升级/广告/权限/加载分类，**验证码/登录立即 `NeedsHumanError`、绝不点击**）；`pageDetect.ts`（多信号页面识别）；`steps.ts`（`waitForState/tapAndExpect`… 动作+断言+超时+恢复+失败取证）；`capture.ts`（`writeFileAtomic` 落 dump/截图到 `.price-agent/evidence`）；`state.ts` 增文案断言（`presentTexts`）。
  2. **配置**：`config.ts` 增 `device.adbPath`（默认 `adb`）、`device.autoReconnect`（默认 true）；同步 `cordis.patch.yml`、`scripts/web-plugin.patch.yml`。
  3. **工具/任务**：`price_agent` 增 `probe`（能力探测）、`selfCheck`（§8.4 最小实验）两个 action；`task/lifecycle.ts` 增 `probeDevice/runMinExperiment`（Mock 下返回 `supported:false`，真机走驱动 `probe()`，全程只读）；`task/runner.ts` 真机进设备锁后自动跑一次 `probe` 写进进度（Mock 无 `probe` 则跳过，P1 行为不变）。
  4. **运维脚本**：`scripts/device-min-experiment.sh`（§8.4 bash 逐条判定）、`scripts/device-rehearsal.mjs`（只读演练，产出 JSON+Markdown 能力探测报告到 `.price-agent/reports/`）。
  5. **依赖**：新增 `@deepseek-ai/dsh-native-command@0.2.1-rc.2`（既定的 adb 执行库，§2.2 复用）。
  6. **安全修复（P2 发现的真实红线漏洞）**：`core/safety.ts: assertTapSafe` 原先只检查 `label/resourceId`，**漏检 `text`**——即 `tap({text:'提交订单'})` 会绕过护栏。已改为同时检查 `label/resourceId/text`，并补回归测试 `blocks when only text selector matches`。
  7. 沙箱内把 platform-tools（adb 1.0.41）解压到 `.home/android-sdk/`（被 `.gitignore` 的 `.home/` 忽略），用于本地实测。
- **验证方式（实跑）**：`pnpm check` 全绿（typecheck/lint/format/**boundary 38 files**/**82 tests**）；`pnpm test:coverage` 仍 **src/price 行 95.51% / 分支 78.33% / 函数 92.31%**（≥阈值）。新增 `test/device-p2.test.ts`（23 tests，全离线、注入假 runner）覆盖：uixml 解析/中心点、`analyzeDump` 原生树→tree 与 WebView 空壳→ocr/human、`isValidPng/parseWmSize/parseForeground`、验证码抛 `NeedsHumanError` 且从不点击、升级弹窗恢复、页面识别、**下单控件被拦且不产生任何 adb 调用**、截屏走 pull 二进制、`probe` 采集、超时写 dump 证据抛 `StateAssertionError`、mock/adb 两条 `probeDevice/runMinExperiment` 路径。真实 `runNativeCommand('adb',…)` 在无设备环境下返回可读错误"未检测到在线 Android 设备"，不崩。
- **未做/边界**：**本沙箱无真机**（`adb devices` 为空，用户手机未连接），§8.4 最小实验的"真机 PASS"需用户在本机连手机后运行脚本判定；真实点击坐标/页面契约需 P3 用真机 dump 校准。隐私：截图仅落本地 `.price-agent/`、`chmod 600`、不上传。
- **更新后状态**：P2 代码完成；`device.driver=adb` 即可在 GUI 用 `probe/selfCheck/start`；下一步 P3 单平台抓价。

### [25] 2026-10-22 15:08 · 会话最终收尾快照（轮次14）
- **为什么**：用户 15:08 发「收尾」。
- **做了什么**：`docs/conversation-log.md` 时间跨度→15:08、结束状态、更正"期间提交"（P2 `251c4e6`/`e34301c` 已提交）、追加轮次14、JSON/页脚更新。
- **验证方式**：`pnpm check` 82/82 绿；仅文档变更。
- **更新后状态**：本次会话收尾；HEAD `e34301c`；下一步 P3。

### [26] 2026-10-24 13:35 · P2 真机 §8.4 最小实验 PASS（Lenovo TB321FU 无线调试）
- **为什么**：用户接入安卓平板要求做真机测试；此前 P2 的"真机 PASS"一直挂在"用户本机连机"上。
- **做了什么**：
  1. **连接方式定为无线调试**：USB 直连不可行——实测数据线仅充电（Windows `usbipd list`/PnP 全程无 Android/MTP 设备列举），且 WSL 侧 `sudo` 被 `no new privileges` 锁死、`modprobe vhci-hcd` 返回 `Operation not permitted`、无 `usbip` 客户端，usbip 路径走不通。改走无线调试：pad 与电脑 WLAN 同网段 `192.168.3.x`（WSL 镜像网络自动获得 `192.168.3.45/24`）。
  2. **配对与连接**：`adb pair 192.168.3.44:42261 223029` 成功（guid=`adb-HA26JA4H-Qwlhvj`）；`adb connect 192.168.3.44:44881` → `device`。
  3. **密钥归属修正（关键）**：dsh 进程以 `HOME=/home/liuqiaoqiao` 运行，而配对密钥原本落在 `.home/andhome/.android/`。已将 `adbkey/adbkey.pub/adb_known_hosts.pb` 同步到 `/home/liuqiaoqiao/.android`（`chmod 600`），使插件用默认 HOME 启动 adb 即可免授权连接。
  4. **配置切真机**：`~/.dsh/profiles/web/cordis.patch.yml`（运行时实际加载）的 `device` 段由 `driver: mock / serial: auto` 改为 `driver: adb / serial: 192.168.3.44:44881 / adbPath: <repo>/.home/android-sdk/platform-tools/adb / autoReconnect: true`（profile 原文件已备份）。**仓库内 `cordis.patch.yml` 保持模板默认（`mock/auto/adb`）不入网段/IP 等本机信息**；真机配置只存在于运行时 profile（不入 git）。
- **验证方式（实跑真机）**：
  - 设备：**Lenovo TB321FU**，Android **16**，1600×2560 @ 400dpi，adb 37.0.1；
  - `uiautomator dump` 非空且含文本/resource-id 节点；`screencap` 得有效 PNG（`8950 4e47` 魔数，1600×2560）；
  - 插件真实代码路径 `createAdbDriver().ensureConnected() → probe()` 返回 `canDump=true, canScreenshot=true, recommend=tree`；
  - 重启 `dsh web` 后工具 `price_agent({action:'probe'})` 返回真机报告（TB321FU / Android 16 / 1600x2560 @ 400dpi），确认已脱离 Mock 驱动。
- **未做/边界**：端口非固定——pad 重启或重开无线调试后 `44881` 会变，需同步更新 `device.serial`；插件对 `host:port` 已有 `ensureConnected` 自动 `adb connect` 重连一次（§8.3）；锁屏/休眠可能掉线。全程只读，未做任何点击/下单/支付。
- **更新后状态**：**P2 §8.4 真机 PASS**；`device.driver=adb` 已在 GUI 生效；下一步 P3 单平台抓价（需按真机 dump 校准页面契约）。

### [27] 2026-10-24 13:45 · P3 起步：美团真机抓价适配 + 修复无字验证码漏判
- **为什么**：进入 P3「单平台抓价」，需按真机校准美团"搜索→选店→结算→读实付"链路，并落实两层校验 + 证据绑定。
- **做了什么**：
  1. **新增 `src/platform/meituanReal.ts`**：拆分"纯提取"与"真机流程"。
     - `extractMeituanSettle(nodes, cond, dump)` 纯函数：按 `resource-id`（`fee_<kind>`/`discount_<kind>`/`payable`）优先、文案兜底（`配送费 ¥2.00`/`满30减5 -¥5.00`）抽取费用/优惠/实付；金额解析优先取 `¥` 前缀（修 "满30减5" 误取 30 的 bug）。
     - `runMeituanReal(nav, cond)`：首页→搜索→选店→加购→购物车→读实付；每步 `waitAny` 复用 `device/steps.waitForAnyState`（验证码即停+弹窗恢复+超时取证）；**全程只读，绝不点提交订单/支付**。
     - `createNavigator(driver)`：用 `Driver` 接口 + `steps` 原语成型，platform 层不 import 设备实现。
  2. **新增 `src/platform/selectors/meituan.ts`**（`MEITUAN_SELECTORS` 候选集合，短名后缀匹配）与 `src/platform/pageContracts.ts`（`MEITUAN_PAGE_CONTRACTS`）。
  3. **`src/platform/meituan.ts` 驱动解耦**：按驱动能力（有无 `probe`）自动选 mock 通路 / 真机通路，`task/runner` 不改。
  4. **`src/device/steps.ts` 增 `waitForAnyState`**（OR 语义），`waitForState` 转调它，行为不变。
  5. **红线修复（真机实测发现）**：`src/device/recover.ts` 的验证码识别原仅靠文案，美团滑块是**无字 WebView canvas**，会漏判成 `none`。已补结构判据 `looksLikeTextlessCaptcha`（大 WebView + 近零文本 + 无列表）→ 判 `captcha` 抛 `NeedsHumanError`，**仍绝不点击**。
- **验证方式（离线，`pnpm check` 全绿）**：新增 `test/platform-p3.test.ts`（12 tests）+ 脱敏样本 `test/fixtures/captcha.textless-webview.xml`；**94 tests 全过**（原 82 + 12），typecheck/lint/format/boundary 全绿。覆盖：id 路径/文案回退抽取、`¥28.9 vs ¥289`、`满30减5` 金额、选店导航链路（stub）、**无字 WebView 滑块→NeedsHumanError 且零点击**、升级/定位/加载干扰分类、读不到实付→needsConfirm、危险控件识别。
- **未做/边界**：**美团真机实测受阻**——真机首启触发**滑块验证**（红线禁止自动过），且平板已锁屏，需用户本人解锁并手动过一次验证后，再跑真机 `start` 用真实 dump 校准 `MEITUAN_SELECTORS`。`MEITUAN_SELECTORS` 当前为候选集合。
- **更新后状态**：P3 代码骨架 + 离线验收就绪；真机 §P3 实跑待用户解锁续做。

---

### [28] 2026-10-24 14:02 · P3 真机走查：修 dump 重页面兜底 + 中文输入通道 + 定位权限误判
- **为什么**：真机（TB321FU / 美团）走查"搜索→选店→结算"时暴露多个真机特有硬坑，必须先在代码里补掉，否则任何页面都读不到。
- **做了什么**：
  1. **`device/adb.ts` dump 三级兜底**：`exec-out …/dev/tty` → `shell dump` 落盘 → **`dump --compressed`**。实测美团搜索结果页标准 dump 被系统 `Killed`、落盘 0 字节，`--compressed` 稳定产出（25KB，32 个文本节点）。新增回归测试（fake runner 模拟标准空、compressed 有效）。
  2. **`device/recover.ts` 定位误判修复**：真机页面内"开启定位服务"引导条被旧逻辑当 `permission` 遮挡反复恢复。改为**只认系统权限对话框**（含是否允许/拒绝/始终允许），或极简界面（≤3 文本）才按 permission；普通页面含"定位"不再误判。
  3. **`platform/selectors/meituan.ts` 真机校准**：首页 `search_layout_area`/`search_button`；搜索页 `search_edit_text`/`search_button`。
  4. **中文输入通道（环境辅助，非风控绕过）**：实测 `adb shell input text 中文` 在搜狗输入法下 NPE 且不落框；改用 **ADBKeyboard** 的 `ADB_INPUT_TEXT` 广播注入 Unicode（`.price-agent/tools/ADBKeyboard.apk`，仅本地）。已成功把"香叶烤鸭饭"写入搜索框并触达搜索结果页。
- **验证方式（真机 + 离线）**：
  - 真机：搜索"香叶烤鸭饭"→ 结果页首条"香叶·烧鸭下饭菜（天骄店）"（带外卖标）→ 点入店铺页正常打开；标准 dump 在该页 `Killed`、`--compressed` 可用——与代码兜底一致。
  - 离线：`pnpm check` **95/95 全绿**（+1 dump 兜底回归）。
- **未做/边界（真机阻碍，待用户配合）**：店铺页菜单区依赖**收货地址**，无地址时空转"袋鼠加载中"、`uiautomator` 报 `could not get idle state`；地址属用户个人信息，需用户本人设置。搜索结果/店铺大量控件为混淆短 id，需菜单可加载后逐一登记。**全程只读，未做任何下单/支付。**
- **更新后状态**：P3 真机前段（首页→搜索→结果→店铺页打开）已走通并修复 3 个真机硬坑；菜单→加购→结算待用户设好收货地址后续做。

---

### [29] 2026-10-24 14:08 · P3 中文输入闭环：adb.input 自动切换 Unicode IME
- **为什么**：中文搜索词无法用 `adb shell input text` 注入（搜狗输入法下 NPE/不落框）；不能把用户平板输入法永久改成 ADBKeyboard。
- **做了什么**：
  1. `device/adb.ts` 增配置 `unicodeIme`：`input()` 在提供该 IME 时**临时 `ime set` → `am broadcast ADB_INPUT_TEXT --es msg` 注入 → `finally` 切回原 IME**；未提供则仍走 `input text`。`finally` 保证异常也恢复原输入法。
  2. `config.ts` 增 `device.unicodeIme`（默认空=不用）；`core/container.ts` 透传。
  3. 新增回归测试：断言调用序列含 `ime enable/set`、`ADB_INPUT_TEXT`、末尾 **切回原 IME**，且**不出现** `input text`。
  4. 真机侧已把平板输入法切回原搜狗并确认恢复。
- **验证方式**：`pnpm check` **96/96 全绿**；真机此前用同款广播已成功把"香叶烤鸭饭"写入搜索框。
- **更新后状态**：中文输入可在驱动层闭环，用户平板的输入法不被长期改动（需手动安装 ADBKeyboard 并在配置填 `unicodeIme` 才启用）。

---

### [30] 2026-10-24 14:22 · P3 真机关键修复：关闭动画 + dump 重试（idle 失败）
- **为什么**：真机实测发现美团多个页面 `uiautomator dump` 反复报 `ERROR: could not get idle state`，导致**整条链路读不到任何控件**（此前误判为"骨架屏/无地址"，实为动画导致 idle 检测失败）。
- **做了什么**：
  1. `device/adb.ts` 连接成功后**关闭三项系统动画**（`window/transition/animator_duration_scale=0`，可配置 `disableAnimations`，默认 true）。实测关闭后 dump 立即稳定（75KB/118 节点）。
  2. `dump()` 改为**最多重试 4 次**（每次间隔 500ms），绕过高频刷新的店铺页间歇性 idle 失败（实测第 3 次成功）。
  3. `config.ts` 增 `device.disableAnimations`；`container.ts` 透传。
  4. 回归测试：模拟前两次 dump `could not get idle` → 第三次成功；断言连接后写入三项动画 scale=0，且重试确实发生。
- **验证方式**：真机"江西小炒(盛夏路店)"店铺页菜单成功加载并可读；`pnpm check` **97/97 全绿**。
- **边界**：关闭动画属**测试自动化通用做法**（不改设备数据、不绕过风控）；若用户不希望改动画可设 `disableAnimations:false`。
- **更新后状态**：真机"外卖频道→店铺菜单"可稳定读取；继续加购→结算→读实付。

### [31] 2026-10-24 14:55 · P3 真机「结算页→读实付」走通并验收（坐标/行抽取）+ 红线补"极速支付"
- **为什么**：真机（TB321FU / 美团）首次进入**真实结算页**（OrderConfirmActivity）后发现：该页**几乎全无 resource-id**（payable/fee_*/discount_* 全缺失），旧的 id/文案抽取拿不到实付（`payable=null`、门店错读为商品名），P3 一直卡在"读不到价"。本次用真机 dump 校准，让抽取基于**视觉布局**工作。
- **做了什么**：
  1. **重写 `platform/meituanReal.ts::extractMeituanSettle` 为"坐标/行"抽取**（id 优先、布局兜底）：`buildRows` 按 y 聚行、`amountNearLabel` 取"标签→同行右侧最近金额"；门店取商品行上方最近左对齐文本、商品取与查询词相似度最高（`price/similarity.itemScore`）、规格/数量取同区块邻近文本。
  2. **优惠只认"明确已减"**（带 `-¥`/已减/共减）；把"待使用/去使用"红包识别为 **`optionalSavings`（availability=presumed）**，**不进 discounts、不抵扣实付**（修一条"把 ¥15 待使用红包当已减→实付被算成 15.98"的误算）。
  3. **`platform/types.ts` 增 `optionalSavings`**；`task/runner.draftFromFacts` 透传到 `QuoteDraft`（engine 已支持 presumed 不抵扣）。
  4. **文案锚点 + 短路**：`selectors/meituan.ts` 增 `settleTextAnchors`（外卖配送/到店自取/商品原价/用户配送费/券前/实付/共减…）；`Navigator.waitAny` 同时支持 resourceId 与文案；`runMeituanReal` 进入先探测"是否已在结算页"（1.5s），命中则**直接读数、零点击**。`pageContracts.ts` 结算页契约并入文案锚点。
  5. **红线加固（真机发现）**：美团真实付款按钮是 **"极速支付"**，原 `FORBIDDEN_TEXTS` 未含 → `core/safety.ts` 补 `极速支付/立即付款/去付款/确认付款/支付订单`，并补回归；`isDangerNode` 同步识别"极速支付"。
  6. **脱敏 fixture**：`test/fixtures/meituan-settle.real-device.xml`（真机结算页，地址/姓名/手机号已脱敏）。
- **验证方式**：
  - **真机实跑（只读，未点任何支付/提交）**：`createAdbDriver → meituan.enterSettlePage → extractMeituanSettle → priceQuote → compare` 结果为 `payable=30.98, effective=30.98, balanced=true, confidence=high, needsConfirm=false, cheapest=meituan 30.98, 1 个可比组`；抽取明细：商品原价 29.98 + 打包 2 + 用户配送 3.9 − 配送费减免 3.9 − 商家代金券/满减 1 = 30.98。
  - **离线**：`pnpm check` **101/101 全绿**（typecheck/lint/format/boundary 44 files/test）；`test/platform-p3.test.ts` 16 tests（真机坐标抽取 balanced、待使用红包回归、短路零点击、极速支付危险控件）；`test/safety.test.ts` 覆盖极速支付。`test:coverage` src/price 行 **95.89%**。
- **边界/未做**：冷启动全流程"首页→搜索→加购"逐页控件需继续按真机 dump 校准（混淆短 id + 中文输入）；已稳定可验收的是**结算页读数**（含短路零点击）。真实设备 dump 仅存 `.price-agent/`，入 git 的只有脱敏 fixture。
- **更新后状态**：**P3 真机"结算页→读实付"PASS**；下一步 P3 冷启动全流程校准 + P4。

### [32] 2026-10-24 15:00 · P3 冷启动全流程受阻：真机触发满页验证码（红线即停）+ 补真实代码路径拦截回归
- **为什么**：目标要求真机跑通"搜索→选店→加购→结算→读实付"全流程。尝试从首页发起冷启动时，美团**首屏弹出"请按语序依次点击下图文字"的字序验证码**（IP/账号风控）。按 AGENTS.md §0 红线 2，**验证码必须立即停止、不得尝试识别/点击**，故本轮全流程实跑在验证码处**主动中止**，交人工处理。
- **做了什么**：
  1. 确认拦截正确：该验证码是**无字 WebView**（`layout_webview` + 仅有刷新图按钮），`classifyObstruction` 判为 `captcha`（`matched: textless-webview`）。
  2. **补强回归（真实代码路径）**：新增 `test/platform-p3.test.ts` 用例——用假 Driver（只回验证码 dump）+ **真实 `createNavigator` + `runMeituanReal`**，断言抛 `NeedsHumanError` 且**零点击**（此前只测了 stub nav 的单步，未覆盖整条 `waitForAnyState`/`classifyObstruction` 真路径）。
- **验证方式**：`pnpm check` **102/102 全绿**；新用例 `runMeituanReal (real code path): home captcha → NeedsHumanError, zero taps` 通过（taps===0）。
- **未做/边界**：冷启动"首页→搜索→加购→结算"全流程实跑**被验证码阻断**，需用户本人手动通过验证后，才能继续校准首页/搜索/店铺页控件；"结算页→读实付"已在前一条 PASS。全程只读，未破解/未点击任何验证或支付控件。
- **更新后状态**：P3「结算页读数」稳定；「冷启动全流程」待用户在真机手动过一次验证码后继续。

### [33] 2026-10-24 15:37 · P3 冷启动全流程真机自动走通（首页→搜索→选店→加购→去结算→读实付）✅
- **为什么**：承接 [32]——验证码清除后，把"冷启动全流程"用**插件真实代码路径**在真机上跑通并校准，这是 objective 的硬指标（不只是手动走到结算页读数）。
- **真机实跑（关键证据）**：`createAdbDriver → meituan.enterSettlePage(driver, cond)` 从**首页**出发，**全自动**完成 首页→搜索"腐竹炒肉木桶饭"→选首店→选规格/加购→去结算→读实付，返回 `payable=19.9, balanced=true, confidence=high, needsConfirm=false, store=江西小炒(盛夏路店), item=腐竹炒肉木桶饭`（截图 `FINAL_coldstart_pass.png`：结算页右下"极速支付"、左下"¥19.9 共减¥10.98"）。全程只读，**未点任何提交/支付**。
- **本次修的真机 bug（都是实跑暴露的）**：
  1. **resource-id 短名后缀不匹配**：`state.hasResourceId` / `uixml.findBySelector` 原为**精确匹配**，而真机 id 是 `com.sankuai.meituan:id/search_layout_area`，选择器写短名 → 首页等待/点击全部失败。改为**后缀匹配**（`(?:[^"]*/)?name`）。
  2. **首页搜索入口 ≠ 搜索页输入框**：首页是 `search_layout_area`（无 EditText），点它才进 SearchActivity 出现 `search_edit_text`。`runMeituanReal` 拆成 `searchEntry`→等搜索页→`searchInput`→提交。
  3. **店铺页大图 banner 导致 dump 卡/陈旧**：`uiautomator` 无法 idle → 先下滚 1–2 屏越过 banner，再等店铺锚点；滚动后**改用文案点击**（坐标会失效）。
  4. **结算页误判**：`共减` 在**店铺页购物车条**也出现（"到手约 ¥15.98 共减¥16"）→ 原 `settleTextAnchors` 含 `共减` 会把店铺页误判为结算页。移除 `共减`，改用强锚（券前/商品原价/外卖配送…）。
  5. **实付取数变体 B**：神抢手/一口价店底部是「¥19.9 共减¥10.98」**无"券前"标签** → `payableFromRows` 增加"取『共减』左侧最近金额"兜底；并用"去结算→等结算页"重试 3 次解决偶发点不中。
  6. **新增安全 `tapPoint`**：结果卡无 id/文案钩子，只能按坐标点；实现为**先解析该点命中节点、把其 text/desc/id 过 `assertTapSafe`（命中支付即拒）再点**（红线仍守住）。
- **验证方式**：真机全自动跑通（上）；`pnpm check` **104/104 全绿**；`test/platform-p3.test.ts` 19 tests（含**真实 fixture 全流程回放** home→search→result→store→spec→cart→settle、`tapPoint` 命中"极速支付"被 `ForbiddenActionError` 拦且无 `input tap`、神抢手变体 balanced、验证码真实路径零点击）；新增脱敏真机 fixture 8 个（home/search/results/store/store-added/specsheet/settle/settle-shenqiand）。
- **红线**：全程只读；`tapPoint` 命中"极速支付"即 `ForbiddenActionError`；验证码 `NeedsHumanError` 零点击。真实 dump 仅存 `.price-agent/`，入 git 只有**脱敏** fixture（手机号/地址/姓名已替换）。
- **更新后状态**：**P3「搜索→选店→加购→结算→读实付」真机全流程 PASS**；objective 达成。

### [34] 2026-10-24 15:44 · 真机调试省上下文：文本优先 + 证据检查脚本 + 清理调试截图
- **为什么**：用户反馈"跑一个任务导致上下文不足"。根因是**调试期把整屏截图逐张 `read_image` 读入上下文**（1600×2560 的 PNG 每张 1–3MB，几张就占满），而插件本身**不**把图片塞进模型（`price_agent` 只返回文本比价表、截图仅落 `.price-agent/` 文件）。
- **做了什么**：
  1. 新增 `scripts/evidence-inspect.mjs`：把 uiautomator dump(XML) 解析成**紧凑文本+坐标**（`--settle` 只列金额行、`--clickable` 只列可点、`--filter kw…` 过滤），替代"读整屏图"来判页面/控件/金额。
  2. `AGENTS.md` §2 增"**真机调试 · 省上下文（强制）**"规则：默认只用文本 dump；看图前先跑该脚本；只裁关键区或只读 1 张最终证据图；截图用完即清。
  3. `README.md` 工具链表补该脚本说明。
  4. 清理 `.price-agent/evidence/` 里 35MB 调试截图（仅保留 `FINAL_coldstart_pass.png`），占用降到 1.6MB。
- **验证方式**：`node scripts/evidence-inspect.mjs test/fixtures/meituan-settle-shenqiand.real-device.xml --settle` 正确列出 `¥19.9 共减¥10.98 / 商品原价 / 用户配送费 / 商家代金券` 等；`pnpm check` 全绿（脚本随 lint/format 校验，`*.mjs` 走 Node 全局配置）。
- **边界**：脚本零依赖、纯只读本地 XML；不改变插件工具契约（`price_agent` 仍只返回文本）。
- **更新后状态**：真机调试默认走文本路径，显著降低上下文占用；后续任务不再因逐张读图而上下文不足。

---

### [35] 2026-10-24 16:10 · P4 多平台 + 策略四态 + 谨慎互斥 + 统一输入快照（等价分组）
- **为什么**：P3 只跑通美团单平台；P4 要求"饿了么接入 + 优惠四态 + 谨慎互斥 + 统一快照 + 分组比价"，且四条 DoD（同 snapshotId 派生、偏离归不可比组、effectivePrice 双口径无重复扣、跨平台默认不互斥）必须可离线判定。
- **做了什么**：
  1. **配置**（`src/config.ts` + `cordis.patch.yml`）：`platforms.<id>.strategies[]`（id/kind/name/condition{minSpend,weekday}/discount{type,amount,cap}/autoApplied/quota{dailyLimit,monthlyLimit,totalQuota,lastUsedAt}/exclusiveGroup/crossPlatformExclusive）；内置美团神券+招行周三、饿了么招行周三示例。实测 schemastery **无 `.optional()/.nullable()`**，改用裸 schema + `z.union([z.number(), z.const(null)]).default(null)`。
  2. **纯核心策略引擎**（新增 `src/price/strategies.ts`）：`evaluateStrategy/-Strategies` 把配置策略映射为 `OptionalSaving` 四态——配置/本地记账**最多 `presumed`**（绝不断言可用）；星期/门槛/日限只用于**降级** `known_unavailable`；`autoApplied` → `alreadyIncludedInPayable=true`。`applyCrossPlatformExclusivity` 做**谨慎互斥**：默认不互斥，仅 `crossPlatformExclusive=true` 且他平台 `verified` 已用时降级。
  3. **统一输入快照**：`Quote/QuoteDraft` 增 `snapshotId/snapshotHash`（`src/price/model.ts`）；`priceQuote` 透传；`compare` 校验每 Quote `snapshotHash === query.hash`，不一致追加 `deviatedConditions`（`snapshot 不一致…`）→ 不可比组（`src/price/engine.ts`）；`QuoteSchema` 同步字段（`src/price/schema.ts`）；`runner.draftFromFacts` 写入快照 + `detectDeviations`（qty/规格偏离）→ 归不可比组。
  4. **多平台·饿了么**：新增 `src/platform/elemeReal.ts`（`extractElemeSettle/FromDump`、`runElemeReal`、`elemeAnchors`，与美团同构，id/坐标行双路径）+ `selectors/eleme.ts`；`src/platform/eleme.ts` 按驱动能力选 mock/real。
  5. **共享原语去重**：把"坐标/行抽取 + 结果卡/可点文案"抽到 `src/platform/settleRows.ts`、把 `Navigator` 抽到 `src/platform/navigator.ts`（均无平台知识）；`meituanReal.ts` re-export 旧 API 保持兼容。**顺序无关精度修复**：`amountNearLabel` 改为"金额中心在标签中心右侧"判据（比端点比较更稳）。
  6. **runner 集成**（`src/task/runner.ts`）：每平台抽取后按 `strategySpecsFor` 读策略、`evaluateStrategies`（基数=费用原价）产出四态 savings 并与结算页 `optionalSavings` 去重合并；全部平台后 `applyCrossPlatformExclusivity`；再 `priceQuote + compare`。
- **验证方式（离线，`pnpm check` 全绿）**：新增 `test/platform-p4.test.ts`（16 tests）+ 脱敏 fixture `eleme-settle.real-device.xml`；**120 tests 全过**（原 104 + 16）；typecheck/lint/format/boundary 全绿；`test:coverage` `src/price` 行 **97.14%**（strategies.ts 100%）。覆盖：饿了么 id/坐标行抽取 balanced、策略四态（星期/门槛/日限/autoApplied）、跨平台默认不互斥 / 显式互斥降级、快照一致派生与偏离归不可比组、effectivePrice 双口径无重复扣、Mock 双平台全链路。
- **真机边界（红线）**：饿了么 App 真机未登录即触发**实名/短信验证**（`WebViewActivity` 身份验证 + `UserLoginActivity` 短信码），按 AGENTS.md §0 红线 2 **立即停止、未识别/未点击**，已将设备退回桌面；饿了么真机全流程需用户本人先登录（人工介入）。本阶段多平台以离线 fixture + 真实代码路径验收。
- **未影响已有行为**：美团 P3 全流程 19 tests 仍全绿；`meituanReal` 公开 API 经 re-export 保持稳定。
- **更新后状态**：**P4 完成**（多平台 + 策略 + 等价分组），四条 DoD 均落地并可离线判定；下一步 P5 打磨。

### [36] 2026-10-24 16:46 · P4 真机复测（饿了么已登录）：发现 canvas 自绘 → 落地截图 ROI OCR 兜底
- **为什么**：用户登录饿了么后要求重测真机。实测发现饿了么 **12.9.78（TB321FU 平板）整 App 是 canvas/TMS 自绘**——`uiautomator dump` 全页（首页/搜索/结果/店铺/**结算页**）只有 1 个 `water_mark_view` 节点，**控件树零文本/金额**，此前"控件树锚点导航"路径对饿了么根本不可行（P4 首版仅离线 fixture 验收）。
- **做了什么**：
  1. **真实 OCR 适配器**（新增 `src/ocr/tesseract.ts`）：`createTesseractOcr({lang,cachePath})` 包 tesseract.js WASM，逐词返回 `bbox`+置信(0–1)，支持 `roi` 只识别屏幕某矩形；`close()` 释放。`core/container.ts` 在 `ocr.enabled && device.driver=adb` 时构造，否则仍 Mock。
  2. **饿了么 OCR 抽取**（`src/platform/elemeReal.ts`）：`extractElemeSettleFromOcr(rawWords,cond)` + `ocrMoney`（归一 `Y3.9/y35.9/¥1` 等）+ `clusterOcrRows`（按 y 聚行，解决中文标签被拆 token：`优惠`+`后`）+ `settlePanelRoi`（取 `tms_fragment_container` 右栏 ROI，避开左侧首页）。映射 打包费/配送费/优惠后商品价/免配送费减免/实付；**"已优惠 ¥X"整单汇总绝不当独立 discount 叠加**（防 §5.3 重复扣）。
  3. **平台契约**（`src/platform/types.ts`）：`enterSettlePage(driver,cond,ctx?)` 增可选 `PlatformEnterContext{ocr,dataDir}`（注入式，platform 只依赖 `ocr/reader.ts` 接口）；`runner` 透传 `deps.ocr`。`navigator` 增可选 `screencap()`。
  4. **runElemeReal 重写为 OCR 感知**：`tryReadSettle` 控件树优先，读不到实付且有 OCR 端口 → 截图 ROI OCR；导航在 canvas 下用 resourceId 锚点 + `tapPoint` 坐标。
  5. **脱敏 fixture** `test/fixtures/eleme-settle.ocr.json`（真实结算页右栏 OCR 逐词，地址/手机号/姓名已剔除）。
- **验证方式**：
  - **真机实跑（只读，未点提交/支付）**：`eleme.enterSettlePage(driver,cond,{ocr})` → `payable=20.8`（截图"立即支付 ¥20.8"）；`confidence=low, balanced=false, delta=-1, needsConfirm=true`——因 OCR 偶发丢"打包费 ¥1"数字，**如实降级不硬凑**（§6.3.4）。
  - **离线**：`pnpm check` **126/126 全绿**；`test/platform-p4.test.ts` 20 tests（+OCR 抽取 4：合成行/真实脱敏 fixture/ocrMoney/clusterRows/settlePanelRoi）；`src/price` 行覆盖 97.15%。
- **红线**：全程只读；饥饿了么未登录时曾触发实名/短信验证 → 立即停止零点击（本次由用户自行登录）；OCR 不含下单/支付路径。
- **边界**：饿了么 canvas 无文案钩子，**全自动导航**（搜索→选店→加购→去结算）不如美团稳定，需持续按真机截图回填坐标/锚点；当前**稳定可验收的是"结算页 OCR 读数"**（payable 正确）。
- **更新后状态**：P4 真机复测完成，饿了么拿到可用 OCR 读数路径；多平台在"结算页读数"层面对两平台均可用（美团=控件树，饿了么=OCR）。

### [37] 2026-10-24 18:15 · P5 打磨（一）：截图默认脱敏 + 证据 TTL/保留清理 + 瞬时重试 + 证据真实绑定

- **为什么**：P5 的三条 DoD 一直没真正落到代码上——①「截图默认脱敏且可清理」此前只有 `redaction:'applied'` 的**字面标记**，运行时根本不落截图（`screenshotPath: undefined`）、也没有任何脱敏实现；②`evidence.retainMax` 只有配置项，`./.price-agent/evidence/` 从不清（实测已堆到 46MB）；③抓价无任何重试，adb 偶发掉线/`uiautomator dump` 拿不到 idle 就让整次比价失败。
- **做了什么**：
  1. **零依赖截图脱敏**（新增 `src/device/redact.ts`）：只用 `node:zlib` 手写 PNG 解码/编码（8-bit、非隔行，支持灰度/RGB/RGBA + 5 种 filter），从 dump XML 里识别**手机号/门牌地址/收件人/支付信息**节点并取其 bounds，把截图中对应矩形**填黑**。**隐私优先**：无法解码或未定位到敏感区域 → `applied=false`，调用方**不保存原图**。真机实测 1600×2560 截图 ~130–190ms/张。
     - 真机校准：初版把「11人觉得味道赞」误判成地址（因含“道”），已收窄路名规则（`大道|街道|路|街|巷|弄`+数字，去掉单字“道/号”泛匹配），并加回归用例。
  2. **证据真实绑定**（`src/task/runner.ts` `bindEvidence`）：每平台抽取后把 **dump 原样原子写** `evidence/<quoteId>.xml`（600 权限）、**截图脱敏后**写 `evidence/<quoteId>.png`；OCR 平台（饿了么 canvas）把 OCR 文本写 `rawExtraction.ocrText`；`redaction` 如实标 `applied/none`，失败/未脱敏写 `missingReason`（交 `price` 层降级，绝不假装有证据）。`draftFromFacts` 增 `bound` 参数承接（旧调用不传则保持“无路径”原行为，测试零改动）。
  3. **平台补截图**：`runMeituanReal` 各结算页返回点 `withShot()`（截图尽力而为，失败不影响读价）；`runElemeReal` 的 OCR 分支保留结算页截图；`RawQuoteFacts.screenshot` 字段终于被填。
  4. **TTL + 保留上限清理**（新增 `src/task/cleanup.ts`，`cleanupSweep` 接入 `lifecycle`）：`evidence/` 与 `results/` 按「`retainDays` 天**或** `retainMax` 组，**取先到者**」清理；在**任务完成**与**插件启动**两个时点触发（`src/index.ts`），尽力而为不阻塞。`getResult` 时若报价声明的截图已被清理，`note` 如实提示“截图证据已清理，需重新核价”（`evidenceDowngradeNote`）。
  5. **瞬时异常重试**（新增 `src/core/retry.ts`）：`isRetryable` 只认 **adb 掉线/dump idle 失败/截屏失败/超时** 这类瞬时故障；`NeedsHumanError`（验证码/登录/风控）与 `ForbiddenActionError`（下单/支付）**永远不重试**（红线优先，即便文案带 timeout 也不重试）。`runCompare` 用 `withRetry` 包裹平台抽取（`task.retryAttempts`，默认 2），重试写进度行，尊重 `signal` 取消。
  6. **配置**（`src/config.ts` + `cordis.patch.yml`）：`task.retryAttempts=2`、`evidence.retainDays=7`、`evidence.redact=true`（默认开）。
- **验证方式**：
  - **真机截图脱敏实证**（只读，未点提交/支付）：对既有真机截图 `mt-s6.png`+`mt-s6.xml` 跑 `redactScreenshot` → `applied=true, masked=2`，放大对照图确认「益丰新村-9号楼」被**整块涂黑**；`1600×2560` 输出仍是合法 PNG。
  - **离线**：`pnpm check` **149/149 全绿**；新增 `test/redact.test.ts`（9）、`test/retry.test.ts`（7）、`test/p5.test.ts`（6）；`test:coverage` `src/price` 行覆盖 **97.15%**（策略/证据 100%）。
  - 覆盖：PNG 编解码 round-trip、掩码、无法脱敏不落图、清理（按天/按量/目录不存在）、重试（瞬时重试成功/验证码不重试/超限抛错/取消即停）、证据绑定（dump+脱敏图/未脱敏不存/OCR 文本）。
- **红线/隐私**：全程只读；脱敏失败**绝不保存原图**；截图仅落 `.price-agent/`（gitignore），入 git 只有脱敏 fixture；真机对照图验证完即删。
- **边界**：脱敏是「按 dump 文本定位矩形填黑」，非像素级人脸/水印识别；dump 读不到的 canvas 区域（如饿了么自绘）若含 PII 无法据此定位——此时会因“无敏感区域”而不落图（隐私安全默认方向）。
- **更新后状态**：**P5「隐私脱敏 / 证据清理 / 异常重试 / 验证码暂停」四项均有可判定落点**，`pnpm check` 全绿。

---

### [38] 2026-10-24 18:45 · P5 打磨（二）：失败取证也脱敏 + OCR 逐词框入证据 + 证据缺失兜底

- **为什么**：上一轮只给「成功报价」的证据（`bindEvidence`）加了脱敏，但**失败取证路径**（`device/capture.captureEvidence`，断言超时/验证码时由 `steps.safeCapture` 调用）仍把**原图**直接落盘——这是隐私红线的真实缺口（失败现场恰恰最可能停留在含手机号/地址的页面）。另 `Evidence.rawExtraction.ocrBoxes` 字段一直存在却从未写入，OCR 结果无法按坐标复核。
- **做了什么**：
  1. **`capture.ts` 默认脱敏**：新增 `CaptureOptions{redact}`（默认 `true`）；截图先经 `redactScreenshot(png, dumpXml)`，成功才落盘并返回 `redaction:'applied'`，无法脱敏 → **不存原图**、`warning` 记原因。返回类型补 `redaction` 字段。`steps.StepOptions` 增 `evidenceRedact`（仅离线测试置 `false`）。
  2. **OCR 逐词框入证据**：`RawQuoteFacts` 增 `ocrWords?`；`elemeReal` OCR 分支写入；`runner.draftFromFacts` 映射到 `evidence.rawExtraction.ocrBoxes`（`text/confidence/bbox`）。
  3. **证据缺失兜底**：`bindEvidence` 末尾若完全无 dump/无脱敏图/无 OCR 文本，兜底写 `missingReason='证据缺失：无 dump / OCR 文本 / 截图，需人工复核'`（`price` 层据此降 `low` + `needsConfirm`）。
- **验证方式**：`pnpm check` **152/152 全绿**；`test/p5.test.ts` 新增 3 例（OCR `ocrBoxes` 落证据、完全无证据 `missingReason` 兜底、`captureEvidence` 默认脱敏且不可脱敏不存图）；`test/device-p2.test.ts` 断言超时用例显式 `evidenceRedact:false`（测试用最小灰图无 PII）。`src/price` 行覆盖 97.15%。
- **红线/隐私**：两条取证路径（成功/失败）现在都默认脱敏；测试从未把真机原图入库。
- **边界**：真机本轮掉线（无线调试端口变更、mDNS 重连后再次离线），**未能在真机现场复跑** `captureEvidence`；脱敏算法本身已在上一轮用真机截图（`mt-s6`，`masked=2` 对照确认涂黑）验证，本轮改动只是把它接到失败取证路径 + 单测覆盖。
- **更新后状态**：P5「截图默认脱敏」覆盖完整（成功证据 + 失败取证），OCR 证据可复核，证据缺失如实降级。

---

### [39] 2026-10-24 18:55 · P5 打磨（三）：无线调试 mDNS 自动发现/回连（修「旧 host:port 失效」真机掉线）

- **为什么**：真机复跑时反复出现「未检测到在线设备」——配置里写的是旧的 `192.168.3.44:44881`，手机重启后端口已变为 `:37289`；而 mDNS 通道（`adb-XXXX._adb-tls-connect._tcp`）其实一直在线。原 `ensureConnected` 只会对**配置值**做一次 `adb connect`，配置过期即彻底连不上，需人工重配。
- **做了什么**（`src/device/adb.ts`）：
  1. **学习 mDNS 串号**：`listDevices` 后若发现 `._adb-tls-connect._tcp` 的在线设备，记住作为重连候选（不改配置）。
  2. **主动发现当前端口**：新增 `discoverMdnsAddress()`，解析 `adb mdns services` 得 `host:port`；旧 `host:port` 连接失败时依次尝试 ①配置值 ②mDNS 串号 ③**主动发现的当前端口**，任一成功即采用并继续。
  3. 重连成功后再关闭动画（与正常连接一致）。
- **验证方式**：
  - **真机实证**：旧 `192.168.3.44:44881` 下 `ensureConnected()` → **自动切到 `adb-HA26JA4H-..._adb-tls-connect._tcp`**，`probe` 读到 `TB321FU / Android 16 / canScreenshot=true`；随后 `captureEvidence` 落盘 dump + **脱敏截图**（1600×2560 合法 PNG）。
  - 离线：`test/device-p2.test.ts` 新增 2 例（mDNS 串号回退、`adb mdns services` 当前端口发现），**该文件 28 tests 全绿**；`pnpm check` 全绿。
- **备注**：本机 adb 需先 `adb start-server` + `adb mdns check` 才会在 `adb devices` 中出现无线设备（daemon 冷启动时 mDNS 发现延迟）；这是环境侧动作，未写进驱动强制流程，仅在重连时兜底。
- **更新后状态**：无线调试掉线不再依赖人工重配端口；P5 的「异常重试/稳健性」闭环。

---

### [40] 2026-10-24 19:05 · fix(device): adb daemon 冷启动预热等待（`adb devices` 首查为空误判离线）

- **为什么**：真机复跑时第一次动作常报「未检测到在线 Android 设备」——`adb` daemon 刚启动时**首帧 `adb devices` 为空**，mDNS 自动发现需要 1–2 秒才把无线设备列出来；原实现"首次为空即抛"，导致任务刚起步就失败（随后 `adb devices` 又有设备）。
- **做了什么**（`src/device/adb.ts`）：`ensureConnected` 在首次发现设备为空时，先 `adb mdns check` 打开发现、再短轮询（3×500ms）；**只做一次**（`warmupDone`），且**注入 runner（离线测试）时跳过**，保持测试确定性与速度。
- **验证方式**：真机冷启动（先 `adb kill-server`）后 `probe`/`selfCheck` 正常：`TB321FU / Android 16 / dump OK / 截屏 1.3MB PNG`；`runCompare` 真机全流程能正常启动（本轮真机前台被饿了么登录页遮挡，故只验证到导航阶段，未做支付相关任何操作）。离线 `device-p2` 28 tests 全绿、耗时 ~2.1s（预热仅真机生效）。
- **红线**：只读；仅在设备连接层做等待，不点击任何订单/支付控件。
- **更新后状态**：adb 冷启动不再误判离线；真机任务启动更稳。

---

### [41] 2026-10-24 21:30 · fix(device): 真机全流程跑不通的 6 个根因（启动/回首页/陈旧 dump/窗口坐标/重试/锚点）

- **为什么**：真机（联想 TB321FU 平板）端到端 `runCompare` 反复失败，报错五花八门（`tab_home` 超时 / `search_edit_text` 缺失 / 一次都不重试）。逐层排查后发现**不是单一 bug，而是 6 个叠加的真实缺陷**。
- **做了什么**：
  1. **从不启动 App**：`runMeituanReal/runElemeReal` 默认"App 已在前台"。新增 `Driver.launchApp/foreground` + `navigator.ensureAppForeground`，两平台 `enterSettlePage` 前置调用（等价点桌面图标，不做登录/授权/支付）。
  2. **启动恢复到上次页面**：`monkey`/LAUNCHER intent 只把任务提到前台。`launchApp` 改为 `resolve-activity` + `am start -n <MainActivity>`，`force` 时追加 `-S`（force-stop 后启动，实测唯一能稳定回首页的方式）。
  3. **回首页把 App 退到桌面**：`ensureHome` 盲目连按返回键（搜索页→首页→桌面）。改为每次回退**先查前台包名**，跑出 App 就重新拉起；最终兜底 force-stop 重启。
  4. **dump 读到陈旧页面（最隐蔽）**：重页面标准 dump 报 `could not get idle state` 且**不覆盖旧文件**，直接 `cat` 会拿到上一页（实测：店铺页读到搜索结果页内容，导致后续锚点全错）。`dumpToFile` 改为「先 `rm` → 跑 dump → **校验输出含 `dumped to` 且无 `ERROR`** → 才 cat」，否则换 `--compressed`；`/dev/tty` 直出同样要求无 ERROR。
  5. **等待一次都不重试**：真机单次 `uiautomator dump` 2.4–3.4s，而 `waitForAnyState` 的 `timeoutMs=1500` 比单帧还短 → 首帧慢就零重试。改为**保证至少 2 次** dump 尝试。
  6. **首页锚点误判**：`homeAnchors` 含 `search_button`，而**搜索页也有同名 id** → 搜索页被误判成首页。已移除。
- **附带新增（窗口几何 / 坐标校正）**：`probe.parseWindowGeometry/parseFocusToken/sliceWindowBlock/toScreenPoint`（纯函数）；`adb.geometry()` 读**聚焦窗口**的 `winConfig.mBounds`；`tap/tapPoint/swipe` 走坐标映射；`toScreenPoint` 依据 dump 边界**自动判定**坐标系（避免偏移两次）；`navigator.assertUsableWindow` 对分屏/多窗口抛 `NeedsHumanError('environment')` 并提示人工（**不自动改窗口布局**，避免误点）。
- **验证方式**：`pnpm check` **161/161 全绿**；`test/device-p2.test.ts` 35 用例（新增：陈旧 dump 回归、mDNS 回连、daemon 预热、窗口几何解析、坐标映射自动判定、环境守卫）。
- **未完成（如实记录）**：真机端到端**仍未跑通**——平板处于**PC/桌面模式**，美团被系统以浮窗打开，`appX` 在 641/1281 间漂移，`dump` 与 `input tap` 坐标系不一致。守卫会正确拦下并提示人工；彻底解决需用户把平板切回**全屏+竖屏**（详见 `docs/HANDOFF-device-p5.md`）。
- **红线**：全程只读；未点任何提交/支付控件；未尝试破解验证码；未自动修改窗口布局。
- **更新后状态**：真机链路的 6 个代码级缺陷已修复并回归覆盖；剩余为**设备环境**问题，已写成交接文档明日继续。

---

---

### [42] 2026-10-25 10:40 · docs(device): 真机端到端复测 PASS —— 昨日 6 项修复全部生效（payable=¥29.88）

- **为什么**：昨日（`[41]`）修复 6 个真机链路缺陷后，卡在**设备环境**（平板 PC/桌面模式、浮窗外窗口坐标系漂移），端到端未跑通，留下 `docs/HANDOFF-device-p5.md` 待续。今日平板切回全屏竖屏后复测，需把结论固化并结项。
- **做了什么（验证，无代码改动）**：
  1. **环境自检（关键）**：`cur=1600x2560`、`mBounds=Rect(0,0-1600,2560)`、`mDisplayRotation=ROTATION_0`、`mWindowingMode=fullscreen`、`mAreBoundsLetterboxed=false`、`inPcmode=0` → 全屏竖屏、PC 模式已关，昨日 appX 在 641/1281 漂移的根因消失。
  2. **冷启动全流程实跑**：`DEVICE_ADDR=192.168.3.44:39079 ITEM='腐竹炒肉木桶饭' node .price-agent/diag/live-run.mjs` → 首页→搜索→选店〔江西小炒(盛夏路店)〕→选规格〔小炒肉木桶饭 1人份·微辣〕→加购→去结算→读实付，一步跑通，**无需人工干预**。
  3. **读数与平账**：`payable=¥29.88`、`effectivePrice=¥29.88`、`balanced=true`（expected=29.88 delta=0 tol=1）、`confidence=high`、`needsConfirm=false`；账目 `28.88(商品原价)+3.9(配送)+2(打包)=34.78` − `3.9(活动减配送费) − 1(商家满减) = 29.88` 吻合。
  4. **风险项**：`美团红包 15元`（待使用）如实标 `presumed`、不计入优惠、不抵实付 → 未把实付算低 15 元（符合 §5.4/§6.3.4）。
  5. **证据**：脱敏截图（`redaction=applied`，收货地址/联系人/手机号整块涂黑）+ 结算页 dump（377 节点）；仅落 `.price-agent/`。
- **附带发现（环境侧，非代码）**：`adb shell input text` 处理中文会抛 `NullPointerException`，复跑脚本必须配 `unicodeIme=com.android.adbkeyboard/.AdbIME`（交接脚本原有，本次复跑脚本补齐）；无线调试端口随重启变化，本次为 `192.168.3.44:39079`（用户口述的 `192.168.3.74` 系笔误，`.74` 不可达）。运行时 profile 的 `serial` 当时**未真正落盘**（仍停留在旧端口 `:44881`），本轮改为 `auto`，由 mDNS 自动发现当前端口，避免每次手填失效端口。
- **验证方式**：真机实跑输出如上；`pnpm check` **161/161 全绿**（本次无代码改动，门禁基线不变）。
- **红线**：全程只读；未点任何提交/支付控件（结算页「极速支付」未触碰）；中途遇「身份核实」拼图滑块**立即停止、由用户本人完成**，未做任何识别/绕过；证据仅落 `.price-agent/` 且已脱敏。
- **更新后状态**：真机端到端闭环；P2–P5 全部验收项在真机上得到实证。

---

## 追加条目的模板（供后续每轮使用）

```markdown
### [N] YYYY-MM-DD HH:MM · <一句话标题>
- 为什么：
- 做了什么：
- 更新后状态：
```

> 约定：代码类改动需补充"改动文件清单 / 验证方式（命令与结果）/ 是否影响已有行为"；文档类改动补充对应 `PLAN.md` 章节与版本号。

---

*最后更新：2026-10-25 10:40 +08:00*
