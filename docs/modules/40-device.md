# 40 · device（设备 / Driver）`src/device/*`

> 层：capability。实现 `Driver` 接口；依赖 `dsh-native-command`（adb）与 `core/clock`，**不依赖 price/task/platform**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `driver.ts` | 设备抽象（唯一真源） | `Driver` 接口 |
| `adb.ts` | adb 实现 | `createAdbDriver(opts)` |
| `mock.ts` | 回放 fixtures | `createMockDriver(fixturesDir)` |
| `probe.ts` | 能力探测 | `probe(device): Capability` |
| `state.ts` | 状态机断言 | `assertState(dump, StateAssertion)` |
| `recover.ts` | 弹窗/授权/加载恢复 | `recover(d, ctx): boolean` |
| `pageDetect.ts` | 页面识别（XML+OCR+截图） | `detectPage(dump, ocr?): PageId` |

```ts
interface Driver {
  dump(): Promise<string>                       // uiautomator XML
  tap(sel: UiSelector): Promise<void>
  input(sel: UiSelector, text: string): Promise<void>
  swipe(dir: 'up'|'down'): Promise<void>
  screencap(): Promise<Uint8Array>              // PNG bytes
}
```

## 实现要点（特有）
- `adb.ts` **必须**调 `runNativeCommand('adb', argv, signal, 'hidden')`，**不得**自写 spawn/超时/取消（§2.2）。
- `mock.ts` 与 `adb.ts` **实现同一 `Driver`**，切换 `device.driver` 不改上层（§2.1 R3）。
- `state.ts`：`StateAssertion` = `presentResourceIds/presentTexts/absentResourceIds`；失败抛 `StateAssertionError{expected, dumpPath, screenshotPath}`。
- `recover.ts` 只处理已知干扰（升级/广告/定位/通知/加载/登录/验证码）；**验证码 → 抛 `NeedsHumanError`**（不硬闯）。
- `probe.ts` 每任务跑一次，产出 `Capability{canDump, resolution, hasWebview, treeRichness}` 供 `pageDetect` 决定降级。
- XML 解析用 `fast-xml-parser`（不引重型库）。

## 本模块必须遵守的共享规则（清单）
- 每步动作+断言+超时+恢复：§3.5.1
- 弹窗拦截表：§3.5.2
- 能力探测与识别降级矩阵：§3.5.4
- WSL2 adb 探活/重连：§8（每次任务前 `adb devices`，掉线重连 1 次）

## 测试
- `state.machine.test.ts`：回放 dump 快照，断言通过/失败路径。
- `MockDriver` 驱动 platform 脚本联调。
