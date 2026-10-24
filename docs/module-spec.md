# 模块规范（Module Spec）

> 本文件是 `dsh-price-agent` 的**规范性技术设计**：架构、关键难点、运行环境/技术栈/目录/边界、配置与策略、数据模型、异步任务、WSL2 细节。
> **章节编号与拆分前完全一致（§2–§8）**，故全文对 `§x.y` 的引用依然有效。总纲见 [`../PLAN.md`](../PLAN.md)，任务见 [`tasks.md`](./tasks.md)，决策见 [`decisions.md`](./decisions.md)。

**目录**（章节号沿用拆分前）：§2 总体架构 · §3 关键难点与路线 · §4 环境/技术栈/目录/边界 · §5 配置与策略 · §6 数据模型 · §7 异步任务 · §8 WSL2 细节

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  DSH Web (你正在用的这个 GUI, http://127.0.0.1:3080)                   │
│  └─ Agent (DeepSeek Harness)                                          │
│      └─ 你的一句话: "我想吃香叶的烤鸭饭"                                 │
│           │                                                           │
│           ▼  调用工具 (立即返回 taskId, 不阻塞)                         │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ 插件: dsh-plugin-price-agent  (package: dsh-price-agent)          │  │
│  │                                                                  │  │
│  │  ┌───────────────┐   ┌───────────────┐   ┌────────────────────┐  │  │
│  │  │ price_agent   │──▶│ task runner   │──▶│ device_driver      │  │  │
│  │  │ (tool, async) │   │ (dsh-jobs)    │   │ (adb + 状态机断言)  │  │  │
│  │  └───────┬───────┘   └───────┬───────┘   └─────────┬──────────┘  │  │
│  │          │ taskId           │ updateProgress       │             │  │
│  │          ▼                   ▼                      ▼             │  │
│  │  ┌───────────────┐   ┌───────────────┐   ┌────────────────────┐  │  │
│  │  │ pricing 引擎   │◀──│ platform      │──▶│ screenshot/ocr    │  │  │
│  │  │ + zod 校验     │   │ strategies    │   │ + 数值勾稽校验      │  │  │
│  │  └───────────────┘   └───────────────┘   └────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│           │ 后台 job 事件 (running→completed)                          │
│           ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ 前端: 复用 dsh-client-ui-jobs 后台任务面板 / 工具卡片流式渲染      │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
                                  │ adb 无线调试 (adb connect 手机IP:端口)
                                  ▼
                    ┌──────────────────────────────┐
                    │ 你的 Android 手机             │
                    │  美团 / 饿了么                │
                    └──────────────────────────────┘
```

模块职责：

1. **`price_agent`（DSH 工具，异步）**：AI 唯一直接调用的入口。**立即返回 `taskId` + `status: processing`**，后台跑比价，前端实时看进度，完成后推送 `CompareResult`（详见 §7）。
2. **`task runner`**：用 DSH 内置的 `ctx.jobs`（`dsh-jobs-local` + `dsh-tool-jobs`，`dsh-base` 已自带）承接长任务，`JobHandle.updateProgress(line)` 广播进度（"正在打开美团…"）。
3. **`platform router`**：根据配置决定"这次去哪些平台比价"。
4. **`device_driver`**：真正操作手机（adb），**每一步都带状态机断言**（§3.5）。
5. **`platform strategies`**：每个平台一份配置（App 包名、搜索入口、关键控件、绑定的信用卡/会员/红包策略、排他额度）。
6. **`pricing` 引擎**：把结算页金额 + 策略规则，统一折算成"最终到手价"，并做 **zod 数值勾稽校验**（§6.3）。
7. **`screenshot/ocr`**：控件树读不到时截屏 + OCR 兜底，OCR 结果同样过 zod 校验并先过质量门（§6.3.4）。

### 2.1 ★解耦规范（Normative）

前面多处提到"Mock 先行、前后端解耦、与 DSH job 解耦"，但未明文约束。此处给出**强制规范**，实现必须满足：

**R1 分层与依赖方向（单向依赖，禁止反向 import）**
`tools/price-agent`（接口层）→ `task/*`（编排层）→ { `platform/*`, `device/*`, `price/*`, `ocr/*` }（能力层）。规则：
- 能力层**不得** import 接口层或编排层；编排层**不得** import adb/OCR 具体实现，只依赖 `device/driver.ts` 等**抽象接口**。
- 跨层通信只走**数据契约**（§6.2 的 `Quote`/`CompareResult`/`Evidence`），不允许共享可变全局状态。

**R2 依赖注入（DI）总线**
- 下列外部能力一律通过**注入**获得，禁止在业务代码里 `new`/`require` 具体实现：`Driver`（adb/appium/**mock**）、`Ocr`、`Clock`、`Fs`、`Jobs`。
- 由插件入口按配置装配：`device.driver='mock'` 时装配 **MockDriver**，其余同理；生产代码对"真机/OCR/时间/文件系统"零硬编码。
- **`Fs`/`Jobs` 必须复用 DSH 已有 seam**（`ctx.fs`、`ctx.jobs`），不得自写文件读写/后台任务服务（见 §2.2）。

**R3 Mock 契约（先跑通再换真机）**
- 必须提供 **MockDriver**：回放 `test/fixtures/` 下的 dump/截图序列，**实现与 `adb.ts` 完全相同的 `Driver` 接口**。
- 要求：**同一套上层编排代码，切换 `device.driver=mock|adb` 即可运行**，不改一行业务逻辑；Mock 阶段即可验证分组、证据 TTL、幂等/并发（§7.5–§7.7）、`effectivePrice` 双口径。
- **禁止**把真机逻辑写进 pricing/engine（纯函数，无 IO）；pricing 必须能脱离设备单测。

**R4 纯核心（purity boundary）**
- `price/engine.ts`、`price/schema.ts`、`price/similarity.ts` 必须是**纯函数/纯校验**（无 IO、无时间随机、无网络）；时间通过注入的 `Clock` 传入。只有 `device/*`、`ocr/*`、`task/*` 允许副作用。

**R5 与 DSH 运行时解耦**
- 业务状态（任务记录、记账、幂等映射）存 **`ctx.storageDomain`**（`tasks`/`ledger`/`idempotency` 表，由 `dsh-storage-json` 落盘）；截图等二进制存 `.price-agent/evidence/`。**不依赖 DSH 进程内 job 存活**；DSH job 仅用于"进度 UI + 通知"，其丢失不影响任务事实（呼应 §7.5(5)）。
- **存储与原子写/锁一律复用**：`ctx.storageDomain`（schema 校验的持久 KV）+ `dsh-atomic-write`（`writeFileAtomic` + 跨进程 `withWriterLock`），不自写 JSON 存储/锁（见 §2.2）。

**R6 前端解耦**
- 进度只经 `JobHandle.updateProgress()` 与工具结果两条通道输出，前端（`dsh-client-ui-jobs`）**不订阅业务内部事件**；更换 UI 不需改动后端。

> 验收：P1 的 DoD 明确要求"切 mock/adb 不改业务代码"、"pricing 脱离设备可单测"（§9）。

### 2.2 ★复用优先清单（Reuse-First：禁止重复造轮子）

本方案早期草稿有 3 处**重复造轮子**风险，已核查 DSH 内置能力并改为复用。**原则：凡 DSH 已提供的能力，一律注入复用，禁止自写。**

| 能力 | 早期草稿（重复） | **改为复用** | 依据（已核查） |
|---|---|---|---|
| 持久化存储 | 自写 `tasks/store.ts` + `evidence/*` + `state.json` 的 JSON 读写/清理 | `ctx.storageDomain`（schema 校验、顺序写、`domain/changed`）+ `dsh-storage-json` | `dsh-base` 已挂载 `storage`/`storage-json`(`root=$DSH_HOME/storages`)/`storage-domain` |
| 原子写 + 文件锁 | §7.5 自写"tmp→rename + checksum"、§7.7 自写设备锁/快照锁/文件锁 | `dsh-atomic-write` 的 `writeFileAtomic`（随机后缀 temp+rename）与 `withWriterLock`（wx `<file>.lock`、记录 PID、`ESRCH` 自动接管） | 该库零依赖、已随 DSH 安装，锁语义与我们 §7.7 R4 完全一致 |
| 后台任务/进度/通知/取消 | 自写任务调度、进度总线、完成通知、取消 | `ctx.jobs`（`dsh-jobs-local`）+ `dsh-tool-jobs`（`job_output/list/kill` + 完成通知） | `dsh-base` 已挂载，`JobHandle.updateProgress` 即进度通道 |
| 命令执行/设备操控 | 自己拼 `child_process` 调 adb | **`runNativeCommand('adb', argv, signal, 'hidden')`**（`dsh-native-command`，shell-free、捕获 stdout/stderr、取消、`ENOENT` 区分） | 已随 DSH 安装（host 库） |
| 超时/定时 | 自写 `setTimeout` + 清理 | `ctx.timeout(...)` / `cordis-plugin-timer` | `dsh-base` 已挂载 `timer` |
| 人工介入（登录/验证码） | 自写进度提示后静默等待 | `dsh-user-questions`（`user-questions` 服务）在会话里**结构化提问**并等用户回答 | `dsh-base` 已挂载 `user-questions` |
| 大输出截断/省略提示 | 自写截断 | `dsh-output-retention`（`ItemRetainer/TextRetainer` + 省略提示） | 已随 DSH 安装 |

**保留自建（DSH 无对应能力、必须自写）**：`device/{mock,probe,state,recover,pageDetect,adb,appium}.ts`（Android 自动化是本产品核心，无现成件）、`price/{engine,schema,similarity}`（比价算法）、`platform/*`（平台选择器/策略）、`ocr/*`（OCR 质量门）、`tools/price-agent.ts`（工具定义）。这些**不是造轮子，是业务本体**。

**派生规则（实现时强制抽查）**：
1. 新增任何"存储/锁/原子写/定时/子进程/截断/提问"代码前，先在本清单找现成件；找不到才自写，并在 PR 说明理由。
2. **只允许薄封装**：`device/adb.ts` 内部必须调用 `runNativeCommand`，**不得**再实现 spawn/超时/取消；`task/store.ts` 只做"领域模型 ↔ storageDomain 表"的映射，**不得**自己读写文件；`task/idempotency.ts` 用 `withWriterLock` 保证"先写键再执行"的原子性。
3. **禁止引入**：`proper-lockfile`、`write-file-atomic`、`lowdb`、`p-limit` 等第三方件——DSH 已覆盖等价能力，引入即重复。
4. 复用不改变语义：`storageDomain` 保证"写落盘后才 resolve"，正好满足 §7.5"先落持久记录再发通知"。

> 收益：减少约 2 个自写模块与大量并发/原子性细节代码，**锁与持久化的正确性直接继承 DSH 已验证实现**，降低我们把幂等/并发写错的风险。

---

## 3. 关键难点与路线（重点看这一节）

### 3.1 用 adb 驱动 Android（路线 A，已锁定）

- **原理**：`adb shell uiautomator dump` 拿控件树（XML），按文案/资源 ID 定位；`adb shell input tap/swipe/text` 模拟操作；`adb exec-out screencap -p` 截屏。
- **为什么选它**：不 root、不改 App、可离线；把"打开/搜索/进结算页"拆成确定性脚本，AI 只在最后比价介入。**合规前提**：仅操作**你本人设备上的你本人账号、低频、只读**（只到结算页读价，不提交订单、不支付）；这降低但不消除违反平台用户协议的风险，详见 §10。
- **封装**：直接 `adb`（Node `child_process`）为主，`Appium` 作为复杂交互备选，让插件纯 Node、易随 DSH 分发。
- **前提**：手机开「开发者选项 → 无线调试」，与 WSL 同局域网（§8）。

### 3.2 iPhone（不纳入本期）

- iOS 无合法的通用自动化通道；`WebDriverAgent` 需 Mac + 签名 + 开发者账号，且违反多数 App 条款。
- **本期不做 iPhone**。若将来需要，只能做"人工操作 + 截图 OCR 比价"的半自动兜底，体验远不及 Android 全自动。

### 3.3 价格抓取（"到手价"到底怎么读）

- **首选：控件树（Accessibility Tree）**。结算页"实付 ¥xx.xx"通常是原生控件，直接取文本最稳。
- **兜底：OCR**。价格是自定义绘制/图片时，截屏后 OCR 识别"实付""合计"附近数字。
- **OCR 不能只靠 zod 兜底**：zod 勾稽只能挡"算术明显不平"的错，挡不住"读错但仍自洽"的错。因此 OCR 路径必须**先做识别质量评估**（逐字段置信分、关键数字与截图 ROI 的二次比对、必要时二次识别/人工确认），zod 只作为最后一道算术护栏（见 §6.3）。
- **口径**：统一读"结算页 → 实付总额"，并尽量抓回费用明细（商品/配送/打包/优惠），便于解释"为什么便宜"。搜索页价格**只作候选初筛**（列表页价写入 `Quote.fees.listPrice` 留痕，仅用于解释价差，**不参与比价计算**）。

### 3.4 不能自动下单（合规红线）

- 本插件**只读价格、不进支付**。任何"提交订单/付款"都要你本人确认；插件最多停在"结算页"，把截图给你看。
- 不破解 App、不抓包伪造请求、不用非官方接口刷数据。

### 3.5 ★前置规范与状态验证（Pre-specifications & State Verification）— 本轮重点强化

移动端自动化的头号失败原因是**弹窗（升级提示、广告、定位授权、骑手打赏）+ 网络加载延迟**，而不是点击本身。因此 `device_driver` 必须**强制引入状态机验证**，杜绝"点一下睡 2 秒再点一下"的盲等模型。

#### 3.5.1 每一步 = 动作 + 断言 + 超时 + 恢复

**核心原则：每一个 `tap` 之后，必须通过 `uiautomator dump` 的 Layout XML 断言"当前处于预期状态"，断言不通过就抛结构化异常，而不是继续或静默失败。**

```ts
// device_driver 的核心原语（示意，非最终代码）
interface Step {
  action: 'tap' | 'input' | 'swipe' | 'wait';
  selector?: UiSelector;           // 资源ID/文案/坐标
  expect: StateAssertion;          // 动作后必须满足的状态
  timeoutMs: number;               // 硬超时，不盲等
  onFail: 'throw' | 'recover';     // 断言失败的处理策略
}

interface StateAssertion {
  presentResourceIds?: string[];   // 必须出现的控件（最可靠）
  presentTexts?: RegExp[];         // 必须出现的文案
  absentResourceIds?: string[];    // 必须消失的控件（证明页面已切换）
}
```

**示例（"去结算" → 结算页）**：
1. 定位并 tap「去结算」按钮；
2. **断言**当前 dump 里出现 `提交订单` 的 Resource ID（如 `com.sankuai.meituan:id/submit_order_btn`）或文案"提交订单"；
3. 若 `timeoutMs` 内断言不成立 → 先尝试**弹窗恢复流程**（§3.5.2）；仍失败则抛出 `StateAssertionError{ expected, actualDumpPath, screenshotPath }`，由上层把"卡在哪一步 + 截图"回传给你，而不是报一个无信息的"点击失败"。

#### 3.5.2 弹窗/授权/加载的统一拦截层（Pre-flight & Recovery）

在"进入 App 首页"和"进入结算页"两个关键节点，插入**拦截器**，按优先级处理已知干扰：

| 干扰类型 | 识别特征（Layout XML） | 处理动作 |
|---|---|---|
| 版本升级弹窗 | 文案含"立即更新/以后再说" | 点"以后再说/关闭" |
| 广告/开屏 | 资源 ID 含 `splash` / `ad_` / 全屏 WebView | 点右上角跳过/倒计时后关闭 |
| 定位授权 | 文案"是否允许…位置" | 允许（仅前台） |
| 通知授权 | "允许通知" | 允许 |
| 登录态 | 出现"登录/手机号登录" | **中断并提示你手动登录**（不代替登录） |
| 加载中 | 出现 `loading` / 骨架屏 / 空白 | 轮询 dump 直到目标出现或超时 |
| 验证码/风控 | 出现"验证/滑块/安全验证" | **立即暂停并提示你手动处理**（红线，不硬闯） |

> 拦截器是**可用性策略**，全部写进 `platform strategies` 配置（可维护），不硬编码。恢复动作本身也必须走"动作+断言"。

#### 3.5.3 前置规范（Pre-specifications）

开工前先明确并落到配置文件里的"契约"，避免边写边猜：

- **页面契约**：每个关键页面（首页搜索框、搜索结果、门店菜单、购物车、结算页）各自的 `anchorResourceId`（一个页面必有的唯一控件），用于**判断"我现在在哪一页"**。
- **状态转移表**：`首页 → 搜索 → 结果 → 门店 → 购物车 → 结算` 的合法转移及每一步断言；非法转移直接抛错。
- **元素选择器规范**：优先 Resource ID > 文案正则 > 相对坐标兜底；所有选择器集中登记，App 改版只改这一处。
- **超时预算**：每步默认 8s，页面级 20s，整体任务 90s；超时即 fast-fail + 截图留证。

#### 3.5.4 ★设备能力探测与页面识别降级（真实设备验证闭环）

前面的"动作+断言"默认了**控件树一定可读**，但真实 App 常出现：WebView 内嵌 H5 不被 `uiautomator dump` 完整暴露、Canvas/自定义绘制无文本节点、Resource ID 动态生成（每次启动变化）、部分页面只给空壳节点。**因此不能假定每个关键页面都能被 XML 可靠识别**，必须在进入完整购物流程前，先建立"能力探测 → 页面识别 → 截图对照 → 恢复"的闭环。

**(1) 任务前置：设备能力探测（Capability Probe）**（每次任务开始跑一次，结果缓存）
- `uiautomator dump` 是否可用、dump 耗时；
- 屏幕分辨率 / DPI / 语言（坐标兜底与 OCR 缩放的基准）；
- 当前前台包名 / Activity（确认目标 App 版本与入口）；
- 关键页面是否有"可读文本节点"（抽样 dump：文本节点数、Resource ID 稳定性）；
- WebView 迹象（出现 `android.webkit.WebView` 节点 / 无文本但截图有内容）。

**(2) 页面识别：多信号融合，而非只看 Resource ID**
判定"我现在在哪一页"用三路信号加权：① 稳定 Resource ID/文案（首选）→ ② 关键文本 OCR（截图）→ ③ 结构特征（控件层级/数量）+ 截图与基线模板的相似度。任两路一致即可判定；单路不确定时输出 `pageConfidence` 并降级。

**(3) 截图对照（Screenshot Baseline）**
每个关键页面首次跑通后存一张**基线截图**（脱敏）。之后进入该页时，用截图相似度（pHash/SSIM 阈值）辅助确认"是否到了预期页面 / 是否被弹窗遮挡"，可与 XML 断言互为兜底。

**(4) 每平台定义"识别方式适用矩阵"**（写进 `platform strategies`，见 §5.1）

| 页面 | 优先方式 | 兜底 | 人工介入触发 |
|---|---|---|---|
| 首页/搜索框 | 控件树 | 坐标 | 连续 2 次断言失败 |
| 搜索结果 | 控件树 | OCR 文本 | 列表为 WebView |
| 门店菜单 | 控件树 | OCR + 滚动 | 菜单动态渲染 |
| 购物车 | 控件树 | — | 断言失败 |
| 结算页（读价） | 控件树 | OCR + 截图对照 | 价格区域为图片/Canvas |

> **原则**：任一页面"控件树不可靠"时，**先降级到 OCR/截图对照**，仍不可靠则**中止并请求人工**（不硬用坐标乱点）。所有降级路径同样走"动作+断言"。

**(5) 演练（Rehearsal）**：P2/P3 上线前，先对每个平台跑一次**只读演练**（打开→搜索→进结算页→截图/dump），产出"能力探测报告 + 页面识别矩阵实测结果"，据此确定该平台哪些步骤必须人工兜底。演练**不真实下单**。

---

## 4. 运行环境 / 技术栈 / 目录结构 / 模块边界（Normative）

> DSH 插件包形态：npm 包，`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，向 profile 注入插件行与配置。参考内置 `@deepseek-ai/dsh-tool-todo` 的结构。

### 4.1 ★运行环境（Runtime）

| 项 | 要求 | 现状/依据 |
|---|---|---|
| 宿主 OS | Windows + **WSL2 (Ubuntu 26.04.1 LTS)**，与手机同一 WLAN | 已实测 |
| Node | **v24.22.0**（ESM）；**直接执行 `.ts`**（原生类型剥离，无需编译步骤）。**仅支持"可擦除"语法**：不支持参数属性/`enum`/`namespace`（实测 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`） | 已实测 `node t.ts`、`node --test t.test.ts` 均可用 |
| 包管理 | **pnpm 12.14.0** | 已实测 |
| DSH | `@deepseek-ai/dsh` **0.2.1-rc.2**；profile=`web`；peer 依赖须对齐该版本 | 已实测 |
| 手机 | **Android 11+**（无线调试需 Android 11 及以上），开启开发者选项 | 计划前提 |
| adb | `android-tools-adb`（**当前未安装**，需 `apt install`） | 已实测 `which adb` 为空 |
| OCR | 纯 Node 侧，**`tesseract.js`（WASM，无需系统 tesseract）**，语言包 `chi_sim+eng`；抽象在 `Ocr` 接口后可换 | 已实测系统无 tesseract，故走 WASM |
| 原生模块 | **零原生编译依赖**（不引入 sharp/node-pty 等），降低 WSL 装环境成本 | 约束 |

**环境自检（P1 开工前跑一次）**：`node -v` / `pnpm -v` / `node -e "console.log(process.features.typescript)"` / `adb version` / OCR 能识别一张样例图。任一不满足先修环境。

### 4.2 ★技术栈（Stack）

| 关注点 | 选型 | 用法约束 |
|---|---|---|
| 语言 | **TypeScript (ESM)** | `.ts` 直接由 Node 运行；`tsconfig.json` 仅用于编辑/`tsc --noEmit` 类型检查 |
| 配置 schema | **schemastery**（DSH 同源） | `config.ts` 导出 `Config`；配置校验失败在加载期 fail-fast |
| 数据校验 | **zod 4**（`Quote`/`Evidence` 等运行时校验） | 见 §6.3；`.refine` 用 `error`，`superRefine` 内 `addIssue` 用 `message` |
| 工具定义 | **`defineTool`（@deepseek-ai/dsh-tools）** | 只经 `ctx.tools.register` 注册；参数/输出用其 schema DSL |
| DI / 生命周期 | **cordis `Context`**（插件 `apply(ctx, config)`） | 通过 `ctx.*` 取服务，不 `import` 具体实现 |
| 持久化 | **`ctx.storageDomain` + `dsh-storage-json`** | `tasks/ledger/idempotency` 三张表；不自写 JSON 存储 |
| 原子写 + 锁 | **`dsh-atomic-write`**（`writeFileAtomic`/`withWriterLock`） | 设备锁/快照锁/结果写入统一走它 |
| 后台任务 | **`ctx.jobs` + `dsh-tool-jobs`** | 进度用 `JobHandle.updateProgress` |
| 子进程/设备 | **`dsh-native-command` 的 `runNativeCommand`** | 执行 `adb`，shell-free、可取消 |
| 定时/超时 | **`cordis-plugin-timer` / `ctx.timeout`** | 不自写 setTimeout 清理 |
| 人工介入 | **`ctx.userQuestions`（dsh-user-questions）** | 登录/验证码时结构化提问 |
| XML 解析（uiautomator dump） | **`fast-xml-parser`**（零原生、轻量） | 只解析属性与层级，不渲染 |
| OCR | **`tesseract.js`（WASM）** | 逐词 `confidence` + bbox，供 §6.3.4 质量门 |
| 测试 | **`node --test` + `node:assert`（内置）** | 不引入 jest/vitest；`.ts` 直接跑（已实测） |
| 日志 | **`ctx.logger`（cordis）** | 不自写日志库 |

> 依赖收敛：运行依赖仅 `zod` + `schemastery`；可选 `tesseract.js`、`fast-xml-parser`。其余全部复用 DSH（§2.2）。**禁止**引入 `proper-lockfile/write-file-atomic/lowdb/p-limit/jest/vitest`。

### 4.3 ★目录结构（Structure）

```
dsh-plugin-price-agent/
├─ package.json                 # name=dsh-price-agent; type=module; dsh.bundle.patch; engines.dsh
├─ tsconfig.json                # 仅类型检查（noEmit）；Node 直接跑 .ts
├─ cordis.patch.yml             # 向 profile insert 插件行 + 默认配置
├─ PLAN.md / CHANGELOG.md       # 文档
├─ README.md                    # 安装/使用/隐私
├─ .gitignore                   # 忽略 .price-agent/、node_modules、fixtures 原始截图
├─ src/
│  ├─ index.ts                  # ★唯一插件入口：export { name, inject, apply, Config }
│  ├─ config.ts                 # schemastery 配置 schema（平台/设备/策略/排他额度/OCR/TTL）
│  ├─ core/                     # 装配与基础设施（不依赖业务）
│  │  ├─ container.ts           #   DI 装配：按 config 选 mock/adb、注入 Clock/Fs/Jobs/Ocr
│  │  ├─ clock.ts               #   Clock 抽象 + SystemClock/FakeClock
│  │  └─ locks.ts               #   设备锁/快照单飞（withWriterLock 薄封装）
│  ├─ task/                     # 编排层（依赖抽象接口，不依赖具体实现）
│  │  ├─ runner.ts              #   任务编排：ctx.jobs.start + updateProgress
│  │  ├─ progress.ts            #   进度事件与状态机
│  │  ├─ store.ts               #   领域模型↔ctx.storageDomain 映射
│  │  ├─ idempotency.ts         #   幂等键/映射/保留期（§7.6）
│  │  └─ lifecycle.ts           #   超时/取消确认/重取/重启恢复
│  ├─ platform/                 # 平台策略层
│  │  ├─ types.ts               #   PlatformStrategy 接口（契约）
│  │  ├─ router.ts              #   选择参与比价的平台
│  │  ├─ meituan.ts             #   美团策略
│  │  ├─ eleme.ts               #   饿了么策略
│  │  └─ selectors/             #   选择器集中登记（App 改版只改这里）
│  ├─ device/                   # 设备能力层（实现 Driver 接口）
│  │  ├─ driver.ts              #   Driver 抽象接口（tap/input/swipe/dump/screencap）
│  │  ├─ adb.ts                 #   adb 实现（内部 runNativeCommand）
│  │  ├─ mock.ts                #   MockDriver（回放 fixtures）
│  │  ├─ probe.ts               #   能力探测
│  │  ├─ state.ts               #   状态机断言
│  │  ├─ recover.ts             #   弹窗/授权/恢复
│  │  ├─ pageDetect.ts          #   页面识别（XML+OCR+截图）
│  │  └─ appium.ts              #   （备选实现）
│  ├─ price/                    # 纯核心（无 IO）
│  │  ├─ model.ts               #   Quote/FeeLine/Discount/Evidence 类型（唯一真源）
│  │  ├─ schema.ts              #   zod 两层校验
│  │  ├─ engine.ts              #   折算引擎（payable/effectivePrice/四态）
│  │  ├─ similarity.ts          #   相似度 + 等价判定
│  │  └─ evidence.ts            #   证据 TTL/脱敏/缺失降级（映射 storageDomain）
│  ├─ ocr/
│  │  ├─ reader.ts              #   Ocr 接口 + tesseract.js 实现（质量门）
│  │  └─ mock.ts                #   MockOcr
│  └─ tools/
│     └─ price-agent.ts         #   defineTool(price_agent)：start/getResult/listTasks/cancel
├─ test/
│  ├─ pricing.engine.test.ts / schema.test.ts / similarity.test.ts
│  ├─ state.machine.test.ts / lifecycle.test.ts
│  ├─ idempotency.test.ts / concurrency.test.ts / decoupling.test.ts
│  └─ fixtures/                 # dump XML / 截图（脱敏）样本
└─ ...
```

`package.json` 关键字段（示意）：
```jsonc
{
  "name": "dsh-price-agent",
  "type": "module",
  "exports": { ".": "./src/index.ts" },       // 开发用源码；发布时指向构建产物
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": "0.2.1-rc.2" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "0.2.1-rc.2", "@deepseek-ai/cordis": "~4.0.5" },
  "dependencies": { "zod": "4.4.3", "@deepseek-ai/schemastery": "~3.18.5" },
  "optionalDependencies": { "tesseract.js": "^5", "fast-xml-parser": "^4" },
  "scripts": { "test": "node --test", "typecheck": "tsc --noEmit" }
}
```

### 4.4 ★模块边界（Module Boundaries，可执行约束）

> **按模块实现时**：只读该模块的说明文档 `docs/modules/NN-*.md`（只写模块特有内容）；本节的边界/契约是**共享规则**，供查证。各模块文档见 [`docs/modules/README.md`](./modules/README.md)。

**分层（自上而下，只允许向下依赖）**：
```
tools ──▶ task ──▶ { platform, price } ──▶ device/ocr(仅经抽象接口)
  │                                            ▲
  └──────────────▶ core(装配/Clock/锁) ◀───────┘   （core 被各层使用，但不反向依赖业务）
```

**每个模块的职责 / 公开 API / 允许依赖 / 禁止**：

| 模块 | 职责 | 对外公开 API（仅这些） | 允许依赖 | 禁止 |
|---|---|---|---|---|
| `index.ts` | 插件入口 | `name, inject, apply, Config` | 全部（仅装配） | 含业务逻辑 |
| `core/*` | DI/Clock/锁 | `container.ts: buildContainer(cfg)`, `clock.ts: Clock`, `locks.ts: withDeviceLock/withSnapshotLock` | 仅 `dsh-*` 与 `price/model` 类型 | 依赖 `device/platform/task` 具体实现 |
| `task/*` | 编排/生命周期 | `startTask/getResult/listTasks/cancel` | `core`, `price/model`, `platform/types`, `device/driver`, `ocr/reader(接口)` | `import adb.ts/tesseract 具体实现`；`import tools/*` |
| `platform/*` | 平台策略 | `PlatformStrategy` 接口 + `router.select()` | `price/model`, `device/driver(接口)` | 直接操作 adb；直接写存储 |
| `price/*` | 纯算法 | `Quote` 等类型 + `validateQuote/priceQuote/similarity` | **仅 zod**（无 IO、无 device） | 任何 `fs/ctx/device/ocr` 引用 |
| `device/*` | 设备实现 | `Driver` 接口 + `createAdbDriver/createMockDriver` | `dsh-native-command`, `core/clock` | 依赖 `price/task/platform` |
| `ocr/*` | 识别实现 | `Ocr` 接口 + `createTesseractOcr/createMockOcr` | `tesseract.js`（仅实现文件内） | 依赖 `price/task/device` |
| `tools/*` | 工具定义 | `defineTool(price_agent)` | `task/*`, `price/model`, `config` | 直接碰 `device/ocr` 实现 |
| `config.ts` | 配置 schema | `Config` | `schemastery` | 业务逻辑 |

**硬性边界规则（CI/lint 可校验）**：
1. **`price/*` 禁止 import 任何非 `zod`/`node:` 内置**（保证纯核心可脱离设备单测）。
2. **`task/*` 与 `platform/*` 只能 import `device/driver.ts`、`ocr/reader.ts` 的接口类型**，不得 import `adb.ts`/`tesseract` 实现（由 `core/container` 运行时注入）。
3. **`tools/*` 不直接调用 `ctx.jobs`/`ctx.storageDomain`**，只调 `task/*`（便于 Mock 替换）。
4. **只有 `index.ts` 与 `cordis.patch.yml` 对外**；其余为内部模块，不进 `package.json` 的 `exports`（测试可经相对路径 import）。
5. **共享类型唯一真源**：`Quote/FeeLine/Discount/Evidence/ComparisonConditions` 只在 `price/model.ts` 定义，其它模块 `import type`，禁止重复定义。
6. 循环依赖为 **0**，由 `scripts/check-boundary.mjs` 静态校验（零依赖、`pnpm boundary`，已纳入 `pnpm check`）。

`cordis.patch.yml` 形态（示意）：

```yaml
- insert:
    - id: price-agent
      name: 'dsh-price-agent'
      config:
        device:
          driver: adb            # adb | appium
          serial: auto           # 多设备时指定
        task:
          stepTimeoutMs: 8000    # 单步硬超时
          pageTimeoutMs: 20000   # 页面级超时
          taskTimeoutMs: 90000   # 整体任务超时
        platforms:
          meituan: { enabled: true, appId: com.sankuai.meituan, priceToleranceYuan: 1.0 }
          eleme:   { enabled: true, appId: me.ele,               priceToleranceYuan: 1.0 }
```

---

## 5. 配置与"平台策略"模型（重点：信用卡/红包怎么算）

### 5.1 ★平台级策略（含排他/额度）

银行卡优惠通常有**总额度（抢完即止）/ 单日限次 / 每月限次**，但**这些额度对本地程序通常不可观测**。因此本方案不假设"知道额度就不虚算"，而是用 §5.4 的**四态可用性**保守处理：只有结算页实时实证的才计入主价，其余最多作"推测"提示。

```yaml
meituan:
  appId: com.sankuai.meituan
  searchEntry: { type: 'home-search', placeholder: '搜索商家/商品' }
  settlePage: { anchorResourceId: 'com.sankuai.meituan:id/submit_order_btn', amountLabel: ['实付', '合计'] }
  strategies:
    - id: cmb-wednesday            # ★策略唯一 ID，用于额度记账
      kind: credit_card
      name: '招商银行 周三满50减10'
      condition: { minSpend: 50, weekday: 'wednesday' }   # 仅周三生效；用英文枚举避免 0-based 歧义（也可用 1–7，其中 1=周一）
      discount: { type: 'fixed', amount: 10 }
      autoApplied: false           # 需切换到该卡才生效 → 不计入主价，仅提示
      quota:                       # ★排他/额度
        dailyLimit: 1              # 每日限 1 次
        monthlyLimit: 4
        totalQuota: null           # null = 不限总量；有数值则抢完即止
        lastUsedAt: '2026-10-14T12:30:00+08:00'
      exclusiveGroup: 'meituan-pay-activity'  # 仅"同平台内、同支付方式"的满减互斥
      crossPlatformExclusive: false           # ★默认 false：同一张卡跨平台不互斥；仅显式 true 才跨平台互斥
    - id: meituan-shenquan
      kind: membership
      name: '美团神券 满30减5'
      condition: { minSpend: 30 }
      discount: { type: 'fixed', amount: 5 }
      autoApplied: true            # 结算页默认已抵扣
      quota: { dailyLimit: null, monthlyLimit: null, totalQuota: null, lastUsedAt: null }
```

> **注意**：`autoApplied: true` 表示"结算页默认已抵扣"，对应运行时的 `alreadyIncludedInPayable: true`（计算 `effectivePrice` 时**不再重复扣**，见 §5.3）；`autoApplied: false` 表示需手动切卡/领券，运行时才可能成为"可再省"，但**必须实时验证为 `verified`** 才计入 `effectivePrice`，否则仅是参考提示。

### 5.2 用户级策略（跨平台通用）

```yaml
user:
  city: 上海
  location: { lat: 31.23, lng: 121.47 }   # 用于选门店/配送范围
  cards:
    - issuer: 招商银行
      product: 掌上生活经典白
      exclusiveGroup: 'cmb-own-activity'   # 仅同一张卡在本卡自有活动内互斥，不跨卡、不默认跨平台
  memberships:
    - { platform: meituan, name: 美团会员 }
```

### 5.3 ★两个价：`payable`（结算页实付）与 `effectivePrice`（综合到手价）

**先说清楚一个口径冲突**：`payable` 是**结算页实付**，它**已包含** App 自动生效的红包/满减/自动会员券；但它**通常不包含"切到某张信用卡才享"的立减**（那属于支付环节，需手动选卡）。所以：
- 若把信用卡立减再叠加到 `payable` 上，会**重复计算**（如果结算页其实已抵扣）或**少算**（如果需手动切卡）；
- 若只说"比结算页实付"，又会**漏掉**用户真正关心的"我那张卡还能再减"。

因此**定义两个口径，分开报告，绝不混算**：

| 口径 | 定义 | 用途 | 是否含推测 |
|---|---|---|---|
| **`payable`** | 结算页"实付"原值（App 自动优惠已含，**不再叠加任何东西**） | 客观基准、审计、复核 | 否（纯事实） |
| **`effectivePrice`** | `payable` **减去"确定可用"的优惠**（仅 `availability='verified'` 且 `sourceOfTruth='settle_screenshot'`，且**尚未体现在 payable 内**的项） | 你实际最可能支付的钱 | 否（只扣已实证的） |

**防重复计算的关键**：每条优惠必须带 **`alreadyIncludedInPayable: boolean`**——
- 若该优惠**已经体现在结算页实付里**（App 自动抵扣），则 `alreadyIncludedInPayable=true`，`effectivePrice` **不再减它**（否则重复扣）；
- 若需**手动切卡/领券**才生效、且结算页未含，则 `alreadyIncludedInPayable=false`，仅当被实时验证为可用后才进 `effectivePrice`。
- 每条优惠另带 `refundedBy?: string`（若同一笔优惠被拆成多条展示，指向主优惠，避免重复计数）。

**为什么不全算信用卡**：`presumed`/`unknown` 的信用卡优惠**不计入 `effectivePrice`**，只在结果里作为"参考提示：若切卡可再省 ¥X（未验证）"单列。这样既避免"享受不到的虚低价"，也避免重复计算。

**引擎折算顺序**：① 定 `payable`（纯事实）→ ② 逐条判定优惠四态与 `alreadyIncludedInPayable` → ③ 只把 `verified && !alreadyIncludedInPayable` 的项从 `payable` 扣除得到 `effectivePrice` → ④ 输出两价 + 每条优惠的可用性/来源/是否已含。

### 5.4 ★优惠可用性状态机（四态）与记账可信度

**核心原则：本地记账只是"参考"，不能把"推测"当"实时事实"。** 系统无法直接观测平台是否已耗尽总额度、其他设备/家人是否已用掉名额，因此必须把"状态"和"置信来源"分开建模：

| 状态 | 含义 | 是否计入主价 | 典型来源 |
|---|---|---|---|
| `verified` | **已验证可用**：本次结算页/平台**实时明确展示**该优惠已选中/已抵扣，且结算时点额度有效 | 是（若手动类则列为确定可省） | 结算页实证（控件树/OCR） |
| `presumed` | **推测可用**：仅凭本地配置/历史记账推断"应该能用"，本次**未实时确认** | 否，仅"参考"提示（标注"推测"） | 本地 `state.json` 记账 |
| `known_unavailable` | **已知不可用**：有明确原因 | 否 | 今日已用/额度耗尽/非活动日/未达门槛/显式互斥 |
| `unknown` | **未知**：信息不足（如总额度剩余不可观测） | 否，不展示为"可省" | 无可靠数据 |

- 每条优惠落库时附 `sourceOfTruth: 'settle_screenshot' | 'local_ledger' | 'platform_config' | 'none'`，让结论可追溯。
- **只有 `sourceOfTruth='settle_screenshot'` 的实时实证才能升为 `verified`**；其它一律最多 `presumed`。

### 5.5 ★额度规则的可推导性（不要假精确）

**问题**：`dailyLimit / monthlyLimit / totalQuota / lastUsedAt` 这些字段**并不能可靠推导"此刻能否享受"**——总额度是否抢完、家人/其他设备是否用掉、平台规则是否按"订单/账户/设备"计次，本地都不可知。若用这些字段硬算，会产出**看似精确、实则错误**的"可省金额"。

**分级原则：只在证据强度足够时才断言"不可用/可用"，否则一律 `unknown`。**

| 规则类型 | 能否本地可靠推导 | 处理 |
|---|---|---|
| 活动时间窗/星期/门槛（`condition`） | 能（纯时间/金额判断） | 满足则保留候选，不满足置 `known_unavailable` |
| `exclusiveGroup` 内**确定性互斥**（同单只能用一张券/一档满减） | 能（同笔订单内） | 结算页只会选一个，按结算页实际为准 |
| `lastUsedAt` + `dailyLimit`（**仅当**用户确认真实"已用"） | 半可靠 | 只能降级为 `known_unavailable`（我确实用过）；**不能**用它推断"别人没用过→我还能用" |
| `totalQuota`（抢完即止）剩余量 | **不能** | 一律 `unknown`，不得据"我还剩几次"虚构可用 |
| 跨平台/跨账户共享额度 | **不能** | 默认不互斥（见 §5.5 末），不作扣减 |

> 结论：**额度规则只用于"排除明确已知不可用"，绝不用于"断言可用"。** 任何靠额度推导出的"可省"都只能是 `presumed`（参考），不得进入 `effectivePrice`。

### 5.6 额度记账（本地参考，非实时事实）

- 每次**确认使用**某策略后，`lastUsedAt` 写入 storageDomain 的 `ledger` 表（**记账键 `platform + strategyId`**，同一策略跨平台是不同账目）；仅记录**用户明确确认"已用"**的事实，不自动记录。
- **记账的定位**：仅用于把该策略从"可用"降级为 `known_unavailable`（如"今日已用"）或提示 `presumed`，**不能反向把策略提升为 `verified`**，也不能据"未记录使用"反推"仍可用"。
- **`exclusiveGroup` 谨慎互斥**：仅对**配置显式声明互斥**的活动生效（如"同一平台同一支付满减只享一次"）。**"同一张银行卡在两个平台"默认视为不互斥**（多数卡返现按笔/按月计，两平台可分别享），除非活动配置显式写 `crossPlatformExclusive: true`。绝不因"招行在美团用过"就武断判定饿了么侧不可用。
- 记账不影响 `payable`（客观主价），只影响"可再省"的展示与提示。

---

## 6. 数据模型（本轮深化：多规格 + 同名店 + 置信度 + zod 校验）

### 6.1 问题：同名店/相似商品误判

"香叶烤鸭饭"在不同平台可能叫"香叶·精品烤鸭饭""香叶烤鸭饭（送可乐）"，同一区域还可能有**两家"香叶"分店**。若只按字符串相等，必然串店/串品。因此：

- 门店加**唯一标识**（平台门店 ID / 高德 POI ID），并保留**距离/评分**辅助判断；
- 商品加**规格**与**匹配置信度**（LLM/规则打分 0–1）；
- 置信度低于阈值（如 0.6）→ 该 Quote 标记 `needsConfirm: true`，并在结果里提示"这条可能不是同一家店/同一商品，请核对"。

### 6.2 接口定义（据此实现）

> ⚠️ 以下为**接口草案，仅供评审与对齐口径，非可直接运行的成品代码**；实现时会按 DSH `defineTool` zod 约定落地。

```ts
// 一次比价 = 对 N 个平台各生成一个 Quote

// ① 费用项：不再用 goods/delivery/packing/other 四字段硬编码，而是"结构化明细 + 来源"
interface FeeLine {
  kind:
    | 'goods'            // 商品价
    | 'delivery'         // 配送费
    | 'packing'          // 打包费
    | 'service'          // 配送/平台服务费
    | 'small_order'      // 起送/小单加价
    | 'tip'              // 骑手打赏（若有）
    | 'other';
  label: string;          // 结算页原文标签，如"配送费""包装费""配送服务费"
  amount: number;
  source: 'tree' | 'ocr' | 'derived'; // 该项金额怎么来的（derived=推算，可信度低）
}

// ② 优惠项：区分作用范围（商品级/订单级/运费级），并标注来源与是否可分摊
interface Discount {
  kind: 'coupon' | 'membership' | 'credit_card' | 'promo' | 'delivery_waiver';
  platform: string;             // ★所属平台
  id: string;                   // 对应 strategies[].id
  name: string;
  amount: number;
  scope: 'item' | 'order' | 'delivery'; // ★作用范围：商品级/整单/运费
  source: 'tree' | 'ocr';
  autoApplied: boolean;
  // ★ 防重复计算：
  alreadyIncludedInPayable: boolean; // true=已含在结算页实付里，effectivePrice 不再减它
  refundedBy?: string;              // 若同一优惠被拆成多条展示，指向主优惠 id，避免重复计数
}

// ③ 报价主对象
interface Quote {
  platform: 'meituan' | 'eleme' | string;

  store: {
    name: string;
    amapId?: string;             // 高德 POI 唯一标识（跨平台对齐主力）
    platformShopId?: string;     // 平台内门店 ID（防串店）
    distanceM?: number;
    rating?: number;
    matchedScore: number;        // 0–1
  };

  item: {
    name: string;                // 平台原始菜名，如"香叶·精品烤鸭饭"
    spec?: string;               // 规格：大份/微辣…
    qty: number;
    matchedScore: number;        // 0–1
    composition?: string[];      // ★套餐组成：如 ["烤鸭饭","可乐"]，用于判定"是否同一顿饭"
    listPrice?: number;          // ★搜索/列表页展示价，仅留痕解释价差，**不参与比价**
  };

  fees: FeeLine[];               // ★完整费用明细（可含多项，带来源）
  discounts: Discount[];         // 自动生效的抵扣（带 scope/source/alreadyIncludedInPayable）
  payable: number;               // 结算页"实付"（纯事实，已含自动优惠，不再叠加）
  effectivePrice?: number;       // ★综合到手价 = payable − "verified 且未含在 payable 内"的优惠（见 §5.3）

  // ★ 两套独立的可信度，不再混为一谈：
  arithmetic: {                  // 算术自洽性（账目平不平）
    balanced: boolean;
    expected: number;            // 由明细推算的应付
    delta: number;               // 与 payable 的差额
    tolerance: number;
  };
  extraction: {                  // 识别可信度（读得准不准）
    confidence: 'high' | 'medium' | 'low';
    byField: Record<string, 'tree' | 'ocr'>; // 每个关键金额来自控件树还是 OCR
    ocrConfidences?: Record<string, number>; // OCR 原始置信分（若可得）
  };
  needsConfirm?: boolean;        // 综合（算术不平 或 低识别 或 商品不等价）
  deviatedConditions?: string[]; // ★ 偏离输入快照的条件（非空 → 强制归入不可比组，见 §6.6）
  optionalSavings?: (Discount & {
    availability: 'verified' | 'presumed' | 'known_unavailable' | 'unknown'; // §5.4 四态
    availabilityReason?: string;
    sourceOfTruth: 'settle_screenshot' | 'local_ledger' | 'platform_config' | 'none';
  })[];
  snapshotId?: string;           // ★ 派生来源统一输入快照 id（§6.6，P4）
  snapshotHash?: string;         // ★ 派生来源快照 hash；compare 校验与 query.hash 一致，不一致即不可比

  evidence: Evidence;            // 见 ④
}

// ④ 证据：报价与截图的绑定 + 有效期 + 脱敏 + 清理
interface Evidence {
  quoteId: string;               // ★与报价一一绑定
  platform: string;
  storeName: string;
  itemSpec: string;              // 快照当时的下单条件（门店/商品/规格/数量）
  qty: number;
  feeBreakdown: FeeLine[];       // 快照当时费用明细
  rawExtraction: {               // ★原始识别结果（未经清洗），便于复核
    treeDumpPath?: string;
    ocrText?: string;
    ocrBoxes?: { text: string; confidence: number; bbox: [number,number,number,number] }[];
  };
  checkResult: { arithmetic: Quote['arithmetic']; extraction: Quote['extraction'] };
  screenshotPath?: string;       // 已脱敏的截图
  capturedAt: string;            // ★抓取时间（ISO8601 带时区）
  validUntil: string;            // ★证据/报价有效期（默认 capturedAt + N 分钟）
  redaction: 'none' | 'applied'; // 脱敏标记（默认 applied）
  missingReason?: string;        // 证据缺失时的原因（降级）
}

// ⑤ 比较条件：比价前先把"同一顿饭"钉死（= 统一输入快照，见 §6.6）
interface ComparisonConditions {
  snapshotId: string;            // ★输入快照 id（含规范化后的全部条件 + 哈希）
  item: string;
  qty: number;                   // 固定数量
  spec: string[];                // 固定规格/加料
  composition: string[];         // 固定套餐组成（如 含可乐/不含）
  deliverTo: { city: string; lat: number; lng: number; addressHash?: string }; // 固定配送地址
  expectDeliveryBy?: string;     // 期望送达时间（影响配送费/时效活动）
  fixedAt: string;
  hash: string;                  // ★规范化条件的哈希：所有 Quote 必须由此快照派生，防止各平台条件漂移
}

interface CompareResult {
  taskId: string;
  query: ComparisonConditions;   // ★统一输入快照（所有 Quote 都以此为唯一下单条件）
  groups: {                      // ★按"是否等价"分组，组内可比，组间不混排
    key: string;                 // 如 "烤鸭饭(无饮料)" / "烤鸭饭套餐(含可乐)"
    comparable: boolean;         // 组内商品是否确认为同一顿饭
    quotes: Quote[];
  }[];
  cheapest: Quote | null;        // 仅在 comparable=true 的组内、needsConfirm=false 中取最小；否则 null
  note: string[];                // 说明：为何分组、哪些不可比、有哪些需重新核价
}
```

> **`cheapest` 兜底约定（升级版）**：`cheapest` 只在 **`comparable=true` 的组内**、且 `needsConfirm !== true`、且证据**未过期**（§6.5）的 Quote 中取 `effectivePrice`（缺省回退 `payable`）最小者；同时报告 `payable` 与 `effectivePrice` 两列。若没有可比组、或全组均 `needsConfirm`、或证据全过期 → `cheapest: null`，并在 `note` 说明原因（"无可信结果，请人工核对" / "证据已过期，请重新核价"）。**禁止**跨组混排硬选最低价，也**禁止**把"推测可省"算进 `effectivePrice`。

> **与实现的对应关系**：§6.3.2 的 `QuoteSchema` / `DiscountSchema` / `EvidenceSchema` 与上面 `Quote` / `Discount` / `Evidence` **逐字段 1:1 对齐**（含 `store`、`item.composition`、`arithmetic`、`extraction`、`needsConfirm`、`optionalSavings`、`evidence`）；并额外用 `superRefine` 交叉校验 `arithmetic`/`extraction` 自报字段是否诚实。

### 6.3 ★两层校验：算术自洽 ≠ 金额正确

**关键教训**：`商品价+配送费+打包费+其他−自动优惠 ≈ 实付` 只是"账目自洽"的必要条件，**不是金额正确的充分条件**。真实结算页还可能含**商品级优惠、运费减免、优惠分摊、配送服务费、会员权益、打包阶梯价**等未建模项；更危险的是——**若 OCR 把某个明细和实付同时读错、且错误值恰好满足勾稽，校验仍会通过**。因此必须把两件事**分开评定**：

| 维度 | 回答的问题 | 数据来源 | 与"价格是否正确"的关系 |
|---|---|---|---|
| **算术自洽性**（`arithmetic`） | 各项明细加起来是否等于实付？ | 明细与实付的算术关系 | 只说明"账平"，**不代表金额对** |
| **识别可信度**（`extraction`） | 每个金额读得准不准？ | 控件树 vs OCR、OCR 置信分 | 决定"读得对不对"，才是防误读的主力 |

**结论：勾稽通过不等于价格正确；必须以"识别可信度"为主、算术自洽为辅，且二者都通过才算 `high`。**

#### 6.3.1 判定矩阵（`arithmetic.balanced` × `extraction.confidence`）

| 算术 | 识别 | 结论 | 处理 |
|---|---|---|---|
| 平 | high（全部来自控件树） | **可信** | 计入比价 |
| 平 | medium/low（含 OCR） | **需复核**（账虽平但可能双错） | `needsConfirm: true`，降级展示 |
| 不平 | high | **明细有未建模项或读错** | 先补抓明细/重取；仍不平则 `needsConfirm` |
| 不平 | low | **高风险** | `needsConfirm`，标"疑似误读"，绝不进最低价 |

> 即：**只有当"算术平 + 关键金额来自控件树（tree）"时，才可 `confidence=high`**；OCR 命中的金额最高只能 `medium`，并单独标注。

#### 6.3.2 费用与优惠的完整分类（先建模，再校验）

建模"来源"比建模"金额"更重要：`FeeLine` 带 `source`（`tree`/`ocr`/`derived`），`Discount` 带 `scope`（item/order/delivery）与 `source`（`tree`/`ocr`）；见 §6.2。只有 `source='tree'` 的项视为可靠；`derived`（如"用总额减已知项反推某费")是推算，**不参与"是否平"的强判定**，只做参考。

> ⚠️ 以下为**校验草案**，实现时按实际数据结构落地。本项目用 **zod 4**。**实测（本地 zod 4.6.7）**：`.refine(fn, { error, path })` 用 `error` 生效；但 `superRefine` 里的 `ctx.addIssue({ code:'custom', path, message })` **必须用 `message`**——若误写 `error` 会静默降级为 "Invalid input"。本示例据此分别书写。
>
> **★ 与 §6.2 的 `Quote` 逐字段对齐（1:1）**：`QuoteSchema` 覆盖 `Quote` 的全部字段——`platform` / `store` / `item`（含 `composition`）/ `fees` / `discounts` / `payable` / `arithmetic` / `extraction` / `needsConfirm` / `optionalSavings` / `evidence`；`DiscountSchema` 覆盖 `Discount` 的 `kind/id/name/platform/amount/scope/source/autoApplied`。**注意**：`arithmetic` / `extraction` 是"由抽取层填写的自报字段"，因此额外用 `superRefine` 按 `fees/discounts/payable` **交叉校验它们是否诚实**（防止把 `balanced` 错标或 `expected` 算错）。

```ts
import { z } from 'zod';

const money = z.number().finite().nonnegative().max(10000);
const FeeKind = z.enum(['goods','delivery','packing','service','small_order','tip','other']);
const DiscountKind = z.enum(['coupon','membership','credit_card','promo','delivery_waiver']);
const FeeSource = z.enum(['tree','ocr','derived']);
const DiscountSource = z.enum(['tree','ocr']);
const Scope = z.enum(['item','order','delivery']);
const Confidence = z.enum(['high','medium','low']);
const Availability = z.enum(['verified','presumed','known_unavailable','unknown']);
const SourceOfTruth = z.enum(['settle_screenshot','local_ledger','platform_config','none']);

// 勾稽容差按平台配置化；默认 min(1.0 元, 5%)。容差只用于"算术自洽"判定。
const toleranceFor = (platform: string): number =>
  ({ meituan: 1.0, eleme: 1.0 } as Record<string, number>)[platform] ?? 1.0;

// —— 与 §6.2 FeeLine / Discount / Evidence 等一一对应 ——
const FeeLineSchema = z.object({
  kind: FeeKind, label: z.string(), amount: money, source: FeeSource,
});

const DiscountSchema = z.object({
  kind: DiscountKind, platform: z.string(), id: z.string(), name: z.string(),
  amount: z.number().nonnegative(), scope: Scope, source: DiscountSource, autoApplied: z.boolean(),
  alreadyIncludedInPayable: z.boolean(),   // ★ 防重复计算
  refundedBy: z.string().optional(),       // ★ 指向主优惠 id，避免拆分条重复计数
});

const OptionalSavingSchema = DiscountSchema.extend({
  availability: Availability, availabilityReason: z.string().optional(), sourceOfTruth: SourceOfTruth,
});

const ArithmeticSchema = z.object({
  balanced: z.boolean(), expected: money, delta: z.number(), tolerance: z.number().nonnegative(),
});

const ExtractionSchema = z.object({
  confidence: Confidence,
  byField: z.record(z.string(), z.enum(['tree','ocr'])),
  ocrConfidences: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

const EvidenceSchema = z.object({
  quoteId: z.string(), platform: z.string(), storeName: z.string(), itemSpec: z.string(),
  qty: z.number().int().positive(), feeBreakdown: z.array(FeeLineSchema),
  rawExtraction: z.object({
    treeDumpPath: z.string().optional(),
    ocrText: z.string().optional(),
    ocrBoxes: z.array(z.object({
      text: z.string(), confidence: z.number().min(0).max(1),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })).optional(),
  }),
  checkResult: z.object({ arithmetic: ArithmeticSchema, extraction: ExtractionSchema }),
  screenshotPath: z.string().optional(), capturedAt: z.string(), validUntil: z.string(),
  redaction: z.enum(['none','applied']), missingReason: z.string().optional(),
});

// —— QuoteSchema：字段与 §6.2 Quote 完全一致 ——
const QuoteSchema = z.object({
  platform: z.string(),
  store: z.object({
    name: z.string(), amapId: z.string().optional(), platformShopId: z.string().optional(),
    distanceM: z.number().nonnegative().optional(), rating: z.number().optional(),
    matchedScore: z.number().min(0).max(1),
  }),
  item: z.object({
    name: z.string(), spec: z.string().optional(),
    qty: z.number().int().positive().default(1),
    matchedScore: z.number().min(0).max(1).default(1),
    composition: z.array(z.string()).optional(),   // ★ 套餐组成（用于"同一顿饭"等价判定）
    listPrice: money.optional(),                   // ★ 列表页价留痕（不参与比价）
  }),
  fees: z.array(FeeLineSchema).min(1),
  discounts: z.array(DiscountSchema).default([]),
  payable: money,
  effectivePrice: money.optional(),                // ★ payable − verified&!alreadyIncluded 的优惠
  deviatedConditions: z.array(z.string()).optional(), // ★ 偏离输入快照的条件（非空则必归入不可比组）
  arithmetic: ArithmeticSchema,                    // ★ 算术自洽（自报，下面交叉校验）
  extraction: ExtractionSchema,                    // ★ 识别可信度（自报）
  needsConfirm: z.boolean().optional(),
  optionalSavings: z.array(OptionalSavingSchema).optional(),
  evidence: EvidenceSchema,                        // ★ 必填：报价必须绑定证据
}).superRefine((q, ctx) => {
  // 交叉校验：自报的 arithmetic 必须与 fees/discounts/payable 重算一致
  const gross = q.fees.filter(f => f.source !== 'derived').reduce((s, f) => s + f.amount, 0);
  const autoDisc = q.discounts.filter(d => d.autoApplied).reduce((s, d) => s + d.amount, 0);
  const expected = gross - autoDisc;
  const delta = expected - q.payable;
  const tol = Math.min(toleranceFor(q.platform), expected * 0.05);
  if (Math.abs(q.arithmetic.expected - expected) > 0.01)
    ctx.addIssue({ code: 'custom', path: ['arithmetic','expected'], message: 'arithmetic.expected 与明细重算不一致' });
  if (q.arithmetic.balanced !== (Math.abs(delta) <= tol))
    ctx.addIssue({ code: 'custom', path: ['arithmetic','balanced'], message: 'balanced 标记与重算结果不一致' });
  // ★ 防重复计算：effectivePrice 只能减"verified 且未含在 payable 内"的优惠
  if (q.effectivePrice !== undefined) {
    const legit = (q.optionalSavings ?? []).filter(s => s.availability === 'verified' && !s.alreadyIncludedInPayable)
      .reduce((sum, s) => sum + s.amount, 0);
    const want = +(q.payable - legit).toFixed(2);
    if (Math.abs(want - q.effectivePrice) > 0.01)
      ctx.addIssue({ code: 'custom', path: ['effectivePrice'], message: `effectivePrice 应=${want}（只扣已验证且未含的优惠），实际=${q.effectivePrice}` });
  }
});

// —— 独立的"识别可信度"判定（与算术解耦）：任一关键金额来自 OCR 则最高 medium ——
const extractConfidence = (q: z.infer<typeof QuoteSchema>): 'high' | 'medium' | 'low' => {
  const allTree = q.fees.every(f => f.source === 'tree') && q.discounts.every(d => d.source === 'tree');
  return allTree ? 'high' : 'medium'; // OCR 命中：即使算术平也只到 medium，需人工复核
};

// 量级校验也独立做（单份均价异常，疑似小数点误读）
const SanitySchema = QuoteSchema.refine(
  (q) => q.payable / Math.max(1, q.item.qty) <= 500,
  { error: '单份均价异常（>500元），疑似小数点误读', path: ['payable'] },
);
```

> 实测（本地 zod 4.6.7）：省略 `qty`/`matchedScore` 会按默认值补齐；缺 `store`/`evidence` 会被拒；`arithmetic.balanced` 或 `arithmetic.expected` 与重算不符会被 `superRefine` 精确指到字段报错——即"自报字段不可撒谎"。

#### 6.3.3 处理策略（分级）

1. **算术不平** → 先补抓缺失费用项（商品级/运费级优惠常被漏读），再重取；仍不平 → `needsConfirm: true`。
2. **算术平但含 OCR** → 也 `needsConfirm: true`（防"双错平账"），标"OCR 识别，建议核对截图"。
3. **只有"算术平 + 全 tree"** 才 `confidence: 'high'`，可直接进比价。
4. **绝不**把任一 `needsConfirm=true` 的价当"最低价"推荐；附 `evidence`（原始 dump/OCR 文本 + 截图）供复核。

#### 6.3.4 ★OCR 质量评估（先评，再校验；不是靠 zod 兜底）

**关键区分：zod 勾稽是"算术护栏"，不是"识别质量评估"。** 一段把 `28.9` 读成 `28.09` 的 OCR 可能完全满足勾稽，zod 抓不到。因此 OCR 路径必须**先做识别质量评估**，`extraction.confidence` 由评估结果决定，而不是由"算术平"反推。

**四步质量门（OCR 专用）**：
1. **逐字段置信分**：`ocrConfidences[field]`（如 `payable: 0.62`）；低于阈值（默认 `payable/relevant ≥ 0.8`）→ 直接判 `low`。
2. **关键数字二次比对**：对 `payable` 与各明细金额做**第二次识别**（不同预处理/不同 ROI/不同模型），两次结果**一致**才认可；不一致 → `low` 并 `needsConfirm`。
3. **截图 ROI 对照**：把识别出的数字映射回截图区域，人工或模板确认"框里确实是这个数"（尤其小数点位置）；对 `¥28.9 / ¥289` 这类量级敏感数，**必须**做小数点核验。
4. **合理性先验**：单份均价区间、费用项是否缺失（缺 delivery/packing 常见）、金额与总额量级是否同级——任一异常先降级，再进 zod。

> 结论：`extraction.confidence` 的来源是**上述质量门**；zod 只做最后算术一致性检查。**OCR 一律不能单独产出 `high`**（最高 `medium`，且需二次比对一致）。

### 6.4 相似度与"同一顿饭"等价判定

- `similarity.ts` 统一打分：门店（`amapId` 精确 = 1.0；名称归一化 + 距离 < 200m 加权）与商品（去括号/别名/规格后 token 集合相似度 + 主体词命中）。
- 打分可由规则给出，也可让 LLM 对候选打 0–1 分（LLM 更擅长判断"香叶·精品烤鸭饭"是否等于"香叶烤鸭饭"）。
- **但相似度 ≠ 等价**：一份"烤鸭饭"与一份"烤鸭饭+可乐套餐"可能名称相似却**不可直接比价**。因此除相似度外，必须比对**比较条件**（数量/规格/加料/套餐组成/配送地址/期望送达时间，见 §6.2 `ComparisonConditions`）。
- **判定规则**：`store.matchedScore ≥ 0.7 && item.matchedScore ≥ 0.7 && composition 等价 && 数量/规格/地址一致` → 视为**同一顿饭**（`comparable=true`）；任一不满足 → **分组展示**（`groups[].comparable=false`），不与其他组混排。

### 6.5 证据规范（有效期 / 绑定 / 脱敏 / 清理 / 缺失降级）

- **绑定**：每条 `Quote` 附一个 `Evidence`（§6.2 ④），含 `quoteId`、抓取时间 `capturedAt`、平台/门店/商品规格/数量、`feeBreakdown`、**原始识别结果**（`treeDumpPath` / `ocrText` / `ocrBoxes`）、`checkResult`（算术+识别两套结果）、脱敏截图的 `screenshotPath`。
- **有效期**：`validUntil = capturedAt + N 分钟`（默认 10 分钟，可配 `evidence.ttlMinutes`）。**报价在用户查看或准备下单前若已过期 → 必须提示"报价已过期，请重新核价"，不得把旧价当现价**；`cheapest` 计算排除过期证据（见 §6.2 兜底约定）。
- **脱敏**：截图默认 `redaction: 'applied'`——隐去手机号、地址门牌、支付信息、骑手姓名等；仅本地存储，不上传。
- **清理**：`./.price-agent/evidence/` 按 TTL + 保留上限清理（如保留最近 50 条或 7 天，取先到者）；清理后 `Evidence` 只留元数据与 `missingReason`。
- **缺失时降级**：无截图/无 dump 时**不能**仍报 `high`——降为 `needsConfirm` 并在 `missingReason` 说明（如"截图保存失败""OCR 未产出"），提示人工复核。

### 6.6 ★统一输入快照（Input Snapshot）

**问题**：若各平台各自解释"香叶烤鸭饭、1 份、微辣、送到公司、半小时内"，就会出现"美团按 1 份/微辣、饿了么按 2 份/加辣"这类**条件漂移**，比价结果不可信。

**做法**：先创建**唯一输入快照**，再让所有平台都从这份快照派生，不允许中途改条件。

- **快照内容**：`snapshotId` + 规范化后的 `item / qty / spec / 加料 / composition / deliverTo(城市+经纬度) / expectDeliveryBy`，并计算 `hash`。
- **规范化**：地区/地址做地理编码后存 `lat/lng`（同时存 `addressHash` 供复核），规格/加料做别名归一（"大份/加大/大"统一），确保各平台拿到同一语义。
- **派生约束**：每个 `Quote` 记录它来自哪个 `snapshotId + hash`；**若某平台无法严格满足快照条件（找不到同规、只能近似）→ 该 Quote 标 `deviatedConditions: string[]`，并强制归入"不可比组"**，不得与严格满足快照的 Quote 混排。
- 快照**只读**：任务一旦开始，条件锁定；用户想改条件 = 新建快照/新任务（`idempotencyKey` 也随之变化）。

---

## 7. ★异步任务架构（本轮重写：规避 DSH Tool 超时）

**问题**：驱动两个 App 完成"打开→搜索→进结算页"通常要 **15–30 秒**，而 DSH Tool 有硬超时（`defineTool` 支持 `timeoutMs`，但把它设到 90s 会长时间占住 Agent 一步，体验差且易被上层限流）。

**方案**：改为**异步任务流**，复用 DSH 内置的后台任务能力（`dsh-base` 已自带 `ctx.jobs` = `dsh-jobs-local`，以及 `dsh-tool-jobs` 的 `job_output/job_list/job_kill` 与完成通知）。

### 7.1 调用时序

```
AI ──price_agent(item)──▶ 插件
                           │ 1. ctx.jobs.start({ kind:'price-compare', label:'比价: 香叶烤鸭饭' })
                           │    → 得到 job 的 taskId（如 price-compare-1a2b…）
                           │ 2. 立即 return { taskId, status:'processing' }
                           ▼
AI 立即拿到 taskId ──▶ 结束本步（前端显示"正在比价…"）

后台 job 持续运行：
   updateProgress('正在打开美团…')
   updateProgress('美团抓取成功，切换到饿了么…')
   updateProgress('饿了么抓取成功，正在折算…')
   → 完成时 job 结果 = CompareResult

前端 UI：复用 dsh-client-ui-jobs 的后台任务面板，实时看到进度行；
         job 完成后 chat 收到完成通知，AI 读取结果并以表格呈现。
```

### 7.2 与 DSH 的对接点（已核实）

- `ctx.jobs.start(spec)` 返回 `JobId`，我们**统一把它当作 `taskId` 对外暴露**（全文档只用 `taskId` 这一个名字，不再混用 jobId）；`JobHandle.updateProgress(line)` 会把进度行写进**每个 projection**（模型与 UI 都能看到）——见 `dsh-jobs` 类型 `types.d.ts`。
- `dsh-client-ui-jobs` 提供"会话头部后台任务列表 + 按需流式记录面板"，**无需自研 websocket 通道**即获得进度 UI。
- 完成时 `dsh-tool-jobs` 会给发起它的 Agent 注入会话内通知（busy 时下一步注入，idle 时唤醒），AI 用 `job_output(taskId)` 取最终 `CompareResult`。
- 需要中断（如遇验证码/你想取消）→ AI 或 UI 调 `job_kill(taskId)`。

### 7.3 进度协议（状态机）

`status: 'queued' → 'processing'(平台级子状态) → 'completed' | 'failed' | 'cancelled' | 'expired'`

进度行建议格式（便于 UI 解析与人类阅读）：

```
[1/2] 美团 · 打开 App … OK
[1/2] 美团 · 搜索"香叶 烤鸭饭" … OK
[1/2] 美团 · 进入结算页 … OK · 实付 ¥23.5（tree 读取，算术平，high）
[2/2] 饿了么 · 打开 App … 遇到定位授权，已允许 … OK
[2/2] 饿了么 · 进入结算页 … 实付 ¥25.6（含 OCR，算术平但仅 medium，已标 needsConfirm）
完成：同组可比时美团更低，便宜 ¥2.1
```

### 7.4 工具返回（异步契约）

```ts
// price_agent 立即返回（不阻塞）
{ taskId: string, status: 'processing', message: '已开始比价，完成后自动推送结果' }
// 后台 job 完成后，job_output(taskId) 返回：
{ taskId, status: 'completed', result: CompareResult }
```

### 7.5 ★完整生命周期：持久化 / 幂等 / 取消 / 结果重取 / 通知解耦

前面的时序只覆盖"顺利跑完"。真实环境必须覆盖**异常退出、用户取消、DSH 重启、重复调用、结果过期、通知丢失**。约定如下：

**(1) 状态持久化（durable）**
- 每个任务落一份**任务记录**（`status / phase / progress[最后 N 行] / resultPath / error / createdAt / startedAt / finishedAt / owner`），**存在 `ctx.storageDomain` 的 `tasks` 表**（**不**自写 JSON 文件；由 `dsh-storage-json` 落盘、schema 校验、写落盘后才 resolve）。与 DSH 内置 job 解耦（`dsh-jobs-local` 的 job 随进程消失，故以 storageDomain 为事实源）。
- **任务完成状态以这份持久记录为准**，与"是否给 AI 发了完成通知"分离（见 (5)）。

**(2) 幂等与"绝不重复执行"（防双跑导致多扣/多抓）**
- **幂等键**：见 §7.6 的正式定义（`sha256(snapshot.hash ‖ 平台集 ‖ 选项)`，**键内不含时间窗**）。同一 key 重复调用**返回既有 `taskId`**，不重复起真机流程；幂等的完整语义/冲突/保留期在 §7.6 规范。
- **单飞锁（single-flight）**：以 `snapshot.hash` 为键加锁——即使两个请求绕过幂等键，也只有一个能真正执行，另一个等待并复用同一 `taskId`；**锁层次与实现见 §7.7**。
- **真机互斥**：同一台设备**同时只允许一个自动化任务**（adb 串行队列），避免两个任务抢手机导致双跑/误点（即 §7.7 的**设备锁**）。
- **执行令牌**：任务记录里带 `runToken`；写结果时校验 `runToken` 与当前活跃运行一致，**过期运行的迟到写入被丢弃**（防止"已取消/已超时任务的旧结果覆盖新结果"）。

**(3) 时间预算与超时终止**
- `taskTimeoutMs` 到点 → 主动终止真机操作（adb 子进程 kill）→ 置 `status='failed'`、`reason='timeout'`，保留已抓到的部分证据。
- 每个阶段（打开/搜索/结算）独立超时，超时即 fast-fail，不拖垮整个任务。

**(4) 取消确认（cancel acknowledgment）**
- `job_kill` / 取消请求 → 置 `cancelling` → 等真机子进程真正退出 → 置 `cancelled`；**只有确认进程已退出才算取消成功**，避免"以为取消了其实还在点手机"。

**(5) 完成状态与通知送达分离（避免"成功但 AI 取不到"）**
- 任务完成时**先写 storageDomain 记录 + 结果**，再发通知。**通知丢失/DSH 重启后**，AI 或用户仍可凭 `taskId` 通过 `price_agent.getResult(taskId)` / `job_output(taskId)` **重取结果**（幂等只读，可重复调用任意次）。
- 提供 `price_agent.listTasks()` 列出未消费的已完成任务，便于"补取"。
- **结果写入原子性**：结果用 **`dsh-atomic-write` 的 `writeFileAtomic`**（随机后缀 temp + `rename` 原子提交）落盘，**不自写 tmp→rename**；附 `checksum`，重取时校验 `checksum` 与 `runToken`，损坏/不匹配则报"结果不可用"，绝不返回半截 JSON。
- **通知只是优化，不是事实来源**：完成事实以 storageDomain 记录 + 原子结果为准；即便通知从未送达，任务也不算"丢失"。

**(6) DSH 重启恢复**
- 启动时读取 storageDomain `tasks` 表：`processing` 但无对应活进程的记录 → 标 `failed(reason='interrupted')` 并清理残留 adb 会话；`completed` 但未消费 → 保留供重取。

**(7) 结果过期**
- 结果带 `validUntil`（与证据 TTL 一致）。重取时若已过期 → 返回 `status='expired'` 并提示"结果已过期，请重新核价"，**不返回旧价当现价**。

> **好处**：Agent 不会被长任务卡死；进度可感知；即便崩溃/重启/通知丢失，结果也能凭 `taskId` 幂等重取，不会出现"任务成功了但 AI 永远拿不到结果"的悬空态。

### 7.6 ★幂等规范（Normative）

前面只在 §7.5(2) 提了"幂等键"，但**幂等的完整语义、键如何算、哪些操作必须幂等、冲突如何返回、结果保留多久**此前没有明文。此处给出强制规范：

**R1 幂等键定义（确定、可复现）**
- `idempotencyKey` 显式传入时以传入值为准（调用方负责唯一）；缺省则系统计算：
  `key = sha256( snapshot.hash ‖ platformSet(排序) ‖ taskOptionsHash )`。
  **注意：key 中刻意不含"时间窗"**——时间窗只决定"键的有效期/清理"，不能混进键值，否则同一请求跨秒就会得到不同键从而不幂等。
- `snapshot.hash` 来自 §6.6 的规范化输入；`taskOptionsHash` 覆盖影响结果的选项（如 `maxResults`、是否含 OCR、平台集合）。

**R2 幂等的操作范围（必须幂等 / 必须不幂等）**
| 操作 | 幂等性要求 | 说明 |
|---|---|---|
| `price_agent.start()`（触发比价） | **必须幂等** | 同 key 重复调用返回同一 `taskId`，不重复执行真机 |
| `price_agent.getResult(taskId)` | **必须幂等（纯只读）** | 可任意次调用，不改变状态、不消耗结果 |
| `price_agent.listTasks()` | 纯只读 | — |
| `price_agent.cancel(taskId)` | **幂等** | 已取消再取消返回同一终态，不报错 |
| 真机侧"下单/支付" | **禁止存在** | 红线（§3.4），因此无对应幂等实现 |

**R3 幂等的实现语义（同 key 必返回同一结果）**
- **首次**：无同 key 记录 → 创建任务并立即写入"键→taskId"映射（先落盘再执行）。
- **重复（任务运行中）**：返回既有 `taskId` + 当前 `status`（`processing`），**不新建**。
- **重复（任务已完成）**：返回既有 `taskId` + `status='completed'`；结果仍受 `validUntil` 约束（过期则 `expired`，但**不重跑**）。
- **重复（任务失败/取消）**：返回既有终态；是否允许"同 key 重试"由显式 `force=true` 决定（默认复用，不重跑）。
- **冲突**：同 `idempotencyKey` 但 `snapshot.hash` 不同（同键不同请求）→ 返回 `409 IDEMPOTENCY_KEY_REUSED`，**不执行**。

**R4 结果保留与键清理**
- 幂等映射与结果保留 `idempotencyTtl`（默认 30 分钟，可配）；到期后同 key 视为新请求（这是"重复调用"与"重新核价"的分界）。
- 清理与证据 TTL 独立（结果可先于证据过期，但 `getResult` 会提示 `expired` 而非 `null`）。

**R5 边界情况**
- 并发同 key：由 §7.7 的单飞锁收口，**只可能产生 1 个任务**。
- 崩溃恢复：重启后若"键→taskId"已存在但任务记录为 `processing` 且无活进程 → 置 `failed(interrupted)`，同 key 重调默认复用该失败态（需 `force=true` 才重跑）。

### 7.7 ★并发控制规范（Normative）

系统是**单机、单手机、单进程（可能多会话）**环境，天然串行；但仍需明确锁层次与竞态处理，避免双跑/误点/文件互相覆盖。

**R1 锁的层次（由粗到细，固定获取顺序，防死锁）**
1. **设备锁（device lock）**：**全局唯一**，粒度=一台设备（`serial`）。同一时刻只允许 1 个任务操作手机；其余**排队**（FIFO）。这是最外层锁。**实现**：`dsh-atomic-write` 的 `withWriterLock` 对 `device-<serial>.lock` 加锁（跨进程有效）。
2. **快照锁（snapshot lock / single-flight）**：键=`snapshot.hash`。同输入的并发请求合并为 1 个任务，其余等待并复用；同样用 `withWriterLock('snapshot-<hash>.lock')`。
3. **资源写锁（file lock）**：`state.json`（记账）、结果文件等写时用**文件锁 + `writeFileAtomic`**（原子替换）——**全部复用 `dsh-atomic-write`**，不自写 `O_EXCL`/tmp-rename/PID 接管（该库已内置：wx `.lock`、记录 PID、`ESRCH` 自动接管）。
- **固定顺序：设备锁 → 快照锁 → 资源写锁**，任何路径不得反向获取。

**R2 串行队列语义**
- adb 命令**串行执行**（单设备队列），禁止在同一设备上并行点按；跨设备（未来多机）方可并行。
- 排队任务需给"预计等待"进度提示（`updateProgress('排队中：前面还有 N 个任务…')`），避免用户以为卡死。

**R3 竞态清单与对策**
| 竞态 | 后果 | 对策 |
|---|---|---|
| 两请求同输入同时到达 | 双跑、双扣/双抓 | 设备锁 + 快照单飞（§7.7 R1） |
| 任务超时/取消后旧运行仍在写结果 | 旧结果覆盖新结果 | `runToken` 校验，迟到写入丢弃（§7.5(2)） |
| 两进程同时写记账 | 记账丢失/损坏 | `withWriterLock` + `writeFileAtomic`（dsh-atomic-write） |
| 幂等映射写入与执行并发 | 键已写但未执行 / 执行了键没写 | **先写键再执行**；崩溃由重启恢复收口（§7.6 R5） |
| DSH 多会话同时触发 | 抢手机 | 设备锁跨会话生效（文件锁实现，非进程内内存锁） |

**R4 锁的实现与失效**
- 锁复用 `dsh-atomic-write` 的跨进程 writer lock（wx `<file>.lock`、记录 holder PID、holder 不存在时 `ESRCH` 自动接管）；**心跳/接管语义直接继承该库**，不自写 30s 心跳。
- 锁获取超时/失败：返回 `503 BUSY`（可重试）而非静默失败；前端提示"当前有任务在占用手机，已排队"。

**R5 前端并发**
- 同一 `taskId` 的进度订阅可多个（只读）相互独立；进度写只由任务执行体单点写入（`JobHandle.updateProgress`），避免多写者。

> 验收：P1 DoD 增补"同 key 并发 10 次只产生 1 任务""设备锁下两任务串行、不交叉点按""记账并发写不损坏""锁接管不双跑"（§9）。

---

## 8. 运行环境与前置条件（WSL2 特别注意）

> 版本与环境基线见 **§4.1**（本节只讲 WSL2 特有的连接/存储细节，不重复技术栈）。

当前宿主是 **WSL2（Ubuntu 26.04）**。以下版本号已在本机 WSL 内实际执行命令核实（2026-10-21）：

| 项 | 实测值 | 核对命令 |
|---|---|---|
| Node | **v24.22.0** | `node -v` |
| pnpm | **12.14.0** | `pnpm -v` |
| npm | 11.19.1 | `npm -v` |
| 发行版 | **Ubuntu 26.04.1 LTS (resolute)** | `lsb_release -a`（或 `/etc/os-release`） |
| 内核 | 6.18.54.1-microsoft-standard-WSL2 | `uname -r` |
| adb | **未安装** | `which adb` |

1. **adb 未安装**：`sudo apt install android-tools-adb`（或下载 platform-tools）。
2. **★无线调试（已锁定，方案 c，最省事）**：
   - 手机与 WSL 宿主置于**同一 WLAN**；
   - 手机开「开发者选项 → 无线调试 → 配对」，`adb pair <手机IP>:<配对端口>`，再 `adb connect <手机IP>:<调试端口>`；
   - WSL 与手机同网段即可，不需 usbipd、不需 USB 转发。
3. **★adb 探活与掉线重连（WSL2 隐患）**：WSL2 **重启后 IP 环境会变、adb server 状态不持久**，且**手机休眠会让无线调试掉线**。因此约定：**每次任务开始前先执行 `adb devices` 探活**；发现目标设备不在列表（`offline`/`device` 消失）则**自动 `adb connect` 重连一次**；重连后仍不可用 → **立即报错并提示"请检查手机无线调试/同网段"**，不带着断线设备硬跑。
4. **截图/证据存放**：`./.price-agent/evidence/`（按 §6.5 TTL 与保留上限清理，默认脱敏后存本地）；路径回传 AI 展示。
5. **持久化位置**：任务记录与记账分别存 `ctx.storageDomain` 的 `tasks` / `ledger` 表（由 `dsh-storage-json` 落到 `$DSH_HOME/storages`）；**不自建 `.price-agent/*.json`**。截图为二进制大文件，存 `.price-agent/evidence/`（按 §6.5 TTL 清理）。
6. **额度记账**：见 §5.6，按 `platform + strategyId` 记入 `ledger` 表，仅作参考/降级，不把推测当事实。

### 8.4 ★WSL2 无线调试最小可验证实验（P2 前置、10 分钟可判定）

在投入任何真机自动化开发前，先用一个**最小实验**证明"WSL2 能连上手机、能取到界面"，不通过就不要往下做。要求：**能跑、能判定通过/失败、有明确失败原因**。

**前置**：手机与装有 WSL2 的 Windows 在**同一 WLAN**；手机开启"开发者选项 → 无线调试"。

**步骤（逐条执行，记录输出）**：
```bash
# 0) 安装 adb（WSL 内）
sudo apt install -y android-tools-adb
adb version

# 1) 确认 WSL 与手机在同一网段（手机上查「设置→WLAN→当前网络→IP」）
ip addr show eth0 | grep 'inet '      # WSL 的 IP
ping -c 3 <手机IP>                    # 必须通；不通 = 不在同网段/WSL 用了 NAT

# 2) 无线调试配对（首次；端口与配对码以手机屏幕为准）
adb pair <手机IP>:<配对端口>          # 输入手机显示的 6 位配对码

# 3) 连接（调试端口同样以手机"无线调试"页面显示的为准）
adb connect <手机IP>:<调试端口>
adb devices                           # 期望：<IP>:<端口>  device

# 4) 能力探测：能否 dump 控件树 + 截屏
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml -   # 应输出 XML
adb exec-out screencap -p > /tmp/shot.png && file /tmp/shot.png           # 应为 PNG
```

**判定标准（全部满足才算通过）**：
1. `adb devices` 显示目标设备状态为 **`device`**（不是 `offline`/空）；
2. `uiautomator dump` 输出非空 XML，且其中含**可读文本节点**；
3. `screencap` 得到有效 PNG；
4. 断开重连演练：`adb disconnect` 后任务逻辑能 `adb connect` **自动重连 1 次**成功。

**常见失败与处置**（可写进 README 排障表）：
- `ping` 不通 → WSL 处于 NAT，需在 Windows 侧 `netsh interface portproxy`/改用 `adb -H <windows-ip>`，或手机改连 PC 的热点；
- `adb devices` 为空 / `offline` → 手机休眠或无线调试被关；保持屏幕常亮、重新 `pair/connect`；
- 端口每次重连变化 → 从手机"无线调试"页面取**当前**端口（旧端口失效）。

> **门槛意义**：该实验通过 = 环境风险排除，可进 P2；未通过 = 先解决网络/端口问题，**不要**在真机抓价上浪费时间。

---

*模块规范 · 文档版本 v0.8.0 · 对应代码：骨架 + 开发工具链已就绪*
