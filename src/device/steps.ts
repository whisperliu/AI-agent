/**
 * device/steps.ts — "动作 + 断言 + 超时 + 恢复" 的执行原语（§3.5.1）。
 * 层：capability（device）。杜绝"点一下睡 2 秒再点"的盲等：每次动作后必须断言到位；
 * 断言失败**先尝试弹窗恢复**，仍失败则**截图 + dump 留证**并抛 StateAssertionError。
 *
 * 红线：dump 中命中验证码/登录 → `NeedsHumanError`（不硬闯，AGENTS.md §0）。
 */
import { NeedsHumanError, StateAssertionError } from '../core/errors.ts'
import { captureEvidence } from './capture.ts'
import type { Driver, UiSelector } from './driver.ts'
import { classifyObstruction, recoverOnce } from './recover.ts'
import { assertState, type StateAssertion } from './state.ts'

export interface StepOptions {
  /** 每步硬超时（毫秒，默认 8000，§3.5.3 超时预算）。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
  /** 证据目录（失败时 dump/截图落此）。 */
  evidenceDir?: string
  /** 证据文件名前缀（如 quoteId / step 名）。 */
  evidenceName?: string
  /** 取消信号。 */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT = 8000
const DEFAULT_POLL = 400

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 轮询 dump 直到满足断言（含干扰恢复）。返回满足断言的 dump。
 * 超时 → 取证并抛 StateAssertionError；命中验证码/登录 → NeedsHumanError。
 */
export async function waitForState(
  driver: Driver,
  expect: StateAssertion,
  opts: StepOptions = {},
): Promise<string> {
  return waitForAnyState(driver, [expect], opts)
}

/**
 * 轮询直到**任一**断言满足（OR 语义，用于"页面 anchor 多选一"）。
 * 与 `waitForState` 共用同一套干扰恢复 / 验证码拦截 / 失败取证逻辑，避免重复实现。
 */
export async function waitForAnyState(
  driver: Driver,
  alternatives: StateAssertion[],
  opts: StepOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const pollMs = opts.pollMs ?? DEFAULT_POLL
  const started = Date.now()
  let last = ''
  let lastErr: unknown

  while (Date.now() - started < timeoutMs) {
    ensureNotAborted(opts.signal)
    let xml: string
    try {
      xml = await driver.dump()
    } catch (err) {
      // dump 失败（如掉线）在超时预算内重试一次。
      lastErr = err
      await sleep(pollMs)
      continue
    }
    last = xml

    // 先处理干扰：验证码/登录直接抛出；升级/广告/定位/加载尝试恢复。
    const obs = classifyObstruction(xml)
    if (obs.kind === 'captcha' || obs.kind === 'login') {
      // 取证后再抛，便于用户看到当时界面。
      await safeCapture(driver, opts, 'needs-human')
      throw new NeedsHumanError(obs.kind === 'captcha' ? 'captcha' : 'login')
    }
    if (obs.kind !== 'none') {
      const r = await recoverOnce(driver, xml, { loadingTimeoutMs: Math.min(timeoutMs, 5000) })
      xml = r.dump
      last = xml
      if (r.kind === 'captcha') throw new NeedsHumanError('captcha')
      if (r.kind === 'login') throw new NeedsHumanError('login')
    }

    let matched = false
    for (const alt of alternatives) {
      try {
        assertState(xml, alt)
        matched = true
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (matched) return xml
    await sleep(pollMs)
  }

  const ev = await safeCapture(driver, opts, 'state-fail')
  const detail =
    lastErr instanceof StateAssertionError
      ? lastErr.message
      : `state not reached within ${timeoutMs}ms`
  throw new StateAssertionError(
    `${detail}（last dump ${last.length} bytes）`,
    ev.dumpPath,
    ev.screenshotPath,
  )
}

/** 点击某控件后断言进入预期状态（动作 + 断言，§3.5.1）。 */
export async function tapAndExpect(
  driver: Driver,
  sel: UiSelector,
  expect: StateAssertion,
  opts: StepOptions = {},
): Promise<string> {
  ensureNotAborted(opts.signal)
  await driver.tap(sel) // 内部已过 assertTapSafe（红线 1）
  return waitForState(driver, expect, opts)
}

/** 输入文本后断言（用于搜索框，§3.5.1）。 */
export async function inputAndExpect(
  driver: Driver,
  sel: UiSelector,
  text: string,
  expect: StateAssertion,
  opts: StepOptions = {},
): Promise<string> {
  ensureNotAborted(opts.signal)
  await driver.input(sel, text)
  return waitForState(driver, expect, opts)
}

/** 前进一屏（用于菜单滚动）并断言。 */
export async function swipeAndExpect(
  driver: Driver,
  dir: 'up' | 'down',
  expect: StateAssertion,
  opts: StepOptions = {},
): Promise<string> {
  ensureNotAborted(opts.signal)
  await driver.swipe(dir)
  return waitForState(driver, expect, opts)
}

async function safeCapture(
  driver: Driver,
  opts: StepOptions,
  suffix: string,
): Promise<{ dumpPath?: string; screenshotPath?: string }> {
  if (!opts.evidenceDir) return {}
  const name = `${opts.evidenceName ?? 'step'}-${suffix}-${Date.now()}`
  return captureEvidence(driver, opts.evidenceDir, name)
}
