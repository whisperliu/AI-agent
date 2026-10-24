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
import { centerOf, findBySelector, parseUiNodes } from './uixml.ts'
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

  function looksNetworkSerial(s: string): boolean {
    return /^[\w.-]+:\d+$/.test(s)
  }

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    const devices = await listDevices(signal)
    if (resolvedSerial) {
      if (devices.some((x) => x.serial === resolvedSerial && x.state === 'device')) return
    } else {
      const online = devices.filter((d) => d.state === 'device')
      if (online.length === 1) {
        resolvedSerial = online[0]!.serial
        return
      }
      if (online.length > 1) {
        throw new Error(
          `检测到多台设备（${online.map((d) => d.serial).join(', ')}），请在配置 device.serial 指定其一`,
        )
      }
    }

    // 掉线：若是网络地址，尝试 connect 重连一次（§8.3）。
    if (autoReconnect && resolvedSerial && looksNetworkSerial(resolvedSerial)) {
      const c = await run(['connect', resolvedSerial], signal)
      const again = await listDevices(signal)
      if (again.some((d) => d.serial === resolvedSerial && d.state === 'device')) return
      throw new Error(
        `设备未连接且自动重连失败（${resolvedSerial}）：${c.stderr.trim() || 'adb connect 未成功'}。` +
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

  async function dump(signal?: AbortSignal): Promise<string> {
    await ensureConnected(signal)
    // 1) 直出到 /dev/tty（低开销，多数页面可用）。
    const r = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], signal)
    if (r.code === 0 && r.stdout.includes('<hierarchy')) return r.stdout

    // 2) 落盘标准 dump 再 cat。
    const remote = '/sdcard/window_dump.xml'
    const d = await adb(['shell', 'uiautomator', 'dump', remote], signal)
    const c = await adb(['exec-out', 'cat', remote], signal)
    if (c.stdout.includes('<hierarchy')) return c.stdout

    // 3) 兜底 --compressed：真机重页面（如美团搜索结果）标准 dump 进程会被系统 Killed，
    //    落盘 0 字节；--compressed 体积更小、可稳定产出（属性保留 resource-id/text/bounds/clickable）。
    const remoteC = '/sdcard/window_dump_c.xml'
    const dc = await adb(['shell', 'uiautomator', 'dump', '--compressed', remoteC], signal)
    const cc = await adb(['exec-out', 'cat', remoteC], signal)
    if (cc.stdout.includes('<hierarchy')) return cc.stdout

    const err = (dc.stderr || d.stderr || r.stderr || '').trim()
    throw new Error(`uiautomator dump 输出不含 hierarchy（可能被系统限制）：${err}`)
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

  async function input(sel: UiSelector, text: string, signal?: AbortSignal): Promise<void> {
    await tap(sel, signal) // 先聚焦输入框
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
