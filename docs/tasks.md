# 开发任务与验收标准（Tasks / DoD）

> 本文件把项目拆成**可执行阶段**（P0–P5），每阶段给出**可判定的验收标准（DoD）**，不达标不算完成。
> **章节编号保持 §9 不变**。技术设计见 [`module-spec.md`](./module-spec.md)，决策见 [`decisions.md`](./decisions.md)。

**当前进度**：基建完成 + **P0 完成** + **P1 完成**（插件骨架 + 异步任务 + Mock，全链路跑通）+ **P2 完成**（adb 驱动/连接重连/能力探测/弹窗恢复/截图留证/只读演练脚本；**真机 §8.4 最小实验 PASS：Lenovo TB321FU / Android 16**）+ **P3 完成**（**美团真机"首页→搜索→选店→选规格/加购→去结算→读实付"全流程自动化跑通并验收** —— 券前/神抢手两种结算页布局抽取，`payable` 正确、`arithmetic.balanced`、`confidence=high`、`needsConfirm=false`；"待使用红包"作 presumed optionalSaving 不计入；`tapPoint` 安全点按、验证码 `NeedsHumanError` 零点击）+ **P4 完成**（**多平台 + 策略 + 等价分组**：饿了么真机结算页抽取（id/坐标行双路径）+ 策略四态（`price/strategies.ts`，配置最多 `presumed`、绝不假断言可用）+ 谨慎跨平台互斥（默认不互斥，显式才降级）+ 统一输入快照 `snapshotId/hash` 贯通 Quote 并在 `compare` 强制同快照、偏离归不可比组；离线 **120 tests** 全绿，`src/price` 行覆盖 97%+）+ **P5 打磨（已完成 ✅）**（截图默认脱敏覆盖**成功证据+失败取证**两条路径（`device/redact.ts`+`device/capture.ts`，无法脱敏则不落图）／证据 TTL+保留上限清理 `task/cleanup.ts`／瞬时异常重试 `core/retry.ts`（验证码·支付绝不重试）／证据真实绑定 dump+脱敏图+OCR 逐词框；离线 **161 tests** 全绿，`src/price` 行覆盖 97.15%）。**✅ 真机端到端已复测通过（2026-10-25）**：平板切回全屏竖屏（`mBounds=Rect(0,0-1600,2560)`、`ROTATION_0`、`fullscreen`、`inPcmode=0`）后，6 个真机链路缺陷修复（启动 App / 回首页 / dump 陈旧 / 重试 / 首页锚点 / 窗口坐标映射）全部生效，`runCompare` 真机全流程一步跑通：**payable=¥29.88、balanced=true、confidence=high、needsConfirm=false**，证据脱敏落盘。`docs/HANDOFF-device-p5.md` 已结项。

> **P4 真机边界（用户已登录后复测，2026-10-24）**：饿了么**整个 App 是 canvas/TMS 自绘**——`uiautomator dump` 全页仅 1 个 `water_mark_view` 节点，首页/搜索/结果/店铺/**结算页**均无可读控件树 → 控件树路径**不可行**。已落地**截图 ROI OCR** 兜底（`ocr/tesseract.ts` + `elemeReal.extractElemeSettleFromOcr` + `settlePanelRoi` 取右栏 `tms_fragment_container`）：真机实跑读到 **payable=¥20.8**（截图"立即支付 ¥20.8"）；因 OCR 偶发丢"打包费 ¥1"数字 → delta −1 → 如实 `confidence=low / needsConfirm=true`（不硬凑，符合 §6.3.4）。饿了么**全自动导航**（canvas 无文案钩子、只能靠 resourceId + 坐标）不如美团稳定；当前**可稳定验收的是"结算页 OCR 读数"**。全程只读，未点提交/支付。


---

## 9. 分阶段落地计划与验收标准（DoD）

> 每一阶段都给出**可判定的验收标准**（Acceptance Criteria），不达标不算完成。测试优先覆盖纯逻辑（P0）与生命周期（P1）。

| 阶段 | 内容 | 验收标准（DoD） |
|---|---|---|
| **P0 纯逻辑内核**（2–3 天） | 数据模型（FeeLine/Discount/Evidence/ComparisonConditions/InputSnapshot）+ 到手价引擎（`payable`/`effectivePrice` 双口径 + 四态可用性）+ 两层校验（算术 × 识别）+ 相似度/等价判定 + 证据 TTL | ① 单测全绿；② `¥28.9/¥289`、**双错平账**、**重复计算**、**推测当可用**、**不可比分组** 五类用例均有断言；③ 任意样例 `effectivePrice` 只能扣 `verified && !alreadyIncludedInPayable` 的优惠（脚本验证）；④ 覆盖率 `pricing/schema` ≥ 90%；⑤ 纯核心**无 IO 依赖**（lint/测试可证明） |
| **P1 插件骨架 + 异步任务 + Mock**（2–3 天） | 插件包 + `cordis.patch.yml` + `price_agent` 异步工具（taskId / 进度 / 生命周期） + Mock 驱动 + **解耦/幂等/并发规范（§2.1/§7.6/§7.7）** | ① 一句话→`taskId`→进度→比价表全链路跑通；② **解耦**：`device.driver=mock|adb` 切换**不改业务代码**，`price/*` 脱离设备可单测；③ **幂等**：同 key 连调（含并发 10 次）只产生 1 个任务，`getResult` 可重复只读，同键异参返回 `IDEMPOTENCY_KEY_REUSED`；④ **并发**：设备锁下两任务串行不交叉点按，记账并发写不损坏，锁超时返回 `BUSY`；⑤ **取消**：取消后 `status=cancelled` 且 Mock 子步骤停止；⑥ **重取**：DSH 重启后凭 `taskId` 取回结果；⑦ **过期**：TTL 过后返回 `expired`；⑧ 结果原子写入（无半截 JSON）；⑨ **复用**：抽查无自写存储/锁/spawn（全部走 §2.2 复用清单）；⑩ **边界**：`price/*` 无 IO、`task/*` 不 import 设备实现、循环依赖=0（§4.4 规则可校验） |
| **P2 真机通道 + 能力探测**（2–3 天） | adb 无线调试、driver、能力探测/页面识别/截图对照/状态机断言/弹窗拦截 | ① 用 §8.4 最小实验脚本判定无线调试**可用**；② 断开后**自动重连 1 次**，再失败给出可读报错；③ 对美团跑"只读演练"，产出**能力探测报告**（哪些页面 tree 可读/需 OCR）；④ 每步断言失败能**截图 + dump 留证** |
| **P3 单平台抓价**（3–5 天） | 美团"搜索→选店→结算→读实付" + 控件/OCR + 两层校验 + 证据绑定 | ① 对目标门店取到 `payable`，并给出 `confidence`/`evidence`/`validUntil`；② 注入 3 种干扰（升级弹窗/定位授权/加载慢）仍能完成或明确 fail 并留证；③ OCR 路径触发质量门（低置信→`needsConfirm`） |
| **P4 多平台 + 策略 + 等价分组**（已完成 ✅） | 饿了么接入、优惠四态、谨慎互斥、统一输入快照 + 分组比价 | ① 两平台从**同一 `snapshotId`** 派生 ✅（Quote 带 `snapshotId/hash`，`compare` 校验 `query.hash` 唯一）；② 条件偏离的 Quote 归入不可比组 ✅（`detectDeviations` + snapshot 不一致强制 `deviatedConditions` → `comparable=false`）；③ `effectivePrice` 双口径正确、无重复扣 ✅（仅 `verified && !alreadyIncluded` 扣；presumed 不扣）；④ 跨平台默认不互斥、显式才互斥 ✅（`applyCrossPlatformExclusivity`） |
| **P5 打磨**（已完成 ✅） | 弹窗/风控、异常重试、证据清理、隐私与合规 | ① 隐私：截图默认脱敏且可清理 ✅（`redact.ts` 零依赖 PNG 掩码，无法脱敏则不落图；**成功证据 `runner.bindEvidence` 与失败取证 `capture.ts` 均默认脱敏**；`cleanup.ts` 按 TTL+保留上限清 `evidence/`+`results/`）；② 遇验证码暂停并提示 ✅（`NeedsHumanError` 即停；`core/retry.ts` 明确**不重试**验证码/支付）；③ 文档与实现一致 ✅（模块文档 + CHANGELOG[37]） |

> **本轮交付边界：先做 P0 + P1（不碰手机、Mock 数据）**，你在 DSH 里就能看到"一句话 → taskId → 实时进度 → 分组比价 → 证据过期/重取"的完整效果。**P0/P1 的 DoD 全绿**后再决定是否投 P2+ 真机。

---

*开发任务 · 文档版本 v0.8.0*
