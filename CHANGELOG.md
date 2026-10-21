# 项目变更记录 · CHANGELOG

> 项目：**dsh-plugin-price-agent**（手机外卖比价 DSH 插件）
> 说明：从项目建立开始，**每一次变动**都按「**时间 / 为什么（Why） / 做了什么（What） / 更新后状态（State）**」记录在此。
> 约定：后续每轮改动（文档、代码、配置）都在本文件**追加**一条，不要覆盖旧条目；`PLAN.md` 的版本号变化对应到这里的文档类条目。

---

## 项目当前状态（快照）

| 项 | 状态 |
|---|---|
| 阶段 | **基建完成（仓库 + 目录骨架），下一步 P0+P1** |
| 代码 | **骨架已建**：`src/{core,task,platform,device,price,ocr,tools}` + `test/`，入口/配置为最小可加载骨架（业务待 P0/P1 实现） |
| 文档 | `PLAN.md` = **v0.7.0**（约 1252 行）+ 本 `CHANGELOG.md` |
| Git | 仓库已初始化（`main`，初始提交 `f88433d`，远端 `origin`）；本次提交建立基线 |
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

## 追加条目的模板（供后续每轮使用）

```markdown
### [N] YYYY-MM-DD HH:MM · <一句话标题>
- 为什么：
- 做了什么：
- 更新后状态：
```

> 约定：代码类改动需补充"改动文件清单 / 验证方式（命令与结果）/ 是否影响已有行为"；文档类改动补充对应 `PLAN.md` 章节与版本号。

---

*最后更新：2026-10-22 00:08 +08:00*
