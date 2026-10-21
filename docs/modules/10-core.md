# 10 · core（装配 / 时钟 / 锁）`src/core/*`

> 层：infra，被各层使用，**不反向依赖业务**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `container.ts` | 按 config 选实现、组装依赖图 | `buildContainer(ctx, config): Deps` |
| `clock.ts` | 时间抽象（可测） | `Clock`, `SystemClock`, `FakeClock` |
| `locks.ts` | 设备锁 / 快照单飞 | `withDeviceLock(serial, fn)`, `withSnapshotLock(hash, fn)` |

```ts
interface Deps { driver: Driver; ocr: Ocr; clock: Clock; jobs: Jobs; storage: StorageDomain }
```

## 实现要点（特有）
- `container` 是**唯一**决定 `mock|adb`、`tesseract|mock` 的地方；其它模块只收接口。
- `clock.ts`：生产用 `SystemClock`（内部可读 `Date.now`）；测试用 `FakeClock`（可推进），**业务禁止直接 `Date.now()`**（§2.1 R4）。
- `locks.ts`：**薄封装** `dsh-atomic-write` 的 `withWriterLock`（wx 锁 + PID + `ESRCH` 接管），**不要**自己实现锁；锁键：设备 `device-<serial>.lock`、快照 `snapshot-<hash>.lock`（§7.7 R1）。
- 获取锁失败/超时 → 抛 `BusyError`（上层映射 `503 BUSY`）。

## 本模块必须遵守的共享规则（清单）
- 锁层次与顺序（设备→快照→资源）：§7.7 R1
- 注入禁止硬编码：§2.1 R2
- 复用 `dsh-atomic-write`：§2.2

## 测试
- `FakeClock` 推进使超时逻辑可确定；
- 并发两任务 → 设备锁串行（`concurrency.test.ts`，P1）。
