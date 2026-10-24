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
import {
  analyzeDump,
  isValidPng,
  parseFocusToken,
  parseForeground,
  parseWmSize,
  parseWindowGeometry,
  sliceWindowBlock,
  toScreenPoint,
} from './probe.ts'
import type { WindowGeometry } from './probe.ts'

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
  /** 窗口几何（坐标映射/分屏判定用，P5）。 */
  geometry(signal?: AbortSignal): Promise<WindowGeometry | undefined>
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
  /** 是否已做过一次"等 daemon 发现无线设备"的预热。 */
  let warmupDone = false
  /** 缓存的窗口几何（P5）：dump bounds 是窗口内坐标，input 需要屏幕坐标，必须加偏移。 */
  let geometryCache: WindowGeometry | undefined
  let geometryAt = 0

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

  /**
   * 刚启动的 adb daemon 需要 1–2 秒才通过 mDNS 自动发现无线设备；单次 `adb devices`
   * 为空即判"离线"会误杀（真机实测：daemon 冷启动首查为空）。这里先 `adb mdns check`
   * 打开发现，再短轮询几帧，仍为空才继续重连逻辑。
   */
  async function warmupWait(devices: { serial: string; state: string }[], signal?: AbortSignal) {
    if (devices.some((d) => d.state === 'device')) return devices
    // 仅首个动作付一次"等 daemon 发现"的代价，避免每次动作都拖慢；
    // 注入 runner（离线测试）时不等待，保持测试确定性/速度。
    if (warmupDone || opts.runner) return devices
    warmupDone = true
    await run(['mdns', 'check'], signal).catch(() => undefined)
    let cur = devices
    for (let i = 0; i < 3; i++) {
      await sleep(500)
      cur = await listDevices(signal)
      if (cur.some((d) => d.state === 'device')) return cur
    }
    return cur
  }

  async function ensureConnected(signal?: AbortSignal): Promise<void> {
    let devices = await listDevices(signal)
    devices = await warmupWait(devices, signal)
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

  /**
   * 落盘式 dump（**必须防陈旧**）：重页面（店铺页/结果页）标准 dump 会报
   * `could not get idle state` 且**不覆盖**目标文件 —— 若直接 cat，会读到上一次的旧页面
   * （真机踩坑：店铺页读到搜索结果页内容，导致后续锚点全部误判）。
   * 因此：① 先删目标文件 ② 跑 dump ③ **校验命令真的成功**（输出含 `dumped to` 且无 ERROR）
   * ④ 才 cat。任一不满足 → 返回 undefined，交由上层换压缩模式/重试。
   */
  async function dumpToFile(
    remote: string,
    compressed: boolean,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    await adb(['shell', 'rm', '-f', remote], signal).catch(() => undefined)
    const args = ['shell', 'uiautomator', 'dump']
    if (compressed) args.push('--compressed')
    args.push(remote)
    const r = await adb(args, signal)
    const out = `${r.stdout}\n${r.stderr}`
    const ok =
      /dumped to/i.test(out) && !/could not get idle state|could not get idle|ERROR/i.test(out)
    if (!ok) return undefined
    const c = await adb(['exec-out', 'cat', remote], signal)
    return c.stdout.includes('<hierarchy') ? c.stdout : undefined
  }

  async function dumpOnce(signal?: AbortSignal): Promise<string> {
    // 1) 标准落盘 dump
    const std = await dumpToFile('/sdcard/window_dump.xml', false, signal)
    if (std) return std
    // 2) 兜底 --compressed（重页面标准 dump 被系统 Killed / 拿不到 idle）
    const comp = await dumpToFile('/sdcard/window_dump_c.xml', true, signal)
    if (comp) return comp
    // 3) 最后试 /dev/tty 直出（同样要求无 ERROR，避免误采陈旧输出）
    try {
      const r = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], signal)
      const out = `${r.stdout}\n${r.stderr}`
      if (
        !/could not get idle state|could not get idle|ERROR/i.test(out) &&
        r.stdout.includes('<hierarchy')
      ) {
        return r.stdout
      }
    } catch {
      /* fallthrough */
    }
    throw new Error('uiautomator dump 失败（标准与 --compressed 均未取得新鲜 hierarchy）')
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

  /**
   * 读取并缓存窗口几何（10s 有效）：用于把 dump 的窗口内坐标换算成屏幕坐标。
   * 拿不到就返回 undefined（按无偏移处理，保持旧行为）。
   */
  async function geometry(signal?: AbortSignal): Promise<WindowGeometry | undefined> {
    if (geometryCache && Date.now() - geometryAt < 10_000) return geometryCache
    // 屏幕真实尺寸：display 的 mBounds（注意 `wm size` 报的是物理值，横屏时方向不一致，不可用）。
    const disp = await adb(['shell', 'dumpsys', 'window', 'displays'], signal)
    // 聚焦窗口段：只有它能给出"dump 属于哪个窗口"的权威 bounds。
    const win = await adb(['shell', 'dumpsys', 'window'], signal)
    const token = parseFocusToken(win.stdout)
    let block: string | undefined
    if (token) {
      const all = await adb(['shell', 'dumpsys', 'window', 'windows'], signal)
      block = sliceWindowBlock(all.stdout, token)
    }
    const geo = block ? parseWindowGeometry(disp.stdout, block) : undefined
    if (geo) {
      geometryCache = geo
      geometryAt = Date.now()
    }
    return geo
  }

  /** dump 坐标 → 屏幕坐标（无几何信息时原样返回；坐标系统自动判定）。 */
  async function screenPoint(
    x: number,
    y: number,
    extent?: { maxRight?: number; maxBottom?: number },
    signal?: AbortSignal,
  ) {
    const geo = await geometry(signal)
    return geo ? toScreenPoint(geo, x, y, extent) : { x: Math.round(x), y: Math.round(y) }
  }

  /** 从节点集算 dump 坐标系的边界（判定"窗口内坐标 / 屏幕坐标"用）。 */
  function dumpExtent(nodes: { bounds?: [number, number, number, number] }[]) {
    let maxRight = 0
    let maxBottom = 0
    for (const n of nodes) {
      if (!n.bounds) continue
      if (n.bounds[2] > maxRight) maxRight = n.bounds[2]
      if (n.bounds[3] > maxBottom) maxBottom = n.bounds[3]
    }
    return { maxRight, maxBottom }
  }

  async function tap(sel: UiSelector, signal?: AbortSignal): Promise<void> {
    // 红线 1：点击前强制安全护栏（命中下单/支付即抛 ForbiddenActionError）。
    assertTapSafe(sel)
    const xml = await dump(signal)
    const node = findBySelector(parseUiNodes(xml), sel)
    if (!node?.bounds) {
      throw new StateAssertionError(`tap 目标未找到或无 bounds: ${JSON.stringify(sel)}`)
    }
    const c = centerOf(node.bounds)
    const { x, y } = await screenPoint(c.x, c.y, dumpExtent(parseUiNodes(xml)), signal)
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
    const sp = await screenPoint(x, y, dumpExtent(nodes), signal)
    const r = await adb(['shell', 'input', 'tap', String(sp.x), String(sp.y)], signal)
    if (r.code !== 0) throw new Error(`input tap 失败：${r.stderr.trim()}`)
  }

  /**
   * 把 App 拉到前台（等价用户点桌面图标；只启动，不做登录/授权/支付）。
   * 先试 LAUNCHER intent；失败退回 monkey。启动后短等，让首屏稳定。
   */
  async function launchApp(
    appId: string,
    opts: { force?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await ensureConnected(signal)
    // **优先按组件启动 launcher Activity**：`monkey`/LAUNCHER intent 只是把 App 现有任务提到前台，
    // 会**恢复到上次页面**（真机踩坑：停在搜索页 → 等首页必然超时）。`am start -n <MainActivity>`
    // 才会真正进入首页。
    const r = await adb(
      [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        appId,
      ],
      signal,
    )
    const component = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('/'))
      .pop()
    let started = false
    if (component) {
      // `-S` = 先 force-stop 再启动：真机实测这是唯一**稳定回到首页**的方式
      // （普通 start 只会把 App 现有任务提到前台，仍停在上次的搜索页/店铺页）。
      const argv = ['shell', 'am', 'start']
      if (opts.force) argv.push('-S')
      argv.push('-n', component)
      const s2 = await adb(argv, signal)
      started = s2.code === 0 && !/Error/i.test(`${s2.stdout}${s2.stderr}`)
    }
    if (!started) {
      // 兜底：monkey LAUNCHER（可能恢复到上次页面，后续 ensureHome 会再校正）。
      const m = await adb(
        ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'],
        signal,
      )
      const out = `${m.stdout}${m.stderr}`
      if (m.code !== 0 || /No activities found|monkey aborted|Error/i.test(out)) {
        throw new Error(`启动 App 失败（${appId}）：${out.trim() || '未找到可启动的 Activity'}`)
      }
    }
    await sleep(1500)
  }

  /** 系统返回键（KEYCODE_BACK=4）：仅用于导航回退。 */
  async function back(signal?: AbortSignal): Promise<void> {
    await adb(['shell', 'input', 'keyevent', '4'], signal)
  }

  /** 当前前台包名（读 dumpsys window 的 mCurrentFocus / mFocusedApp）。 */
  async function foreground(signal?: AbortSignal): Promise<string | undefined> {
    const r = await adb(['shell', 'dumpsys', 'window'], signal)
    return parseForeground(r.stdout)
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
    // 用**窗口几何**而不是 wm size：letterbox 下必须只在 App 窗口内滑动，否则滑到黑边无效。
    const geo = await geometry(signal)
    const bx = geo ? geo.appX : 0
    const by = geo ? geo.appY : 0
    const w = geo ? geo.appW : (await screenSize(signal)).w
    const h = geo ? geo.appH : (await screenSize(signal)).h
    const cx = Math.round(bx + w / 2)
    const top = Math.round(by + h * 0.3)
    const bottom = Math.round(by + h * 0.7)
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
      geometry: await geometry(signal),
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
    launchApp,
    foreground,
    back,
    geometry,
  }
}

function emptyResult(): AdbExecResult {
  return { code: 1, stdout: '', stderr: '' }
}

/** 从 dump 识别需人工（验证码/登录即抛；供上层每步复用）。 */
export function ensureNoHumanRequired(dump: string): void {
  assertNoHumanRequired(dump)
}
