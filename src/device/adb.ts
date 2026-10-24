/**
 * device/adb.ts — adb 真机实现（P2）。
 * 层：capability。**必须**通过 `runNativeCommand('adb', ...)` 执行，禁止自写 spawn/超时（§2.2）。
 *
 * 设计要点：
 *  - 所有 adb 调用走注入的 `AdbRunner`（默认 runNativeCommand），测试可注入假执行器离线回放。
 *  - 每次动作前 `ensureConnected()`：`adb devices` 探活，掉线自动 `adb connect` 重连一次（§8.3）。
 *  - 二进制（截图）**不经 utf8 解码**：`shell screencap` 落盘 → `adb pull` 到本地临时文件 → 读回字节。
 *  - 点击前必过 `assertTapSafe`（AGENTS.md §0 红线 1）；dump 后可经 `ensureNoHumanRequired` 拦验证码/登录。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertTapSafe } from '../core/safety.ts'
import { StateAssertionError } from '../core/errors.ts'
import type { Driver, UiSelector } from './driver.ts'
import { assertNoHumanRequired } from './recover.ts'
import { centerOf, findBySelector, nodesAtPoint, parseUiNodes, pickNodeAtPoint } from './uixml.ts'
import type { DeviceProbe } from './probe.ts'
import { analyzeDump, isValidPng, parseForeground, parseWmSize } from './probe.ts'

export interface AdbExecResult {
  code: number
  stdout: string
  stderr: string
}

/** 一道 adb 命令边界（argv 已含 `-s <serial>`；由 runner 决定是否走真实进程）。 */
export type AdbRunner = (argv: string[], signal?: AbortSignal) => Promise<AdbExecResult>

export interface AdbDriverOptions {
  /** `auto`（自动选唯一在线设备）或 `host:port` / 设备序列号。 */
  serial: string
  /** adb 可执行文件（默认 `adb`，走 PATH）。 */
  adbPath?: string
  /** 每步超时（毫秒，仅文档语义；真实取消走 signal）。 */
  stepTimeoutMs?: number
  /** 截图临时目录（默认系统临时目录下 price-agent-adb）。 */
  tmpDir?: string
  /** 注入执行器（测试用）；缺省用 runNativeCommand。 */
  runner?: AdbRunner
  /** 掉线时自动重连一次（§8.3）。 */
  autoReconnect?: boolean
  /**
   * 中文/Unicode 输入辅助 IME 的组件名（如 ADBKeyboard 的 `com.android.adbkeyboard/.AdbIME`）。
   * 提供时：input() 会**临时切到该 IME → ADB_INPUT_TEXT 广播注入 → 切回原 IME**，
   * 解决 `input text 中文` 在第三方输入法下 NPE/不落框的问题。缺省则走 `input text`。
   */
  unicodeIme?: string
  /**
   * 连接后把系统动画三项 scale 置 0（默认 true）。真机实测：持续动画会让
   * `uiautomator dump` 反复报 `could not get idle state`，导致任何页面都读不到。
   * 关闭动画后 dump 立即稳定（测试自动化惯例，不涉及任何风控绕过）。
   */
  disableAnimations?: boolean
}

/** `Driver` + P2 额外能力（连接管理 / 能力探测）。 */
export interface AdbDriver extends Driver {
  /** 当前解析到的设备序列号。 */
  readonly serial: string
  /** 确保设备在线（探活 + 掉线重连一次）。 */
  ensureConnected(signal?: AbortSignal): Promise<void>
  /** 能力探测（§3.5.4）。 */
  probe(signal?: AbortSignal): Promise<DeviceProbe>
}

const DEFAULT_ADB = 'adb'

/** 默认执行器：动态导入 runNativeCommand（避免测试环境静态解析失败）。 */
function defaultRunner(adbPath: string): AdbRunner {
  return async (argv, signal) => {
    const spec = '@deepseek-ai/dsh-native-command'
    const mod = (await import(spec)) as unknown as {
      runNativeCommand: (
        file: string,
        argv: readonly string[],
        signal: AbortSignal | undefined,
        window: 'hidden' | 'visible',
      ) => Promise<{ stdout: string; stderr: string }>
    }
    try {
      const r = await mod.runNativeCommand(adbPath, argv, signal, 'hidden')
      return { code: 0, stdout: r.stdout, stderr: r.stderr }
    } catch (err) {
      const e = err as {
        code?: number | string
        stdout?: string
        stderr?: string
        message?: string
      }
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
      }
    }
  }
}

/** 创建 adb 驱动。 */
export function createAdbDriver(opts: AdbDriverOptions): AdbDriver {
  const adbPath = opts.adbPath ?? DEFAULT_ADB
  const run = opts.runner ?? defaultRunner(adbPath)
  const autoReconnect = opts.autoReconnect ?? true
  const unicodeIme = opts.unicodeIme
  const disableAnimations = opts.disableAnimations ?? true
  let animationsDisabled = false
  const tmpDir = opts.tmpDir ?? join(tmpdir(), 'price-agent-adb')
  const allowAuto = opts.serial === 'auto' || opts.serial === ''
  const GLOBAL_CMDS = new Set([
    'devices',
    'connect',
    'disconnect',
    'start-server',
    'kill-server',
    'version',
    'pair',
  ])

  let resolvedSerial: string | undefined = allowAuto ? undefined : opts.serial
  /** 从 mDNS 学到的无线调试实例名（仅作重连候选，不改配置）。 */
  let mdnsSerial: string | undefined

  /** 执行 `adb <argv>`（自动前置 `-s <serial>`，全局命令除外）。 */
  async function adb(argv: string[], signal?: AbortSignal): Promise<AdbExecResult> {
    const needSerial = resolvedSerial && !GLOBAL_CMDS.has(argv[0] ?? '')
    return run(needSerial ? ['-s', resolvedSerial!, ...argv] : argv, signal)
  }

  async function listDevices(signal?: AbortSignal): Promise<{ serial: string; state: string }[]> {
    const r = await run(['devices'], signal)
    if (r.code !== 0) throw new Error(`adb devices 失败：${r.stderr.trim() || r.code}`)
    const out: { serial: string; state: string }[] = []
    for (const line of r.stdout.split('\n')) {
      const m = /^([^\s]+)\s+(device|offline|unauthorized)$/.exec(line.trim())
      if (m) out.push({ serial: m[1]!, state: m[2]! })
    }
    return out
  }

  /**
   * 无线调试地址发现（P5 真机掉线收口）：address（`host:port`）与 mDNS 实例名（含 `_adb-tls-connect`）
   * 是**不同**的 adb 传输通道。用户曾配了旧 `host:port`，手机重启后端口变化即连不上；
   * 但 mDNS 实例名往往仍在线。这里按 `adb devices` 从已连通道里学回，作为重连候选（不写配置）。
   */
  function learnMdnsSerial(devices: { serial: string; state: string }[]): void {
    if (mdnsSerial) return
    const hit = devices.find(
      (d) => d.state === 'device' && d.serial.includes('._adb-tls-connect._tcp'),
    )
    if (hit) mdnsSerial = hit.serial
  }

  function looksNetworkSerial(s: string): boolean {
    return /^[\w.-]+:\d+$/.test(s)
  }

  /**
   * 主动探 mDNS 无线调试地址（P5 真机掉线收口）：解析 `adb mdns services` 的
   * `name _adb-tls-connect._tcp host:port`，返回可 `adb connect` 的地址（优先 host:port）。
   * 手机重启后端口会变，配置里的旧 `host:port` 失效；mDNS 能拿到当前端口。
   */
  async function discoverMdnsAddress(signal?: AbortSignal): Promise<string | undefined> {
    const r = await run(['mdns', 'services'], signal)
    if (r.code !== 0) return undefined
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      // 形如: adb-XXXX  _adb-tls-connect._tcp  192.168.3.44:37289
      const addr = parts.find((p) => /^[\w.-]+:\d+$/.test(p))
      if (addr && parts.some((p) => p.includes('_adb-tls-connect._tcp'))) return addr
    }
    return undefined
  }

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    const devices = await listDevices(signal)
    learnMdnsSerial(devices)
    if (resolvedSerial) {
      if (devices.some((x) => x.serial === resolvedSerial && x.state === 'device')) {
        await maybeDisableAnimations(signal)
        return
      }
    } else {
      const online = devices.filter((d) => d.state === 'device')
      if (online.length === 1) {
        resolvedSerial = online[0]!.serial
        await maybeDisableAnimations(signal)
        return
      }
      if (online.length > 1) {
        throw new Error(
          `检测到多台设备（${online.map((d) => d.serial).join(', ')}），请在配置 device.serial 指定其一`,
        )
      }
    }

    // 掉线：若是网络地址，尝试 connect 重连一次（§8.3）。
    // 重连候选顺序：① 配置的 host:port；② 学到的 mDNS 实例名（手机重启后端口变化时更稳）。
    if (autoReconnect && resolvedSerial && looksNetworkSerial(resolvedSerial)) {
      const candidates = [resolvedSerial, ...(mdnsSerial ? [mdnsSerial] : [])]
      let lastStderr = ''
      for (const cand of candidates) {
        const c = await run(['connect', cand], signal)
        lastStderr = c.stderr.trim()
        const again = await listDevices(signal)
        if (again.some((d) => d.serial === cand && d.state === 'device')) {
          resolvedSerial = cand
          await maybeDisableAnimations(signal)
          return
        }
      }
      // 若 mDNS 通道其实已在线（adb 自动发现的），直接采用。
      const now = await listDevices(signal)
      learnMdnsSerial(now)
      if (mdnsSerial && now.some((d) => d.serial === mdnsSerial && d.state === 'device')) {
        resolvedSerial = mdnsSerial
        await maybeDisableAnimations(signal)
        return
      }
      // 最后兜底：主动探 mDNS 当前端口（手机重启后旧 host:port 必然失效）。
      const discovered = await discoverMdnsAddress(signal)
      if (discovered) {
        await run(['connect', discovered], signal)
        const after = await listDevices(signal)
        if (after.some((d) => d.serial === discovered && d.state === 'device')) {
          resolvedSerial = discovered
          await maybeDisableAnimations(signal)
          return
        }
      }
      throw new Error(
        `设备未连接且自动重连失败（${resolvedSerial}）：${lastStderr || 'adb connect 未成功'}。` +
          '请确认手机无线调试开启、与电脑同网段、端口为当前值。',
      )
    }

    if (allowAuto) {
      throw new Error(
        '未检测到在线 Android 设备（adb devices 为空）。请开启无线调试并 adb connect。',
      )
    }
    throw new Error(
      `设备 ${resolvedSerial} 不在线（offline/未授权）。请检查无线调试与授权弹窗后重试。`,
    )
  }

  async function maybeDisableAnimations(signal?: AbortSignal): Promise<void> {
    if (!disableAnimations || animationsDisabled) return
    animationsDisabled = true
    for (const k of [
      'window_animation_scale',
      'transition_animation_scale',
      'animator_duration_scale',
    ]) {
      try {
        await adb(['shell', 'settings', 'put', 'global', k, '0'], signal)
      } catch {
        // 忽略：部分设备/权限下可能失败，不影响 dump 重试兜底。
      }
    }
  }

  async function dumpOnce(signal?: AbortSignal): Promise<string> {
    // 1) 直出 /dev/tty
    try {
      const r = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], signal)
      if (r.code === 0 && r.stdout.includes('<hierarchy')) return r.stdout
    } catch {
      /* fallthrough */
    }
    // 2) 落盘标准 dump 再 cat
    const remote = '/sdcard/window_dump.xml'
    const d = await adb(['shell', 'uiautomator', 'dump', remote], signal)
    const c = await adb(['exec-out', 'cat', remote], signal)
    if (c.stdout.includes('<hierarchy')) return c.stdout
    // 3) 兜底 --compressed（重页面标准 dump 会被系统 Killed）
    const remoteC = '/sdcard/window_dump_c.xml'
    const dc = await adb(['shell', 'uiautomator', 'dump', '--compressed', remoteC], signal)
    const cc = await adb(['exec-out', 'cat', remoteC], signal)
    if (cc.stdout.includes('<hierarchy')) return cc.stdout
    const err = (dc.stderr || d.stderr || '').trim()
    throw new Error(`uiautomator dump 输出不含 hierarchy（可能被系统限制）：${err}`)
  }

  async function dump(signal?: AbortSignal): Promise<string> {
    await ensureConnected(signal)
    // 真机 dump 会因页面持续动画报 `could not get idle state`；重试数次通常可成功（实测第 3 次）。
    let lastErr: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await dumpOnce(signal)
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async function tap(sel: UiSelector, signal?: AbortSignal): Promise<void> {
    // 红线 1：点击前强制安全护栏（命中下单/支付即抛 ForbiddenActionError）。
    assertTapSafe(sel)
    const xml = await dump(signal)
    const node = findBySelector(parseUiNodes(xml), sel)
    if (!node?.bounds) {
      throw new StateAssertionError(`tap 目标未找到或无 bounds: ${JSON.stringify(sel)}`)
    }
    const { x, y } = centerOf(node.bounds)
    const r = await adb(['shell', 'input', 'tap', String(x), String(y)], signal)
    if (r.code !== 0) throw new Error(`input tap 失败：${r.stderr.trim()}`)
  }

  /**
   * 按屏幕坐标点击（安全）：先 dump 解析该点命中的**最小**节点，把它的全部文本/desc/id 过
   * `assertTapSafe`（命中订单/支付即拒绝），再 `input tap`。用于无稳定 id/文案、只能几何定位的场景。
   */
  async function tapPoint(x: number, y: number, signal?: AbortSignal): Promise<void> {
    const xml = await dump(signal)
    const nodes = parseUiNodes(xml)
    const hit = pickNodeAtPoint(nodes, x, y)
    if (hit) {
      const hay = `${hit.text ?? ''} ${hit.label ?? ''} ${hit.resourceId ?? ''}`
      assertTapSafe({ text: hit.text, label: hit.label, resourceId: hit.resourceId })
      // 再兜底扫一遍该点覆盖到的所有节点，避免容器标错漏检支付文案。
      for (const n of nodesAtPoint(nodes, x, y)) {
        assertTapSafe({ text: n.text, label: n.label, resourceId: n.resourceId })
      }
      void hay
    }
    const r = await adb(
      ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
      signal,
    )
    if (r.code !== 0) throw new Error(`input tap 失败：${r.stderr.trim()}`)
  }

  async function input(sel: UiSelector, text: string, signal?: AbortSignal): Promise<void> {
    await tap(sel, signal) // 先聚焦输入框
    if (text && unicodeIme) {
      // Unicode 输入：临时切 IME → 广播注入 → 切回原 IME。
      const cur = await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'], signal)
      const prev = (cur.stdout || '').trim()
      try {
        await adb(['shell', 'ime', 'enable', unicodeIme], signal)
        await adb(['shell', 'ime', 'set', unicodeIme], signal)
        await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_TEXT', '--es', 'msg', text], signal)
      } finally {
        if (prev && prev !== unicodeIme) await adb(['shell', 'ime', 'set', prev], signal)
      }
      return
    }
    const escaped = text.replace(/ /g, '%s').replace(/([\\'"&<>|;$`()])/g, '\\$1')
    const r = await adb(['shell', 'input', 'text', escaped], signal)
    if (r.code !== 0) throw new Error(`input text 失败：${r.stderr.trim()}`)
  }

  async function screenSize(signal?: AbortSignal): Promise<{ w: number; h: number }> {
    const r = await adb(['shell', 'wm', 'size'], signal)
    const res = parseWmSize(r.stdout) ?? '1080x2400'
    const [w, h] = res.split('x').map((n) => Number.parseInt(n, 10))
    return { w: w || 1080, h: h || 2400 }
  }

  async function swipe(dir: 'up' | 'down', signal?: AbortSignal): Promise<void> {
    const { w, h } = await screenSize(signal)
    const cx = Math.round(w / 2)
    const top = Math.round(h * 0.3)
    const bottom = Math.round(h * 0.7)
    const [y1, y2] = dir === 'up' ? [bottom, top] : [top, bottom]
    const r = await adb(
      ['shell', 'input', 'swipe', String(cx), String(y1), String(cx), String(y2), '300'],
      signal,
    )
    if (r.code !== 0) throw new Error(`input swipe 失败：${r.stderr.trim()}`)
  }

  async function screencap(signal?: AbortSignal): Promise<Uint8Array> {
    await ensureConnected(signal)
    await mkdir(tmpDir, { recursive: true })
    const remote = '/sdcard/price_agent_shot.png'
    const local = join(tmpDir, `shot-${Date.now()}.png`)
    const s = await adb(['shell', 'screencap', '-p', remote], signal)
    if (s.code !== 0) throw new Error(`screencap 失败：${s.stderr.trim()}`)
    const p = await adb(['pull', remote, local], signal)
    if (p.code !== 0) throw new Error(`screencap pull 失败：${p.stderr.trim()}`)
    const bytes = new Uint8Array(await readFile(local))
    if (!isValidPng(bytes)) throw new Error('截图不是有效 PNG（可能被系统拦截）')
    return bytes
  }

  async function getprop(key: string, signal?: AbortSignal): Promise<string | undefined> {
    const r = await adb(['shell', 'getprop', key], signal)
    const v = r.stdout.trim()
    return v || undefined
  }

  async function probe(signal?: AbortSignal): Promise<DeviceProbe> {
    await ensureConnected(signal)
    const t0 = Date.now()
    let canDump = true
    let xml = ''
    try {
      xml = await dump(signal)
    } catch {
      canDump = false
    }
    const dumpLatencyMs = Date.now() - t0

    const wmSize = await adb(['shell', 'wm', 'size'], signal).catch(() => emptyResult())
    const wmDensity = await adb(['shell', 'wm', 'density'], signal).catch(() => emptyResult())
    const dumpsys = await adb(['shell', 'dumpsys', 'window'], signal).catch(() => emptyResult())

    let canScreenshot = true
    try {
      await screencap(signal)
    } catch {
      canScreenshot = false
    }

    return {
      canDump,
      dumpLatencyMs,
      resolution: parseWmSize(wmSize.stdout),
      density: /(\d+)/.exec(wmDensity.stdout)?.[1],
      foreground: parseForeground(dumpsys.stdout),
      quality: analyzeDump(xml),
      canScreenshot,
      model: await getprop('ro.product.model', signal),
      androidVersion: await getprop('ro.build.version.release', signal),
    }
  }

  return {
    get serial() {
      return resolvedSerial ?? opts.serial
    },
    ensureConnected,
    probe,
    dump,
    tap,
    tapPoint,
    input,
    swipe,
    screencap,
  }
}

function emptyResult(): AdbExecResult {
  return { code: 1, stdout: '', stderr: '' }
}

/** 从 dump 识别需人工（验证码/登录即抛；供上层每步复用）。 */
export function ensureNoHumanRequired(dump: string): void {
  assertNoHumanRequired(dump)
}
