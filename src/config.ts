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
      /**
       * 平台抽取的**总尝试次数**（含首次，P5）。仅对**瞬时故障**（adb 掉线/dump 拿不到 idle/
       * 截屏失败）重试；验证码/支付/业务终态错误**绝不重试**（core/retry.ts）。默认 2。
       */
      retryAttempts: z.natural().default(2),
    })
    .default({
      stepTimeoutMs: 8000,
      pageTimeoutMs: 20000,
      taskTimeoutMs: 90000,
      lockWaitMs: 5000,
      idempotencyTtlMinutes: 30,
      retryAttempts: 2,
    }),
  evidence: z
    .object({
      ttlMinutes: z.natural().default(10),
      retainMax: z.natural().default(50),
      /** 证据保留天数（与 retainMax **取先到者**清理由 task/cleanup.ts 执行，§6.5）。默认 7。 */
      retainDays: z.natural().default(7),
      /** 截图默认脱敏（P5）：true 时落盘前对敏感区域掩码；无法脱敏则不落图。默认 true。 */
      redact: z.boolean().default(true),
    })
    .default({ ttlMinutes: 10, retainMax: 50, retainDays: 7, redact: true }),
  ocr: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  platforms: z
    .dict(
      z.object({
        enabled: z.boolean().default(false),
        appId: z.string(),
        priceToleranceYuan: z.number().default(1.0),
        /**
         * 平台级优惠策略（§5.1）。用于把"配置里已知的优惠"按四态评估（§5.4/§5.5）：
         * 只有 `verified`（结算页实时实证）且未含在实付里才扣 effectivePrice；
         * 其余最多作 `presumed` 参考提示，**绝不**据额度/配置断言"可用"。
         */
        strategies: z
          .array(
            z.object({
              id: z.string(),
              kind: z.union([
                z.const('coupon'),
                z.const('membership'),
                z.const('credit_card'),
                z.const('promo'),
                z.const('delivery_waiver'),
              ]),
              name: z.string(),
              condition: z
                .object({
                  minSpend: z.number(),
                  /** 英文星期枚举，避免 0-based 歧义（§5.1）。 */
                  weekday: z.union([
                    z.const('monday'),
                    z.const('tuesday'),
                    z.const('wednesday'),
                    z.const('thursday'),
                    z.const('friday'),
                    z.const('saturday'),
                    z.const('sunday'),
                  ]),
                })
                .default({}),
              discount: z.object({
                type: z.union([z.const('fixed'), z.const('percent')]),
                amount: z.number(),
                /** percent 时的封顶金额（固定减免不用）。 */
                cap: z.number(),
              }),
              /** 结算页默认已抵扣 → 运行时 alreadyIncludedInPayable=true（§5.3）。 */
              autoApplied: z.boolean().default(false),
              quota: z
                .object({
                  dailyLimit: z.union([z.number(), z.const(null)]).default(null),
                  monthlyLimit: z.union([z.number(), z.const(null)]).default(null),
                  totalQuota: z.union([z.number(), z.const(null)]).default(null),
                  lastUsedAt: z.union([z.string(), z.const(null)]).default(null),
                })
                .default({
                  dailyLimit: null,
                  monthlyLimit: null,
                  totalQuota: null,
                  lastUsedAt: null,
                }),
              /** 仅"同平台内、同支付方式"的满减互斥（§5.6）。 */
              exclusiveGroup: z.string(),
              /** 默认 false：同一张卡跨平台不互斥；仅显式 true 才跨平台互斥（§5.6）。 */
              crossPlatformExclusive: z.boolean().default(false),
            }),
          )
          .default([]),
      }),
    )
    .default({
      meituan: {
        enabled: true,
        appId: 'com.sankuai.meituan',
        priceToleranceYuan: 1.0,
        strategies: [
          {
            id: 'meituan-shenquan',
            kind: 'membership',
            name: '美团神券 满30减5',
            condition: { minSpend: 30 },
            discount: { type: 'fixed', amount: 5 },
            autoApplied: true,
            quota: { dailyLimit: null, monthlyLimit: null, totalQuota: null, lastUsedAt: null },
            crossPlatformExclusive: false,
          },
          {
            id: 'cmb-wednesday',
            kind: 'credit_card',
            name: '招商银行 周三满50减10',
            condition: { minSpend: 50, weekday: 'wednesday' },
            discount: { type: 'fixed', amount: 10 },
            autoApplied: false,
            quota: { dailyLimit: 1, monthlyLimit: 4, totalQuota: null, lastUsedAt: null },
            exclusiveGroup: 'meituan-pay-activity',
            crossPlatformExclusive: false,
          },
        ],
      },
      eleme: {
        enabled: true,
        appId: 'me.ele',
        priceToleranceYuan: 1.0,
        strategies: [
          {
            id: 'eleme-cmb-wednesday',
            kind: 'credit_card',
            name: '招商银行 周三满50减10',
            condition: { minSpend: 50, weekday: 'wednesday' },
            discount: { type: 'fixed', amount: 10 },
            autoApplied: false,
            quota: { dailyLimit: 1, monthlyLimit: 4, totalQuota: null, lastUsedAt: null },
            exclusiveGroup: 'eleme-pay-activity',
            crossPlatformExclusive: false,
          },
        ],
      },
    }),
})

/** 校验后的配置输出类型。 */
export type AppConfig = ReturnType<typeof Config>
