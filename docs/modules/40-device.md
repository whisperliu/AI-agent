# 40 · device（设备 / Driver）`src/device/*`

> 层：capability。实现 `Driver` 接口；依赖 `dsh-native-command`（adb）与 `core/clock`，**不依赖 price/task/platform**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `driver.ts` | 设备抽象（唯一真源） | `Driver`, `UiSelector` 接口 |
| `adb.ts` | adb 实现（内部 runNativeCommand；P2 完善） | `createAdbDriver(opts)` |
| `mock.ts` | MockDriver（点击 open-<platform> 后回放结算页 dump） | `createMockDriver(opts)` |
| `mock-data.ts` | Mock 结算页 fixtures（脱敏） | `MOCK_SETTLE_PAGES`, `MOCK_OCR_ENTRIES` |
| `state.ts` | 状态机断言（presentResourceIds） | `assertState`, `hasResourceId` |

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
- **点击前强制过安全护栏**：`tap()` 内先 `assertTapSafe(sel)`（`core/safety.ts`），命中下单/支付即抛 `ForbiddenActionError`；验证码/风控 → 抛 `NeedsHumanError`。**这是红线 1/2 的落点。**
- `mock.ts` 与 `adb.ts` **实现同一 `Driver`**，切换 `device.driver` 不改上层（§2.1 R3）。
- `state.ts`：`StateAssertion` = `presentResourceIds/presentTexts/absentResourceIds`；失败抛 `StateAssertionError{expected, dumpPath, screenshotPath}`。
- `recover.ts` 只处理已知干扰（升级/广告/定位/通知/加载/登录/验证码）；**验证码 → 抛 `NeedsHumanError`**（不硬闯）。
- `probe.ts` 每任务跑一次，产出 `Capability{canDump, resolution, hasWebview, treeRichness}` 供 `pageDetect` 决定降级。
- XML 解析用 `fast-xml-parser`（不引重型库）。

## 本模块必须遵守的共享规则（清单）
- 每步动作+断言+超时+恢复：§3.5.1
- 弹窗拦截表：§3.5.2
- 安全红线（禁下单/支付、验证码即停）：AGENTS.md §0
- 能力探测与识别降级矩阵：§3.5.4
- WSL2 adb 探活/重连：§8（每次任务前 `adb devices`，掉线重连 1 次）

## 测试
- `state.machine.test.ts`：回放 dump 快照，断言通过/失败路径。
- `MockDriver` 驱动 platform 脚本联调。
