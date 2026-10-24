/**
 * Plugin configuration schema (schemastery). See module-spec §5.1 / §4.2.
 * Shape mirrors `cordis.patch.yml`; validated at load time (fail-fast on bad config).
 *
 * 说明：`Config` 是唯一配置真源；`AppConfig` 是它的输出类型（供 core/task 结构化引用）。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  device: z
    .object({
      driver: z.union([z.const('mock'), z.const('adb')]).default('mock'),
      /** `auto`（唯一在线设备）或 `host:port` / 序列号。 */
      serial: z.string().default('auto'),
      /** adb 可执行文件路径（默认走 PATH 的 `adb`）。 */
      adbPath: z.string().default('adb'),
      /** 掉线时自动 `adb connect` 重连一次（§8.3）。 */
      autoReconnect: z.boolean().default(true),
      /** Unicode 输入辅助 IME（中文输入用；如 ADBKeyboard 的 com.android.adbkeyboard/.AdbIME）。空=不用。 */
      unicodeIme: z.string().default(''),
      /** 连接后关闭系统动画（默认 true）：避免 `uiautomator dump` 持续动画导致 idle 失败。 */
      disableAnimations: z.boolean().default(true),
    })
    .default({ driver: 'mock', serial: 'auto', adbPath: 'adb', autoReconnect: true }),
  task: z
    .object({
      stepTimeoutMs: z.natural().default(8000),
      pageTimeoutMs: z.natural().default(20000),
      taskTimeoutMs: z.natural().default(90000),
      /** 锁等待上限；超时 → 503 BUSY（§7.7 R4）。 */
      lockWaitMs: z.natural().default(5000),
      idempotencyTtlMinutes: z.natural().default(30),
    })
    .default({
      stepTimeoutMs: 8000,
      pageTimeoutMs: 20000,
      taskTimeoutMs: 90000,
      lockWaitMs: 5000,
      idempotencyTtlMinutes: 30,
    }),
  evidence: z
    .object({
      ttlMinutes: z.natural().default(10),
      retainMax: z.natural().default(50),
    })
    .default({ ttlMinutes: 10, retainMax: 50 }),
  ocr: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  platforms: z
    .dict(
      z.object({
        enabled: z.boolean().default(false),
        appId: z.string(),
        priceToleranceYuan: z.number().default(1.0),
      }),
    )
    .default({
      meituan: { enabled: true, appId: 'com.sankuai.meituan', priceToleranceYuan: 1.0 },
      eleme: { enabled: true, appId: 'me.ele', priceToleranceYuan: 1.0 },
    }),
})

/** 校验后的配置输出类型。 */
export type AppConfig = ReturnType<typeof Config>
