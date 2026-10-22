/**
 * device/adb.ts — adb 真机实现骨架（P2 完善）。
 * 层：capability。**必须**通过 `runNativeCommand('adb', ...)` 执行，禁止自写 spawn/超时（§2.2）。
 *
 * P1 只在 mock 模式下运行；本文件保留接口形状，真机命令在 P2 落地。
 * 为避免在未安装 `@deepseek-ai/dsh-native-command` 的测试环境里静态解析失败，
 * 该依赖在函数体内**动态导入**（运行时 DSH 必然存在）。
 */
import { assertTapSafe } from '../core/safety.ts'
import type { Driver, UiSelector } from './driver.ts'

export interface AdbDriverOptions {
  serial: string
  /** 每步超时（毫秒）。 */
  stepTimeoutMs?: number
}

interface NativeCommandModule {
  runNativeCommand: (
    file: string,
    argv: string[],
    signal: AbortSignal | undefined,
    mode: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>
}

async function loadNativeCommand(): Promise<NativeCommandModule> {
  const spec = '@deepseek-ai/dsh-native-command'
  const mod = (await import(spec)) as unknown as NativeCommandModule
  return mod
}

/** 创建 adb 驱动（P2）。当前抛错提示仅支持 Mock。 */
export function createAdbDriver(opts: AdbDriverOptions): Driver {
  const serial = opts.serial
  const run = async (argv: string[]): Promise<string> => {
    const { runNativeCommand } = await loadNativeCommand()
    const r = await runNativeCommand('adb', ['-s', serial, ...argv], undefined, 'hidden')
    if (r.code !== 0) throw new Error(`adb exited ${r.code}: ${r.stderr.trim()}`)
    return r.stdout
  }
  return {
    async dump() {
      return run(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
    },
    async tap(sel: UiSelector) {
      assertTapSafe(sel)
      // P2: 由 uiautomator dump 解析坐标后 `input tap x y`
      throw new Error(`adb.tap not implemented in P1 (selector=${JSON.stringify(sel)})`)
    },
    async input(sel: UiSelector, text: string) {
      void sel
      void text
      throw new Error('adb.input not implemented in P1')
    },
    async swipe(dir) {
      void dir
      throw new Error('adb.swipe not implemented in P1')
    },
    async screencap() {
      const out = await run(['exec-out', 'screencap', '-p'])
      return new Uint8Array(Buffer.from(out, 'binary'))
    },
  }
}
