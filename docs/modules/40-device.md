# 40 · device（设备 / Driver）`src/device/*`

> 层：capability。实现 `Driver` 接口；依赖 `dsh-native-command`（adb）与 `core/clock`，**不依赖 price/task/platform**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `driver.ts` | 设备抽象（唯一真源） | `Driver`, `UiSelector`（`probe?()` 为真机可选能力） |
| `adb.ts` | **adb 真机实现（P2）**：连接/自动重连/dump/tap/input/swipe/screencap/probe | `createAdbDriver(opts)`, `AdbDriver`, `AdbRunner`, `ensureNoHumanRequired` |
| `mock.ts` | MockDriver（点击 open-<platform> 后回放结算页 dump） | `createMockDriver(opts)` |
| `mock-data.ts` | Mock 结算页 fixtures（脱敏） | `MOCK_SETTLE_PAGES`, `MOCK_OCR_ENTRIES` |
| `state.ts` | 状态机断言 | `assertState`, `StateAssertion`, `hasResourceId` |
| `uixml.ts` | 真机 uiautomator XML 解析（含 bounds/class/clickable） | `parseUiNodes/findBySelector/centerOf/parseBounds/count*,hasWebview,visibleTexts` |
| `probe.ts` | 能力探测 + 页面识别质量（纯函数） | `analyzeDump/isValidPng/parseWmSize/parseForeground`, `DeviceProbe`, `DumpQuality` |
| `recover.ts` | 弹窗/授权/加载/登录/验证码拦截（§3.5.2） | `classifyObstruction/assertNoHumanRequired/recoverOnce/recoverySelector` |
| `pageDetect.ts` | 页面识别（多信号融合，§3.5.4） | `detectPage(dump, contracts)`, `PageContract` |
| `steps.ts` | **动作+断言+超时+恢复** 原语（§3.5.1） | `waitForState/tapAndExpect/inputAndExpect/swipeAndExpect` |
| `capture.ts` | 失败取证：dump+截图落本地（原子写，脱敏） | `captureEvidence(driver, dir, name)` |

```ts
interface Driver {
  dump(): Promise<string>                       // uiautomator XML
  tap(sel: UiSelector): Promise<void>           // 内部先 assertTapSafe（红线 1）
  input(sel: UiSelector, text: string): Promise<void>
  swipe(dir: 'up'|'down'): Promise<void>
  screencap(): Promise<Uint8Array>              // PNG bytes
  probe?(): Promise<unknown>                    // 仅真机实现（能力探测）
}
```

## 实现要点（特有）
- `adb.ts` **必须**调 `runNativeCommand('adb', argv, signal, 'hidden')`，**不得**自写 spawn/超时/取消（§2.2）。命令经注入的 `AdbRunner` 边界（默认 `runNativeCommand`），**测试可注入假 runner 离线回放**，无需真机。
- **连接/重连（§8.3）**：每次动作前 `ensureConnected()` → `adb devices` 探活；目标掉线且是网络地址（`host:port`）→ 自动 `adb connect` **重连一次**，仍失败抛可读错误（提示无线调试/同网段/端口）。
- **截图二进制**：`shell screencap -p /sdcard/x.png` 落盘 → `adb pull` 到本地临时文件 → `readFile` 读字节（**不经 utf8**，否则 PNG 损坏）；校验 PNG 魔数。
- **dump 三级兜底（P3 真机发现）**：`exec-out uiautomator dump /dev/tty` → `shell dump` 落盘 + cat → **`dump --compressed`**。美团搜索结果等重页面标准 dump 会被系统 `Killed`（落盘 0 字节），`--compressed` 可稳定产出且保留 `resource-id/text/bounds/clickable`。回归测试 `falls back to --compressed dump…`。
- **中文输入的硬约束（P3 真机）**：`adb shell input text "中文"` 在搜狗等输入法下直接 NPE、且内容不落框（拉丁字符也不可靠）；**Unicode 文本注入必须走 ADBKeyboard 的 `ADB_INPUT_TEXT` 广播**（`am broadcast -a ADB_INPUT_TEXT --es msg 关键词`，注意空格会被 `am` 拆参数 → 用无空格关键词或加引号）。这是"环境辅助手段"，非风控绕过；跑完可 `ime set` 切回原输入法。
- **点击前强制过安全护栏**：`tap()` 内先 `assertTapSafe(sel)`（`core/safety.ts`，检查 resourceId/label/content-desc/**text**），命中下单/支付即抛 `ForbiddenActionError`。**这是红线 1 的落点。**
- **每条 dump 后**可调 `ensureNoHumanRequired(dump)`：命中验证码/风控 → `NeedsHumanError('captcha')`；登录态 → `NeedsHumanError('login')`。**红线 2 的落点。**
- `steps.ts`：杜绝盲等。动作后 `waitForState` 轮询 dump 断言；断言失败**先尝试弹窗恢复**（`recover.ts`），仍失败 → `captureEvidence` 截图+dump 留证并抛 `StateAssertionError{expected, dumpPath, screenshotPath}`。P3 增 `waitForAnyState`（**OR 语义**，页面 anchor 多选一），与 `waitForState` 共用同一套拦截/恢复/取证逻辑。
- `recover.ts` **红线补强（P3 真机发现）**：美团滑块验证是 **WebView canvas 渲染，dump 无 text/content-desc**，纯文案匹配会漏判成 `none`。已补"无字大 WebView 遮罩"结构判据（`looksLikeTextlessCaptcha`）→ 识别为 `captcha` 并抛 `NeedsHumanError`，**仍绝不点击**。回归用例 `test/fixtures/captcha.textless-webview.xml`。
- `probe.ts`：`analyzeDump` 输出 `treeRichness` 与 `recommend(tree|ocr|human)`，供降级决策（§3.5.4）；`adb.probe()` 采集机型/分辨率/DPI/前台包名 + dump 质量 + 截屏可用性。
- `mock.ts` 与 `adb.ts` **实现同一 `Driver`**，切换 `device.driver` 不改上层（§2.1 R3）。
- XML 解析用零依赖正则（`uixml.ts`）；P3 若需更强层级解析可换 `fast-xml-parser`（可选依赖）。

## 只读演练 / 能力探测入口（P2）
- **工具 action**：`price_agent({action:'probe'})` 返回能力探测报告；`price_agent({action:'selfCheck'})` 跑 §8.4 最小实验（连接/dump/截屏检查项）。二者在 Mock 驱动下返回 `supported:false`。
- **运维脚本**：`scripts/device-rehearsal.mjs`（产出 JSON+Markdown 报告到 `.price-agent/reports/`）、`scripts/device-min-experiment.sh`（§8.4 bash 逐条判定）。
- **自动探测**：真机 `runCompare` 进设备锁后先跑一次 `probe()` 并把结果写进进度（Mock 无 `probe` 则跳过，P1 行为不变）。

## 本模块必须遵守的共享规则（清单）
- 每步动作+断言+超时+恢复：§3.5.1
- 弹窗拦截表：§3.5.2
- 安全红线（禁下单/支付、验证码即停）：AGENTS.md §0
- 能力探测与识别降级矩阵：§3.5.4
- WSL2 adb 探活/重连：§8（每次任务前 `adb devices`，掉线重连 1 次）

## 测试（`test/device-p2.test.ts`，离线、不需真机）
- `uixml`：属性/bounds/clickable 解析、`findBySelector` 优先级、中心点。
- `probe`：`analyzeDump`（原生树→tree；WebView 空壳→ocr/human）、`isValidPng/parseWmSize/parseForeground`。
- `recover`：captcha/upgrade/none 分类；**验证码抛 `NeedsHumanError` 且从不点击**。
- `pageDetect`：settle/home/unknown 判定。
- `adb`（注入假 runner）：auto 选唯一设备、无线掉线自动重连 1 次、重连失败可读报错、tap 坐标中心、**下单控件被拦且不产生任何 adb 调用**、截屏走 pull 二进制、`probe` 采集。
- `steps`：升级弹窗穿透后命中断言、验证码→`NeedsHumanError`、超时写 dump 证据并抛 `StateAssertionError`。
- `task`：`probeDevice/runMinExperiment` 在 mock 与 adb(fake) 两条路径的行为。
