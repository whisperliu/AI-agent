# 20 · task（编排 / 生命周期）`src/task/*`

> 层：orchestration。只依赖**接口**（driver/ocr 抽象、price/model 类型），不 import 具体实现（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `runner.ts` | 单次比价流程编排（设备锁内串行）；P4 增：策略四态合并 / 偏离检测 / 跨平台互斥 | `runCompare(deps, plan, sink, signal)`、`draftFromFacts`、`detectDeviations`、`strategySpecsFor` |
| `progress.ts` | 进度阶段与状态机 | `PHASES`, `emit(sink, line)`, `platformLine(i,n,platform,phase)` |
| `store.ts` | 任务持久化映射（storageDomain 薄封装） | `saveTask/getTask/listTaskRecords/get+put+deleteIdempotency` |
| `idempotency.ts` | 幂等键与映射 | `computeKey(snapshot,platformIds,options)`, `assertSameSnapshot` |
| `lifecycle.ts` | 开始/取消/重取/恢复/过期 + **P2 设备探测** | `startTask/getResult/listTasks/cancel/recoverOnStartup`, `probeDevice/runMinExperiment` |
| `snapshot.ts` | 统一输入快照（§6.6） | `buildSnapshot(input)` |
| `hash.ts` | 确定性哈希（键/校验和） | `sha256/hashObject/stableStringify` |
| `cleanup.ts` | **证据/结果清理（P5）**：按 TTL+保留上限取先到者 | `cleanupEvidence`, `cleanupResults` |

> 共享任务类型（`TaskRecord/TaskStatus/StartInput/GetResultReply/…`）唯一真源在 `src/price/model.ts`（§4.4 R5）。

## 实现要点（特有）
- **任务状态机**：`queued → processing → completed|failed|cancelled|expired`（§7.3）。
- **持久化只经 `ctx.storageDomain` 的 `tasks` 表**（薄封装，不写文件）；写落盘后才推进状态（§7.5(1)）。
- **幂等**：`computeKey = sha256(snapshot.hash ‖ 平台集排序 ‖ taskOptionsHash)`，**键不含时间窗**（§7.6 R1）；`beginIdempotent` 用 `withWriterLock` 保证"先写键再执行"。
- **并发**：进入 `runCompare` 前先 `withDeviceLock`、再 `withSnapshotLock`（顺序固定，§7.7 R1）。
- **取消确认**：置 `cancelling` → 等 driver 子任务真正停下 → `cancelled`（§7.5(4)）。
- **结果**：用 `writeFileAtomic` 原子写 + `checksum` + `runToken` 校验，迟到写入丢弃（§7.5(2)(5)）。
- **恢复**：启动读 `tasks` 表，`processing` 且无活进程 → `failed(interrupted)`（§7.5(6)）。
- 每步 `sink` → `ctx.jobs` 的 `updateProgress(line)`；不直接碰 UI。
- **P2 能力探测**：`runCompare` 进设备锁后，若驱动实现 `probe()`（真机 adb）则先跑一次并写入进度；Mock 驱动无 `probe` 则跳过（不改 P1 行为）。`probeDevice/runMinExperiment` 在 Mock 下返回 `supported:false`，真机下走驱动 `probe()/ensureConnected()`，全程只读。
- **P5 证据绑定与重试（runner）**：每平台抽取后 `bindEvidence` 把 **dump 原样写** `evidence/<quoteId>.xml`、**截图脱敏后**写 `evidence/<quoteId>.png`（OCR 平台写 `ocrText`），`redaction`/`missingReason` 如实回填；`draftFromFacts(facts,...,quoteId,bound?)` 承接（不传 `bound` 保持旧行为）。平台抽取用 `core/retry.withRetry` 包裹（`task.retryAttempts`，**仅瞬时故障重试**，验证码/支付绝不重试）。`cleanupSweep` 在完成与启动两个时点清 `evidence/`+`results/`；`getResult` 检测到截图已清 → `note` 提示需重新核价。
- **P4 策略与快照（runner）**：每平台抽取后（1）用 `strategySpecsFor(config, id)` 读策略、`evaluateStrategies`（基数=费用原价）产出四态 savings，与结算页 `optionalSavings` 去重合并进 `QuoteDraft`；（2）`draftFromFacts` 写入 `snapshotId/snapshotHash` 并 `detectDeviations`（qty/规格偏离 → `deviatedConditions`）；（3）全部平台后 `applyCrossPlatformExclusivity` 做谨慎互斥，再 `priceQuote` + `compare`。**不重复扣**：`effectivePrice` 仍只由 `deductibleSavings` 决定。

## 本模块必须遵守的共享规则（清单）
- 异步契约与工具返回：§7.4
- 幂等完整语义：§7.6（R1–R5）
- 并发锁与竞态：§7.7（R1–R5）
- 数据契约 `Quote/CompareResult`：§6.2

## 测试
- `lifecycle.test.ts`（取消/重启恢复/过期/重取/listTasks/取消中不覆盖终态）
- `idempotency.test.ts`（同键并发 10 次=1 任务、异参冲突、键不含时间窗）
- `concurrency.test.ts`（设备锁串行不交叉、锁超时→BusyError）
- `decoupling.test.ts`（全链路 start→getResult；切 mock/adb 不改业务）
