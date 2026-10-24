# 10 · core（装配 / 时钟 / 锁）`src/core/*`

> 层：infra，被各层使用，**不反向依赖业务**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `container.ts` | 装配：按 config 选 mock/adb；`Deps`/`JobsPort`/`ProgressPort` 契约；任务领域 spec | `buildCapabilities(cfg,{dataDir})`, `Deps`, `TaskDomainSpec` |
| `jobs-adapter.ts` | `ctx.jobs` → `JobsPort` 适配（隔离具体服务） | `createJobsPort(ctx, owner?)` |
| `clock.ts` | 时间抽象（可测） | `Clock`, `SystemClock`, `FakeClock` |
| `locks.ts` | 设备锁 / 快照单飞 / 资源锁 | `withDeviceLock`, `withSnapshotLock`, `withLock` |
| `safety.ts` | **安全护栏**：拦截下单/支付点击 | `assertTapSafe(target)` |
| `errors.ts` | 跨模块错误类型 | `BusyError/StateAssertionError/NeedsHumanError/ForbiddenActionError/IdempotencyConflictError/TaskNotFoundError` |
| `retry.ts` | **瞬时异常重试（P5）**：可重试判定 + 指数退避 | `isRetryable(err)`, `withRetry(fn, opts)` |

```ts
interface Deps { driver: Driver; ocr: Ocr; clock: Clock; jobs: JobsPort; tasks: Domain<TaskDomainSpec>; config: AppConfig; dataDir: string; serial: string; lockRoot?: string }
```

## 实现要点（特有）
- `container` 是**唯一**决定 `mock|adb`、`tesseract|mock` 的地方（DI 组合根）；其它模块只收接口。
- `clock.ts`：生产用 `SystemClock`（内部可读 `Date.now`）；测试用 `FakeClock`（可推进），**业务禁止直接 `Date.now()`**（§2.1 R4）。
- `locks.ts`：**薄封装** `dsh-atomic-write` 的 `withFileLock`（wx 锁 + PID + `ESRCH` 接管），**不要**自己实现锁；锁键：设备 `device-<serial>.lock`、快照 `snapshot-<hash>.lock`（§7.7 R1）。
- 获取锁超时（库抛 "timed out waiting for the writer lock"）→ 映射 `BusyError`（上层 `503 BUSY`）。
- `jobs-adapter`：把 `ctx.jobs.start` 的 `JobHandle`（`updateProgress/append`）包成 `ProgressPort`，并转发 `cancel`。task 逻辑只依赖 `JobsPort`，可在测试用内存实现完全离线。
- `retry.ts`：`isRetryable` **红线优先**——`NeedsHumanError`（验证码/登录/风控）与 `ForbiddenActionError`（下单/支付）**永远不重试**；只重试 adb 掉线 / `uiautomator dump` 无 idle / 截屏拉取失败 / 超时这类瞬时故障。`withRetry` 指数退避、尊重 `signal`、不吞异常。
- `safety.ts`：**每次 `driver.tap` 前必须调 `assertTapSafe(target)`**；命中下单/支付（`提交订单/立即支付/…`）抛 `ForbiddenActionError`。多语言/大小写/下划线已归一，宁可误拦不可放过（AGENTS.md §0 红线 1 的程序化防线）。

## 本模块必须遵守的共享规则（清单）
- 锁层次与顺序（设备→快照→资源）：§7.7 R1
- 注入禁止硬编码：§2.1 R2
- 复用 `dsh-atomic-write`：§2.2
- 安全红线（下单/支付/验证码）：AGENTS.md §0

## 测试
- `FakeClock` 推进使超时逻辑可确定；
- 并发两任务 → 设备锁串行（`concurrency.test.ts`，P1）。
