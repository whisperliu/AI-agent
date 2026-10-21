/**
 * Plugin configuration schema (schemastery). See PLAN §4.2 / §5.1.
 * Shape mirrors `cordis.patch.yml`; validated at load time (fail-fast on bad config).
 *
 * P1: replaced by the full schema (per-platform strategies, quota, OCR, TTL…).
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  device: z.object({
    driver: z.union([z.const('mock'), z.const('adb')]).default('mock'),
    serial: z.string().default('auto'),
  }),
  task: z.object({
    stepTimeoutMs: z.natural().default(8000),
    pageTimeoutMs: z.natural().default(20000),
    taskTimeoutMs: z.natural().default(90000),
    idempotencyTtlMinutes: z.natural().default(30),
  }),
  evidence: z.object({
    ttlMinutes: z.natural().default(10),
    retainMax: z.natural().default(50),
  }),
  ocr: z.object({
    enabled: z.boolean().default(false),
  }),
  platforms: z
    .dict(
      z.object({
        enabled: z.boolean().default(false),
        appId: z.string(),
        priceToleranceYuan: z.number().default(1.0),
      }),
    )
    .default({}),
})
