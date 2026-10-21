# 20 · task（编排 / 生命周期）`src/task/*`

> 层：orchestration。只依赖**接口**（driver/ocr 抽象、price/model 类型），不 import 具体实现（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `runner.ts` | 单次比价流程编排 | `runCompare(deps, plan, sink): Promise<CompareResult>` |
| `progress.ts` | 进度阶段与状态机 | `Phase`, `emit(sink, line)` |
| `store.ts` | 任务持久化映射 | `saveTask/getTask/listTasks` |
| `idempotency.ts` | 幂等键与映射 | `computeKey(snapshot,tools)`, `beginIdempotent(key)` |
| `lifecycle.ts` | 开始/取消/重取/恢复 | `startTask/getResult/cancel/listTasks` |

## 实现要点（特有）
- **任务状态机**：`queued → processing → completed|failed|cancelled|expired`（§7.3）。
- **持久化只经 `ctx.storageDomain` 的 `tasks` 表**（薄封装，不写文件）；写落盘后才推进状态（§7.5(1)）。
- **幂等**：`computeKey = sha256(snapshot.hash ‖ 平台集排序 ‖ taskOptionsHash)`，**键不含时间窗**（§7.6 R1）；`beginIdempotent` 用 `withWriterLock` 保证"先写键再执行"。
- **并发**：进入 `runCompare` 前先 `withDeviceLock`、再 `withSnapshotLock`（顺序固定，§7.7 R1）。
- **取消确认**：置 `cancelling` → 等 driver 子任务真正停下 → `cancelled`（§7.5(4)）。
- **结果**：用 `writeFileAtomic` 原子写 + `checksum` + `runToken` 校验，迟到写入丢弃（§7.5(2)(5)）。
- **恢复**：启动读 `tasks` 表，`processing` 且无活进程 → `failed(interrupted)`（§7.5(6)）。
- 每步 `sink` → `ctx.jobs` 的 `updateProgress(line)`；不直接碰 UI。

## 本模块必须遵守的共享规则（清单）
- 异步契约与工具返回：§7.4
- 幂等完整语义：§7.6（R1–R5）
- 并发锁与竞态：§7.7（R1–R5）
- 数据契约 `Quote/CompareResult`：§6.2

## 测试
- `lifecycle.test.ts`（幂等/取消/重启/过期/重取）
- `idempotency.test.ts`（同键并发 10 次=1 任务、异参 `409`、保留期）
- `concurrency.test.ts`（设备锁串行、记账并发不损坏）
