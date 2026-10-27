# 交接记录 · 真机「全流程跑不通」排查（2026-10-24 中断，**2026-10-25 已结项 ✅**）

> 状态：**已闭环**。2026-10-25 平板切回全屏竖屏后真机端到端复测 **PASS**：
> `payable=¥29.88 / balanced=true / confidence=high / needsConfirm=false`，证据脱敏落盘。
> 昨日定位并修复的 6 个真实 bug 全部生效，卡点确认为**设备环境（PC/桌面模式浮窗）**、非代码逻辑。
> 结论详见 `CHANGELOG[42]`；下文保留当时的排查与交接过程作为历史记录。

---

## 1. 一句话结论

`runCompare` 真机全流程失败的**主因是设备处于「PC/桌面模式」**：美团被系统以**浮窗**打开，
窗口 `appX` 在 `641` 与 `1281` 之间漂移，`dump` 与 `input tap` 的坐标系不一致 →
坐标必然错位。**代码侧已把所有能修的修完**，剩下的必须人工把手机切回「全屏 + 竖屏」。

---

## 2. 已修复的 6 个根因（均已提交 `5b579b3`）

| # | 现象 | 根因 | 修复落点 |
|---|---|---|---|
| 1 | 一开始就 `missing resourceId tab_home` / 首页锚点超时 | **流程从不启动 App**，默认 App 已在前台 | `Driver.launchApp/foreground`；`navigator.ensureAppForeground`；两平台 `enterSettlePage` 前置调用 |
| 2 | 启动后停在搜索页 | `monkey`/LAUNCHER intent 只"提到前台"，**恢复上次页面** | `launchApp` 改 `resolve-activity` + `am start -n <MainActivity>`；`force` 时 `-S` |
| 3 | 回首页时 App 被退到桌面 | `ensureHome` 盲目连按返回键（搜索页→首页→桌面） | 每次回退**先查前台包名**；跑出 App 就重新拉起；最终兜底 force-stop 重启 |
| 4 | **店铺页读到搜索结果页的内容**（最隐蔽） | 重页面标准 dump 报 `could not get idle state` 且**不覆盖旧文件** → cat 到上一页 | `dumpToFile`：先 `rm` → 跑 dump → **校验 `dumped to` 且无 `ERROR`** → 才 cat；否则 `--compressed` |
| 5 | 1500ms 语义的等待一次都不重试 | 真机单次 dump **2.4–3.4s > timeoutMs** | `waitForAnyState` 保证**至少 2 次** dump 尝试 |
| 6 | 搜索页被误判成首页 | `homeAnchors` 含 `search_button`，而搜索页也有同名 id | `MEITUAN_SELECTORS.homeAnchors` 移除 `search_button` |

附加修复：`adb daemon 冷启动首帧 devices 为空` → 预热等待（`7089f1c`）；
`旧 host:port 失效` → mDNS 自动发现回连（`c23453e`）。

---

## 3. 新增能力（已实现 + 单测，可复用）

- `src/device/probe.ts`
  - `parseWindowGeometry(screenBounds, focusedWindowBlock)` —— 从**聚焦窗口**的
    `winConfig={ mBounds=Rect(...) mWindowingMode=... mAreBoundsLetterboxed=... }` 解析
    `{screenW/H, appX/Y/W/H, multiWindow, letterboxed}`
  - `parseFocusToken(windowDump)` / `sliceWindowBlock(windowWindows, token)` —— 定位聚焦窗口段
  - `toScreenPoint(geo,x,y,extent)` —— **自动判定** dump 是「窗口内坐标」还是「屏幕坐标」，
    仅前者加偏移（**避免偏移两次**）
- `src/device/adb.ts`
  - `geometry()`（10s 缓存）、`screenPoint()`、`dumpExtent()`
  - `tap/tapPoint/swipe` 全部走坐标映射；`launchApp(appId,{force})`、`foreground()`、`back()`
  - `probe()` 返回 `geometry`
- `src/platform/navigator.ts`
  - `ensureAppForeground(driver, appId)`、`ensureHome(nav, anchors, {appId})`、
    `assertUsableWindow(driver)` → 分屏/多窗口抛 `NeedsHumanError('environment')`
- `src/core/errors.ts`：`NeedsHumanError` 增 `reason='environment'` + `hint`

---

## 4. 卡点（**2026-10-25 已解除**，以下为历史记录）

> **解除方式**：用户把平板切回**全屏 + 竖屏**（`mBounds=Rect(0,0-1600,2560)`、`mDisplayRotation=ROTATION_0`、
> `mWindowingMode=fullscreen`、`inPcmode=0`），appX 不再漂移，`runCompare` 真机全流程 **一步跑通**
> （`payable=¥29.88 balanced=true confidence=high needsConfirm=false`）。**无需改代码**。
> 遗留：冷启动首屏若弹「身份核实」拼图滑块 → 按红线人工通过（代码侧已做到检测即停零点击）。

### 4.1 现象
```
[geo] {"screenW":2560,"screenH":1600,"appX":641或1281,"appW":1279,...multiWindow:true}
[FAIL] StateAssertionError: missing resourceId search_edit_text（last dump 2695 bytes）
```
2695 字节的 dump = **只有一个透明容器节点**（`YodaRouterTransparentActivity` 浮层），无任何控件。

### 4.2 已确认的环境事实（重要）
- 屏幕 **2560×1600 横屏**（`ROTATION_90`），但 App 是竖屏 → 系统用 **letterbox/浮窗** 承载
- `dumpsys activity activities`：同一 task 拆成两个 `taskFragment`
  （`Rect(0,0-1279,1600)` 与 `Rect(1281,0-2560,1600)`），`topResumedActivity ... isEmbedded=true`
- `settings get global enable_freeform_support`：`null`；设备有
  `feature:android.software.freeform_window_management`
- `am start --windowingMode fullscreen`：**被系统拒绝**（抛异常）
- force-stop 后冷启动，仍以浮窗打开 → 判定为**平板 PC/桌面模式**（Motorola/ZUI 桌面模式）

### 4.3 明天要做的（按优先级）

1. **先人工恢复环境**（最关键，2 分钟）
   - 平板：下拉快捷开关 → 关闭「PC 模式 / 桌面模式」；或 设置 → 显示 → 关闭「桌面模式」
   - 手机转到**竖屏**，确认：`adb shell dumpsys window displays | grep mBounds`
     应约为 `Rect(0,0-1600,2560)`，且
     `adb shell dumpsys activity activities | grep -c mWindowingMode=multi-window` 为 0
   - 复跑：`node .price-agent/diag/live-run.mjs`（该脚本已删除，按下节重建）

2. **若必须是横屏/PC 模式**（要考虑是否支持）
   - 先确认 `dump` 坐标系到底跟哪个走：在同一状态下连续跑 `dumpsys` + `uiautomator dump`，
     比对 `search_layout_area` 的 `bounds` 与窗口 `mBounds`
     - 若 bounds 是**屏幕坐标**（含偏移）→ `toScreenPoint` 已能原样返回（已实现）
     - 若 bounds 是**窗口内坐标** → 已能加偏移（已实现）
   - 若两种混用且**同一窗口内也漂移** → 说明浮窗还在动画/重建，考虑在 `tap` 前
     `geometry()` 强制刷新（去掉 10s 缓存）或先等窗口稳定
   - **兜底策略（推荐）**：PC 模式下**不追求全自动导航**，改为
     「让用户手动把 App 走到结算页 → 插件只读结算页」（`runMeituanReal` 已有
     "已在结算页 → 直接读、零点击"的短路，这条路径在 PC 模式下也应可用）

3. **验收标准（明天复测）**
   - `node scripts/...` 跑 `runCompare`，期望：
     `[OK] payable=xx balanced=true confidence=high needsConfirm=false`
   - 证据：`evidence/<quoteId>.xml` + `.png`（已脱敏）存在
   - 仍失败则用 `scripts/evidence-inspect.mjs <dump> --clickable` 看是**哪一步锚点**没命中

---

## 5. 复跑脚本（临时脚本已删，按此重建）

保存为 `.price-agent/diag/live-run.mjs`：

```js
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = '/home/liuqiaoqiao/dsh-plugin-price-agent'
const { Config } = await import(ROOT + '/src/config.ts')
const { buildCapabilities } = await import(ROOT + '/src/core/container.ts')
const { runCompare } = await import(ROOT + '/src/task/runner.ts')
const { selectPlatforms } = await import(ROOT + '/src/platform/router.ts')
const { buildSnapshot } = await import(ROOT + '/src/task/snapshot.ts')

const config = Config({
  device: { driver: 'adb', serial: 'auto', adbPath: ROOT + '/.home/android-sdk/platform-tools/adb',
            autoReconnect: true, disableAnimations: true, unicodeIme: 'com.android.adbkeyboard/.AdbIME' },
  ocr: { enabled: true }, evidence: { redact: true },
  platforms: { meituan: { enabled: true, appId: 'com.sankuai.meituan' } },
})
const dataDir = await mkdtemp(join(tmpdir(), 'liverun-'))
const caps = buildCapabilities(config, { dataDir })
const clock = { now: () => Date.now(), iso: () => new Date().toISOString() }
const deps = { ...caps, config, dataDir, serial: config.device.serial, clock,
               lockRoot: join(dataDir, 'locks'), jobs: {}, tasks: {} }
const cond = buildSnapshot({ item: '腐竹炒肉木桶饭', city: '上海' })
const logs = []
const p = { update: (l) => logs.push('· ' + l), append: (l) => logs.push('  ' + l) }
try {
  const r = await runCompare(deps, { taskId: 'live-1', cond, platforms: selectPlatforms(config) }, p)
  console.log(logs.join('\n'))
  for (const g of r.groups) for (const q of g.quotes)
    console.log(q.platform, 'payable=', q.payable, 'balanced=', q.arithmetic.balanced,
                'conf=', q.extraction.confidence, 'needsConfirm=', q.needsConfirm,
                'evidence=', q.evidence.screenshotPath, q.evidence.redaction)
  console.log('cheapest=', r.cheapest ? `${r.cheapest.platform} ¥${r.cheapest.effectivePrice}` : 'null')
} catch (e) {
  console.log('[ERROR]', e.name, e.message)
  console.log(logs.join('\n'))
}
```

**前置**（每次新 shell 都要做，daemon 冷启动 mDNS 发现慢）：
```bash
export PATH=$PWD/.home/android-sdk/platform-tools:$PATH
adb start-server >/dev/null 2>&1; adb mdns check >/dev/null 2>&1
for i in $(seq 1 15); do sleep 1; adb devices 2>/dev/null | grep -q "device$" && break; done
adb devices   # 期望看到 adb-XXXX._adb-tls-connect._tcp  device
```

---

## 6. 当前仓库状态

- **已结项（2026-10-25）**：真机端到端 PASS，见 `CHANGELOG[42]`。
- 门禁：`pnpm check` **189/189 全绿**（2026-10-27 补 P6 离线全流程回放 +4）；`src/price` 行覆盖 97.15%
- P6 代码/离线：`platform/ocrNav.ts` + `elemeReal.runElemeOcrNav` + `test/ocrNavFlow.test.ts`（见 §8 待复跑清单）
- 安全红线：全程只读；未点任何提交/支付控件；未尝试破解验证码（拼图滑块由用户本人完成）；
  未自动修改窗口布局（只做检测并交人工）

## 7. 复测结果（2026-10-25）

| 项 | 值 |
|---|---|
| 设备 | Lenovo TB321FU / Android 16 / 1600×2560 / 无线 `192.168.3.44:39079` |
| 环境 | 全屏竖屏：`mBounds=Rect(0,0-1600,2560)`、`ROTATION_0`、`fullscreen`、`inPcmode=0` |
| 店铺/菜品 | 江西小炒(盛夏路店) / 小炒肉木桶饭（1人份，微辣）×1 |
| 实付 | **¥29.88**（`effectivePrice=¥29.88`） |
| 平账 | `balanced=true`，expected=29.88 delta=0 tol=1 |
| 识别 | `confidence=high`，`needsConfirm=false` |
| 账目 | 28.88+3.9+2=34.78 −3.9 −1 = 29.88 ✅ |
| 风险项 | 「美团红包 15元（待使用）」标 `presumed`，不计入/不抵实付 ✅ |
| 证据 | 脱敏截图 `redaction=applied`（地址/联系人/手机号涂黑）+ dump 377 节点 |
| 备注 | `adb shell input text` 中文会 NPE → 必须配 `unicodeIme=com.android.adbkeyboard/.AdbIME` |

---
## 8. P6（饿了么 canvas OCR 盲导航）待复跑清单（2026-10-27 记录）

> 代码与**离线全流程回放**已完成（`test/ocrNavFlow.test.ts`，4 例）；仅差真机端到端。平板一上线按下面顺序跑即可。

**0) 前置（设备必须与本机同网段）**
```bash
cd /home/liuqiaoqiao/dsh-plugin-price-agent
ADB=$PWD/.home/android-sdk/platform-tools/adb
$ADB start-server >/dev/null 2>&1; $ADB mdns check >/dev/null 2>&1
for i in $(seq 1 15); do sleep 1; $ADB devices | grep -q "device$" && break; done
$ADB devices -l        # 期望看到 adb-XXXX…  device（或 $ADB connect <ip:port>）
```
> 2026-10-27 本轮：`adb devices` 空、`mdns` 无服务、旧地址 `192.168.3.44:39079/38229/5555` 全不可达；
> 本机 WSL 在 `192.168.71.0/24`，平板此前在 `192.168.3.x` —— **先确认同一 Wi-Fi**，再开「无线调试」给出新 `IP:端口`。

**1) 能力探测**
```bash
# GUI 里让 AI 调 price_agent({action:'probe'})，或：
DEVICE_ADDR=auto node .price-agent/diag/diag2.mjs   # 只打印 supportsOcrNav / 上下文
```

**2) P6 端到端（饿了么 canvas 盲导航，全程只读）**
```bash
DEVICE_ADDR=auto ITEM='小炒肉木桶饭' node .price-agent/diag/diag2.mjs
# 期望：ELAPSED … payable <数字>；失败时异常**自带末帧 OCR 文本**（含 y 坐标），
#       直接看文本判断卡在哪页，**不要**去 read_image 读整屏（省上下文，AGENTS.md §2）。
```
- 若抛 `NeedsHumanError(captcha|login)` → 红线：**立即停，交用户本人完成**，不识别/不绕过。
- 若抛 `NeedsHumanError(environment)` 且 hint 含「拼单」→ 该菜已有进行中的拼单，**不要自动取消**，交用户处理。
- 若 OCR 等待超时（异常里有末帧文本）→ 多半是 `ELEME_LAYOUT`（1600×2560 校准）与当前机型/分辨率不符，
  按 `.price-agent/evidence/auto-*.png` 用 `node scripts/screen-inspect.mjs <png> --ocr [--roi …]` 重新校准坐标，
  **不要**逐张读整屏图。

**3) 收尾（DoD）**
- 读到 `payable` 后：更新 `CHANGELOG`（新条目）、`docs/tasks.md` P6 DoD 勾选、`PLAN/README` 状态，
  并 `pnpm check` 全绿后提交（Conventional Commits）。

---
