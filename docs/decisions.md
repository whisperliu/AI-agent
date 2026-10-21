# 决策记录（Decisions / ADR-lite）

> 本文件记录"**为什么这么定**"：风险与合规口径、已锁定决策、技术路线取舍、以及版本级变更摘要（全量时间线见 [`../CHANGELOG.md`](../CHANGELOG.md)）。
> **章节编号保持 §10–§13 不变**。技术设计见 [`module-spec.md`](./module-spec.md)，任务见 [`tasks.md`](./tasks.md)。

---

## 10. 风险与合规（统一口径，全文一致）

> **一句话合规基线**：本工具**只读你本人设备、你本人账号的公开结算信息，低频、手动触发、不自动下单、不支付、不突破任何验证/风控、不抓包伪造请求**。它降低但不消除"违反第三方 App 用户协议"的风险；是否使用由你判断并自行承担。

1. **平台条款（定性一致，不夸大也不淡化）**：自动化操作第三方 App **可能**违反其用户协议；本工具**不承诺"不违反条款"**（§3.1 已按此措辞统一）。缓解措施：仅个人本机、低频、只读、手动触发、**不自动下单/不支付**。风险可控但**不为零**，用户自担。
2. **App 界面频繁改版**：控件定位会失效 → 选择器集中配置化（§3.5.3）+ 能力探测/降级（§3.5.4），便于修。
3. **风控/验证码（红线）**：遇验证码/滑块/安全校验 → **立即暂停并提示你手动处理，绝不硬闯、绝不做绕过**。
4. **隐私**：手机截图含个人信息，插件只在本地处理、**默认脱敏**（隐去手机号/门牌/支付信息/骑手姓名）后才展示或落盘；信用卡信息**只存"卡种/权益"，不存卡号/CVV/有效期**。
5. **价格误读**：**识别质量评估优先、zod 算术护栏兜底**（§6.3/§6.3.4）；OCR 命中即降级、低置信度一律 `needsConfirm`，绝不把不可信价当最低价。
6. **iPhone 不纳入本期**（§3.2）。
7. **不自动付款 / 不代下单**：插件最多停在结算页读价并给你截图，任何提交/支付都需你本人操作（§3.4）。
8. **数据最小化与可删除**：证据按 TTL 清理（§6.5），配置中不含敏感凭证；你可随时删除 `.price-agent/` 下本地数据。

---

## 11. 评审结论（已按你的回复锁定）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 手机平台 | **Android 路线 A**（iPhone 人肉截图体验差，放弃） |
| 2 | 自动化深度 | **全自动 adb 无线调试**，从**控件树解析**起步（最有价值的部分） |
| 3 | 平台范围 | **首期 美团 + 饿了么**（覆盖约 90% 场景），京东外卖等架构稳定后扩展 |
| 4 | "到手价"口径 | **以结算页实付为准**；手动领券策略**只提示、不计入主价**（保证客观） |
| 5 | 信用卡/会员策略 | 首期以 **招商银行（周三固定活动）+ 美团神券** 作基准用例 |
| 6 | 先做哪档 | **先交付 P0（算法引擎）+ P1（插件骨架 + Mock）**；前后端解耦，先用 Mock 跑通 UI 与对话流 |
| 7 | WSL 约束 | **无线调试（方案 c）**：手机与 WSL 宿主同 WLAN，`adb connect` |

> 以上若与你的预期有出入，直接指出对应编号即可，我再调整。

---

## 12. 附：为什么不用"官方 API"做主力

美团/饿了么面向消费者的**点餐价格没有公开 API**；面向商家的开放平台（美团开放平台、饿了么商家开放平台）需要**商家资质、签约、审核**，且接口是"经营/订单"视角，拿不到"任意门店的实时到手价 + 你的红包折算"。因此：**官方 API 只能作为将来有资质时的补充，主力必须是"本机 App 自动化"**。这也是本方案把重心放在 `device_driver` 与状态机断言上的原因。

---

## 13. 变更记录

> 完整的时间线（为什么 / 做了什么 / 更新后状态）见 [`../CHANGELOG.md`](../CHANGELOG.md)；本节只保留版本级摘要。

- **v0.7.0（本轮，仅文档 · 四项工程基线 Normative）**：
  1. **§4 拆为四小节**：把原来的"工程结构"升级为 **§4.1 运行环境 / §4.2 技术栈 / §4.3 目录结构 / §4.4 模块边界**。
  2. **§4.1 运行环境**：宿主 WSL2/Ubuntu 26.04、**Node v24.22 直接跑 `.ts`**（实测 `node t.ts`、`node --test t.test.ts`）、pnpm 12.14、DSH 0.2.1-rc.2、Android 11+、adb（未装）、OCR 走 **tesseract.js(WASM)**（实测系统无 tesseract）、零原生编译；含开工前环境自检命令。
  3. **§4.2 技术栈**：语言/配置/校验/工具/DI/持久化/锁/任务/子进程/定时/人工介入/XML/OCR/测试/日志逐项选型与用法约束；依赖收敛为 `zod`+`schemastery`（+`tesseract.js`/`fast-xml-parser` 可选），禁 jest/vitest 等。
  4. **§4.3 目录结构**：完整树（含 `tsconfig.json`、`.gitignore`、`platform/types.ts`、`price/model.ts` 为类型真源）+ `package.json` 关键字段（`exports`/`dsh.bundle.patch`/`engines.dsh`/`peerDependencies`/`dependencies`/`scripts`）。
  5. **§4.4 模块边界**：分层依赖图 + 每模块"职责/公开 API/允许依赖/禁止"表 + **6 条可 CI 校验的硬规则**（price 纯核心无 IO、task/platform 只 import 接口不 import 实现、tools 不直连 ctx.jobs/storageDomain、仅 index/cordis.patch 对外、共享类型唯一真源、循环依赖=0）。
  6. 同步：§8 开头声明"版本基线见 §4.1，本节只讲 WSL2 细节"；§9 P1 DoD 增"边界可校验（price 无 IO、task 不 import 实现、循环=0）"。
- **v0.6.0（仅文档 · 复用优先，消除重复造轮子）**：
  1. **新增 §2.2 复用优先清单（Reuse-First）**：逐项核查 DSH 内置能力，把 3 处原本自写的能力改为**注入复用**——
     - **持久化**：自写 `tasks/store.ts`+`state.json` JSON 读写 → **`ctx.storageDomain`**（`tasks`/`ledger`/`idempotency` 表，`dsh-storage-json` 落盘、schema 校验、写落盘后才 resolve）。
     - **原子写 + 文件锁**：§7.5 自写 `tmp→rename`、§7.7 自写设备锁/快照锁/文件锁 → **`dsh-atomic-write`**（`writeFileAtomic` + 跨进程 `withWriterLock`，wx 锁 + PID + `ESRCH` 接管）。
     - **后台任务**：自写调度/进度/通知/取消 → **`ctx.jobs` + `dsh-tool-jobs`**。
     - 另复用：`dsh-native-command`（adb 执行）、`cordis-plugin-timer`（超时）、`dsh-user-questions`（人工介入）、`dsh-output-retention`（截断）。
  2. **明确"保留自建"= 业务本体**（非轮子）：`device/*`（Android 自动化）、`price/*`（比价算法）、`platform/*`（选择器/策略）、`ocr/*`（质量门）、`tools/price-agent.ts`。
  3. **写入派生规则**：新增"存储/锁/原子写/定时/子进程/截断/提问"代码前先查清单；只允许薄封装（`adb.ts` 必须调 `runNativeCommand`；`store.ts` 只做领域↔storageDomain 映射）；**禁止引入** `proper-lockfile`/`write-file-atomic`/`lowdb`/`p-limit`。
  4. **同步修订**：§2.1 R2/R5、§5.6 记账、§7.5(1)(5)(6)、§7.7 R1/R3/R4、§8.5–8.6、§4 依赖说明，全部改为复用口径；§4 目录树注释标注"复用/薄封装"；§9 P0 增"纯核心无 IO"、P1 增"抽查无自写存储/锁/spawn"。
- **v0.5.0（仅文档 · 三条明文规范）**：
  1. **新增 §2.1 解耦规范（Normative）**：单向分层依赖（tools→task→{platform,device,price,ocr}）、DI 总线（Driver/Ocr/Clock/Fs/Jobs 注入，禁硬编码实现）、**Mock 契约**（`mock|adb` 切换不改业务代码）、纯核心边界（pricing 无 IO）、与 DSH 运行时/前端解耦、业务状态落 `.price-agent/`。
  2. **新增 §7.6 幂等规范（Normative）**：幂等键确定算法 `sha256(snapshot.hash ‖ 平台集 ‖ 选项)`（**键不含时间窗**，修掉旧口径）；必幂等/必不幂等操作清单；同键同结果语义（运行中/已完成/失败/`force`）；同键异参 `409 IDEMPOTENCY_KEY_REUSED`；保留期 `idempotencyTtl`（默认 30 分钟）；崩溃恢复边界。
  3. **新增 §7.7 并发控制规范（Normative）**：三层锁固定顺序（**设备锁 → 快照单飞锁 → 文件锁**，防死锁）、adb 单设备串行队列与排队提示、竞态清单与对策（含 `runToken` 丢弃迟到写入、`state.json` 文件锁、先写键再执行）、文件锁可接管（心跳 30s）、`503 BUSY`。
  4. **§7.5(2) 收敛**：删去与 §7.6/§7.7 重复的细节，改为引用；修正"键内不含时间窗"。
  5. **§4 目录树**新增 `core/{container,clock,locks}.ts`、`device/mock.ts`、`ocr/mock.ts`、`task/idempotency.ts` 与 `idempotency/concurrency/decoupling` 三个测试。
  6. **§9 P1 DoD** 增补：解耦（mock/adb 切换不改码、pricing 可单测）、幂等（并发 10 次=1 任务、异参 409）、并发（设备锁串行、`state.json` 不损坏、`BUSY`）。
- **v0.4.0（仅文档 · 九项一致性与可靠性加固）**：
  1. **重复计算修复（§5.3）**：区分 `payable`（结算页实付，纯事实）与 `effectivePrice`（综合到手价）；`Discount` 增 `alreadyIncludedInPayable`/`refundedBy`，`effectivePrice` 只扣"verified 且未含在实付内"的优惠；`superRefine` 校验 `effectivePrice` 不得重复扣（实测：重复扣/推测扣均被拒）。
  2. **额度规则可推导性（§5.5）**：明确额度字段只用于"排除已知不可用"，**禁止**据此断言"可用"；`totalQuota` 不可观测一律 `unknown`。
  3. **统一输入快照（§6.6）**：新增 `snapshotId/hash`，所有 Quote 从同一快照派生；`deviatedConditions` 非空即归入不可比组。
  4. **任务不重复执行/结果不丢（§7.5）**：幂等键 + 单飞锁 + 真机互斥 + `runToken` + 结果原子写(`tmp→rename`) + `checksum`；通知仅优化、非事实来源。
  5. **WSL2 最小实验（§8.4）**：新增 10 分钟可判定的无线调试验证脚本与通过标准/排障表，作为 P2 门槛。
  6. **口径冲突消解（§5.3）**：结算页实付 vs 含信用卡最低价，用双口径分列，`cheapest` 按 `effectivePrice`（回退 `payable`）并同时报两列。
  7. **合规口径统一（§3.1/§10）**：删除"不违反条款"的绝对表述，统一为"低频只读、不自动下单/支付、不突破风控，风险不为零、用户自担"。
  8. **OCR 质量评估独立（§3.3/§6.3.4）**：新增四步质量门（逐字段置信/二次比对/ROI 对照/合理性先验），`extraction.confidence` 由质量门决定，zod 只作算术护栏，OCR 永不单独产出 `high`。
  9. **验收标准（§9）**：每阶段补可判定的 DoD（P0 五类用例+覆盖率、P1 幂等/取消/重取/过期、P2 §8.4 实验、P3 干扰注入、P4 快照一致等）。
  10. 附带：`item.listPrice` 正式纳入 `Quote`/`QuoteSchema`；§6.3.2 schema 同步新增 `effectivePrice`/`deviatedConditions`/`listPrice`；§8 `state.json` 引用改为 §5.6。
- **v0.3.1（仅文档 · 一致性修复）**：
  1. **§6.3.2 `QuoteSchema` 与 §6.2 `Quote` 逐字段对齐**：补上此前缺失的 `store`、`item.composition`、`arithmetic`、`extraction`、`needsConfirm`、`optionalSavings`、`evidence`；`DiscountSchema` 补 `kind/id/name`（原名 `DiscountLine` 改名为 `DiscountSchema` 以免与 interface 混淆）。
  2. 新增 **`superRefine` 交叉校验**：`arithmetic.expected` 与 `arithmetic.balanced` 必须与 `fees/discounts/payable` 重算一致，防止"自报字段撒谎"。
  3. 修正 zod 用法：**`superRefine` 的 `ctx.addIssue` 必须用 `message`**（误用 `error` 会静默降级为 "Invalid input"，已实测）；`.refine` 仍用 `{ error, path }`。文档与代码已按实测分别书写。
  4. §6.2 末尾补"接口 ↔ schema 1:1 对应"说明；本地 zod 4.6.7 实测：默认值补齐、缺 `store/evidence` 被拒、`arithmetic` 撒谎被精确报错。
- **v0.3.0（仅文档 · 六大结构性加固）**：
  1. **§6.3 价格校验漏洞**：改为**两层校验**——算术自洽（`arithmetic`）与识别可信度（`extraction`）**分开评定**；新增费用/优惠的完整分类与 `source(tree/ocr/derived)`、`scope(item/order/delivery)`；明确"勾稽通过≠金额正确"，含"双错平账"判定矩阵，OCR 命中最高只到 `medium`。
  2. **§5.4/§5.5 优惠记账不可靠**：引入**四态可用性**（`verified/presumed/known_unavailable/unknown`）+ `sourceOfTruth`；本地记账仅作参考、只能降级不能升级；`exclusiveGroup` 仅在显式互斥时生效，**同卡跨平台默认不互斥**（新增 `crossPlatformExclusive`）。
  3. **§6.2/§6.4 "同一顿饭"不完整**：新增 `ComparisonConditions`（数量/规格/加料/套餐组成/配送地址/期望送达时间）与 `composition`；`CompareResult` 改为**按等价分组** `groups[]`，不可比不混排；`cheapest` 仅在同可比组内取。
  4. **§3.5.4 Android 缺验证闭环**：新增**设备能力探测（probe）/ 多信号页面识别（pageDetect）/ 截图基线对照 / 每平台"识别方式适用矩阵" / 只读演练**；不假定控件树一定可靠。
  5. **§7.5 异步任务缺完整生命周期**：任务**持久化**（`tasks/*.json`）、**幂等启动**、超时终止、**取消确认**、`getResult/listTasks` **结果重取**、DSH 重启恢复、结果过期；**完成状态与通知送达解耦**。
  6. **§6.5 价格证据规范**：每条报价绑定 `quoteId`/抓取时间/门店/规格/费用明细/原始识别结果/校验结果；**TTL 有效期**（过期提示重新核价，禁止当现价）、**脱敏**、**清理**、**证据缺失降级**。
  7. 配套更新：§4 目录树新增 `probe.ts/pageDetect.ts/task/store.ts/task/lifecycle.ts/price/evidence.ts` 及对应测试；§8 存储说明补 `tasks/`；§9 阶段计划与 §10 风险随之更新。
- **v0.2.2（仅文档 · 缺陷修正）**：
  1. §6.3 修 zod 示例两处 bug：① `QuoteSchema` 补 `item` 字段（否则 `q.item?.qty` 恒 undefined→1，量级校验失效）；② `.refine` 改用 zod4 的 `{ error, path }`（`message` 已弃用）。
  2. §6.3 容差从 `max(1.5, 5%)` 收紧为 `min(1.0, 5%)` 且**按平台可配置**（`priceToleranceYuan`）。
  3. §6.2 `CompareResult.cheapest` 改为 `Quote | null`，新增"全部 `needsConfirm` 时 `cheapest: null` + notes 提示"的兜底约定。
  4. §5.1 `weekday: 3` 改为 `weekday: 'wednesday'`（消除 0-based 歧义，附 1–7 说明）。
  5. §6.2 `Discount` 增加 `platform` 字段；§5.4 记账键改为 `platform + strategyId`（跨平台排他落地）。
  6. §3.3/§6.2 `fees` 增加可选 `listPrice`（列表页价留痕，不参与计算）。
  7. §7 统一命名：一律用 `taskId`（不再混用 jobId）。
  8. §8 版本号改为**本机实测**表（Node/pnpm/npm/Ubuntu/内核/adb），并新增 §8.3「adb 探活与掉线重连」。
  9. §4 目录树补 `PLAN.md`、`CHANGELOG.md` 两行。
- **v0.2.1（仅文档）**：新增 `CHANGELOG.md`，从头记录项目每一次变动（Why / What / State），并建立后续追加模板；本节与文末版本号同步更新。无代码改动。
- **v0.2（按评审意见）**
  1. 新增 §3.5「前置规范与状态验证」：每步动作+Layout XML 断言+超时+弹窗恢复，杜绝盲等。
  2. 新增 §6.3「zod 数值勾稽校验」：`商品+配送+打包−自动优惠 ≈ 实付`，防 OCR 把 `¥28.9` 读成 `¥289`；失败分级处理。
  3. 重写 §7「异步任务架构」：`price_agent` 立即返回 `taskId`，用 `ctx.jobs` 后台执行 + `updateProgress` 流式进度，复用 `dsh-client-ui-jobs` UI，规避 Tool 超时。
  4. 加固 §5.1「信用卡/平台券排他逻辑」：`lastUsedAt / dailyLimit / monthlyLimit / totalQuota / exclusiveGroup`，避免算出"享受不到"的虚低价。
  5. 深化 §6「数据模型」：门店加 `amapId/platformShopId`，商品加 `spec/matchedScore`，新增 `needsConfirm` 与 `evidence.extraction`。
  6. §11 由"待确认"改为"已锁定决策"，P1 明确包含异步任务流与 Mock 先行。
- **v0.1** 初版方案（架构、模块、分阶段）。

---

*决策记录 · 文档版本 v0.8.0*
