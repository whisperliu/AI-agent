/**
 * device-p2.test.ts — P2 真机通道离线测试（不依赖真机）。
 * 覆盖：uiautomator XML 解析 / 能力探测 / 页面识别 / 弹窗与验证码拦截 /
 * adb 驱动（注入假 runner）：连接与自动重连、dump、tap 坐标+安全护栏、截屏、能力探测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  centerOf,
  countResourceIds,
  countTextNodes,
  findBySelector,
  parseBounds,
  parseUiNodes,
  visibleTexts,
} from '../src/device/uixml.ts'
import { analyzeDump, isValidPng, parseForeground, parseWmSize } from '../src/device/probe.ts'
import { classifyObstruction, assertNoHumanRequired, recoverOnce } from '../src/device/recover.ts'
import { detectPage } from '../src/device/pageDetect.ts'
import { createAdbDriver, type AdbRunner } from '../src/device/adb.ts'
import { createMockDriver } from '../src/device/mock.ts'
import { MOCK_SETTLE_PAGES } from '../src/device/mock-data.ts'
import { waitForState } from '../src/device/steps.ts'
import { NeedsHumanError, StateAssertionError, ForbiddenActionError } from '../src/core/errors.ts'
import type { Driver } from '../src/device/driver.ts'

const FIX = join(import.meta.dirname, 'fixtures')
const settleXml = await readFile(join(FIX, 'meituan-settle.real.xml'), 'utf8')
const captchaXml = await readFile(join(FIX, 'captcha.xml'), 'utf8')
const upgradeXml = await readFile(join(FIX, 'upgrade-popup.xml'), 'utf8')
const homeXml = await readFile(join(FIX, 'home.real.xml'), 'utf8')

// ── uixml ──────────────────────────────────────────────
test('parseUiNodes: reads resource-id/text/bounds/clickable', () => {
  const nodes = parseUiNodes(settleXml)
  assert.ok(nodes.length >= 8)
  const payable = nodes.find((n) => n.resourceId === 'com.sankuai.meituan:id/payable')!
  assert.ok(payable.text?.includes('26.90'))
  assert.deepEqual(payable.bounds, [740, 2200, 1040, 2280])
  const submit = nodes.find((n) => n.resourceId === 'com.sankuai.meituan:id/submit_order_btn')!
  assert.equal(submit.clickable, true)
})

test('parseBounds / centerOf', () => {
  assert.deepEqual(parseBounds('[100,200][300,400]'), [100, 200, 300, 400])
  assert.equal(parseBounds('garbage'), undefined)
  assert.deepEqual(centerOf([0, 0, 100, 200]), { x: 50, y: 100 })
})

test('findBySelector prefers resourceId then text', () => {
  const nodes = parseUiNodes(settleXml)
  assert.ok(findBySelector(nodes, { resourceId: 'com.sankuai.meituan:id/payable' }))
  assert.ok(findBySelector(nodes, { text: '确认订单' }))
  assert.equal(findBySelector(nodes, { text: '不存在的文案' }), undefined)
})

test('countTextNodes / countResourceIds / visibleTexts', () => {
  const nodes = parseUiNodes(settleXml)
  assert.ok(countTextNodes(nodes) >= 8)
  assert.ok(countResourceIds(nodes) >= 8)
  assert.ok(visibleTexts(nodes).some((t) => t.includes('实付')))
})

// ── probe ──────────────────────────────────────────────
test('analyzeDump: rich native tree recommends tree', () => {
  const q = analyzeDump(settleXml)
  assert.equal(q.recommend, 'tree')
  assert.ok(q.treeRichness > 0.2)
  assert.equal(q.hasWebview, false)
})

test('analyzeDump: empty shell (webview) recommends ocr/human', () => {
  const webview = `<hierarchy><node class="android.webkit.WebView" resource-id="" text="" bounds="[0,0][100,100]"/></hierarchy>`
  const q = analyzeDump(webview)
  assert.notEqual(q.recommend, 'tree')
  assert.equal(q.hasWebview, true)
  const empty = analyzeDump('<hierarchy></hierarchy>')
  assert.equal(empty.recommend, 'human')
})

test('isValidPng / parseWmSize / parseForeground', () => {
  assert.equal(isValidPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), true)
  assert.equal(isValidPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), false)
  assert.equal(parseWmSize('Physical size: 1080x2400'), '1080x2400')
  assert.equal(parseWmSize('Override size: 720x1600\nPhysical size: 1080x2400'), '720x1600')
  assert.equal(
    parseForeground(
      '  mCurrentFocus=Window{1 u0 com.sankuai.meituan/com.sankuai.meituan.MainActivity}',
    ),
    'com.sankuai.meituan',
  )
})

// ── recover / red-line ─────────────────────────────────
test('classifyObstruction: captcha / upgrade / none', () => {
  assert.equal(classifyObstruction(captchaXml).kind, 'captcha')
  assert.equal(classifyObstruction(upgradeXml).kind, 'upgrade')
  assert.equal(classifyObstruction(settleXml).kind, 'none')
  assert.equal(classifyObstruction(homeXml).kind, 'none')
})

test('assertNoHumanRequired: captcha throws NeedsHumanError (red-line 2)', () => {
  assert.throws(() => assertNoHumanRequired(captchaXml), NeedsHumanError)
  assert.doesNotThrow(() => assertNoHumanRequired(settleXml))
})

test('recoverOnce: upgrades popup tapped, captcha never tapped', async () => {
  const taps: unknown[] = []
  const seq = [upgradeXml, settleXml]
  let i = 0
  const driver: Driver = {
    async dump() {
      return seq[Math.min(i++, seq.length - 1)]!
    },
    async tap(sel) {
      taps.push(sel)
      i = seq.length - 1
    },
    async input() {},
    async swipe() {},
    async screencap() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    },
  }
  const r = await recoverOnce(driver, upgradeXml, { waitMs: 1 })
  assert.equal(r.recovered, true)
  assert.equal(taps.length >= 1, true)

  const capDriver: Driver = {
    async dump() {
      return captchaXml
    },
    async tap(sel) {
      taps.push(sel)
    },
    async input() {},
    async swipe() {},
    async screencap() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    },
  }
  await assert.rejects(() => recoverOnce(capDriver, captchaXml, { waitMs: 1 }), NeedsHumanError)
})

// ── pageDetect ─────────────────────────────────────────
test('detectPage: settle vs home vs unknown', () => {
  const contracts = [
    { page: 'home', anchors: [{ text: '搜索' }, { text: '首页' }] },
    { page: 'settle', anchors: [{ resourceId: 'com.sankuai.meituan:id/payable' }] },
  ]
  assert.equal(detectPage(settleXml, contracts).page, 'settle')
  assert.equal(detectPage(homeXml, contracts).page, 'home')
  assert.equal(detectPage('<hierarchy></hierarchy>', contracts).page, 'unknown')
})

// ── adb driver with injected runner ────────────────────
function pngBytes(): Uint8Array {
  // 最小合法 PNG 头（8 字节魔数 + 占位）
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
}

interface FakeAdbState {
  devices: { serial: string; state: string }[]
  calls: string[][]
  dumpXml: string
  onPull?: (localPath: string) => Promise<void>
}

function fakeAdbRunner(state: FakeAdbState): AdbRunner {
  return async (argv) => {
    state.calls.push(argv)
    // strip leading -s <serial>
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    const head = a[0]
    if (head === 'devices') {
      const lines = [
        'List of devices attached',
        ...state.devices.map((d) => `${d.serial}\t${d.state}`),
      ]
      return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' }
    }
    if (head === 'connect') {
      // simulate successful wireless connect
      state.devices = [{ serial: a[1]!, state: 'device' }]
      return { code: 0, stdout: `connected to ${a[1]}`, stderr: '' }
    }
    if (head === 'exec-out' && a[1] === 'uiautomator') {
      return { code: 0, stdout: state.dumpXml, stderr: '' }
    }
    if (head === 'exec-out' && a[1] === 'cat') {
      return { code: 0, stdout: state.dumpXml, stderr: '' }
    }
    if (head === 'shell' && a[1] === 'uiautomator') {
      return { code: 0, stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml', stderr: '' }
    }
    if (head === 'shell' && a[1] === 'wm' && a[2] === 'size') {
      return { code: 0, stdout: 'Physical size: 1080x2400', stderr: '' }
    }
    if (head === 'shell' && a[1] === 'wm' && a[2] === 'density') {
      return { code: 0, stdout: 'Physical density: 440', stderr: '' }
    }
    if (head === 'shell' && a[1] === 'dumpsys') {
      return {
        code: 0,
        stdout: '  mCurrentFocus=Window{1 u0 com.sankuai.meituan/com.sankuai.meituan.MainActivity}',
        stderr: '',
      }
    }
    if (head === 'shell' && a[1] === 'getprop') {
      return { code: 0, stdout: a[2] === 'ro.product.model' ? 'Pixel-Test\n' : '14\n', stderr: '' }
    }
    if (head === 'shell' && a[1] === 'input') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (head === 'shell' && a[1] === 'screencap') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (head === 'pull') {
      const local = a[2]!
      if (state.onPull) await state.onPull(local)
      return { code: 0, stdout: 'pulled', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

test('adb driver: disables animations on connect and retries dump on idle failure', async () => {
  const calls: string[][] = []
  let dumpAttempts = 0
  const runner: AdbRunner = async (argv) => {
    calls.push(argv)
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    if (a[0] === 'devices')
      return { code: 0, stdout: 'List of devices attached\n1.1.1.1:5555\tdevice\n', stderr: '' }
    // 前两次 dump 报 could not get idle（模拟动画），第三次成功
    if (a[0] === 'exec-out' && a[1] === 'uiautomator') {
      dumpAttempts++
      return dumpAttempts >= 3
        ? { code: 0, stdout: settleXml, stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: could not get idle state.' }
    }
    if (a[0] === 'shell' && a[1] === 'uiautomator')
      return { code: 1, stdout: '', stderr: 'ERROR: could not get idle state.' }
    if (a[0] === 'exec-out' && a[1] === 'cat') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '1.1.1.1:5555', runner })
  const xml = await d.dump()
  assert.ok(xml.includes('<hierarchy'))
  // 连接后应关闭三项动画
  const flat = calls.map((c) => c.join(' '))
  assert.ok(flat.some((c) => c.includes('settings put global window_animation_scale 0')))
  assert.ok(flat.some((c) => c.includes('animator_duration_scale 0')))
  assert.ok(dumpAttempts >= 3, 'should retry dump until idle succeeds')
})

test('adb driver: unicode input temporarily switches IME, broadcasts text, then restores IME', async () => {
  const calls: string[][] = []
  const runner: AdbRunner = async (argv) => {
    calls.push(argv)
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    if (a[0] === 'devices')
      return { code: 0, stdout: 'List of devices attached\n1.1.1.1:5555\tdevice\n', stderr: '' }
    if (a[0] === 'shell' && a[1] === 'settings' && a[2] === 'get')
      return {
        code: 0,
        stdout: 'com.sohu.inputmethod.sogou.oem/com.sohu.inputmethod.sogou.SogouIME\n',
        stderr: '',
      }
    // uiautomator dump for tap() focus
    if (a[0] === 'exec-out' && a[1] === 'uiautomator')
      return { code: 0, stdout: settleXml, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({
    serial: '1.1.1.1:5555',
    runner,
    unicodeIme: 'com.android.adbkeyboard/.AdbIME',
  })
  await d.input({ resourceId: 'com.sankuai.meituan:id/payable' }, '香叶烤鸭饭')
  const flat = calls.map((c) => c.join(' '))
  assert.ok(flat.some((c) => c.includes('ime enable com.android.adbkeyboard')))
  assert.ok(flat.some((c) => c.includes('ime set com.android.adbkeyboard')))
  assert.ok(flat.some((c) => c.includes('ADB_INPUT_TEXT') && c.includes('香叶烤鸭饭')))
  // 末尾必须切回原输入法
  assert.ok(flat.some((c) => c.includes('ime set com.sohu.inputmethod.sogou.oem')))
  assert.ok(!flat.some((c) => c.includes('input text')), 'must not use input text for unicode')
})

test('adb driver: falls back to --compressed dump when standard dump is empty (real heavy page)', async () => {
  // 模拟：标准 dump 与 /dev/tty 均为空，只有 --compressed 产物有效（美团搜索结果页实测）。
  const state: FakeAdbState = {
    devices: [{ serial: '192.168.1.8:5555', state: 'device' }],
    calls: [],
    dumpXml: settleXml,
  }
  const runner: AdbRunner = async (argv) => {
    state.calls.push(argv)
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    const head = a[0]
    if (head === 'devices')
      return { code: 0, stdout: 'List of devices attached\n192.168.1.8:5555\tdevice\n', stderr: '' }
    if (head === 'exec-out' && a[1] === 'uiautomator')
      return { code: 0, stdout: 'Killed\n', stderr: '' }
    if (head === 'shell' && a[1] === 'uiautomator') {
      // 标准 dump 报拿不到 idle；--compressed 成功（真机重页面实测）。
      if (a.includes('--compressed'))
        return { code: 0, stdout: 'UI hierchary dumped to: /sdcard/window_dump_c.xml', stderr: '' }
      return { code: 0, stdout: 'ERROR: could not get idle state.', stderr: '' }
    }
    if (head === 'exec-out' && a[1] === 'cat') {
      // 标准落盘为空；--compressed 落盘有效
      const target = a[2] ?? ''
      return { code: 0, stdout: target.includes('_c.xml') ? settleXml : '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '192.168.1.8:5555', runner })
  const xml = await d.dump()
  assert.ok(xml.includes('<hierarchy'))
  assert.ok(
    state.calls.some((c) => c.includes('--compressed')),
    'should attempt --compressed fallback',
  )
})

test('adb driver: auto selects unique device then dumps', async () => {
  const state: FakeAdbState = {
    devices: [{ serial: '192.168.1.8:5555', state: 'device' }],
    calls: [],
    dumpXml: settleXml,
  }
  const d = createAdbDriver({ serial: 'auto', runner: fakeAdbRunner(state) })
  await d.ensureConnected()
  assert.equal(d.serial, '192.168.1.8:5555')
  const xml = await d.dump()
  assert.ok(xml.includes('<hierarchy'))
})

test('adb driver: reconnect once when wireless serial was offline', async () => {
  const state: FakeAdbState = { devices: [], calls: [], dumpXml: settleXml }
  const d = createAdbDriver({ serial: '192.168.1.8:5555', runner: fakeAdbRunner(state) })
  await d.ensureConnected() // empty devices → connect → device
  assert.equal(
    state.calls.some((c) => c[0] === 'connect'),
    true,
  )
  assert.equal(
    state.calls.some((c) => c[0] === 'connect' && c[1] === '192.168.1.8:5555'),
    true,
  )
})

test('adb driver: reconnect fails → readable error', async () => {
  const state: FakeAdbState = { devices: [], calls: [], dumpXml: settleXml }
  const runner: AdbRunner = async (argv) => {
    state.calls.push(argv)
    const a = argv[0] === '-s' ? argv.slice(2) : argv
    if (a[0] === 'devices') return { code: 0, stdout: 'List of devices attached\n', stderr: '' }
    if (a[0] === 'connect')
      return { code: 0, stdout: 'failed to connect', stderr: 'failed to connect' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '10.0.0.2:5555', runner })
  await assert.rejects(() => d.ensureConnected(), /自动重连失败|无线调试/)
})

test('adb driver: tap computes center coordinates and issues input tap', async () => {
  const state: FakeAdbState = {
    devices: [{ serial: 'dev1', state: 'device' }],
    calls: [],
    dumpXml: settleXml,
  }
  const d = createAdbDriver({ serial: 'dev1', runner: fakeAdbRunner(state) })
  await d.tap({ resourceId: 'com.sankuai.meituan:id/payable' })
  // payable bounds [740,2200][1040,2280] → center (890, 2240)
  const tapCall = state.calls.find((c) => c.includes('input') && c.includes('tap'))
  assert.ok(tapCall, 'issued input tap')
  // argv: shell input tap <x> <y>
  assert.deepEqual(tapCall!.slice(-2), ['890', '2240'])
})

test('adb driver: tap on order/payment is blocked before any adb call (red-line 1)', async () => {
  const state: FakeAdbState = {
    devices: [{ serial: 'dev1', state: 'device' }],
    calls: [],
    dumpXml: settleXml,
  }
  const d = createAdbDriver({ serial: 'dev1', runner: fakeAdbRunner(state) })
  await assert.rejects(() => d.tap({ text: '提交订单' }), ForbiddenActionError)
  // 不应产生任何 input tap 调用
  assert.equal(
    state.calls.some((c) => c.includes('input') && c.includes('tap')),
    false,
  )
})

test('adb driver: screencap pulls binary via file (not utf8)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'adb-shot-'))
  try {
    const state: FakeAdbState = {
      devices: [{ serial: 'dev1', state: 'device' }],
      calls: [],
      dumpXml: settleXml,
      onPull: async (local: string) => {
        await writeFile(local, pngBytes())
      },
    }
    const d = createAdbDriver({ serial: 'dev1', runner: fakeAdbRunner(state), tmpDir: tmp })
    const bytes = await d.screencap()
    assert.equal(isValidPng(bytes), true)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('adb driver: probe reports capabilities', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'adb-probe-'))
  try {
    const state: FakeAdbState = {
      devices: [{ serial: 'dev1', state: 'device' }],
      calls: [],
      dumpXml: settleXml,
      onPull: async (local: string) => {
        await writeFile(local, pngBytes())
      },
    }
    const d = createAdbDriver({ serial: 'dev1', runner: fakeAdbRunner(state), tmpDir: tmp })
    const p = await d.probe()
    assert.equal(p.canDump, true)
    assert.equal(p.canScreenshot, true)
    assert.equal(p.resolution, '1080x2400')
    assert.equal(p.foreground, 'com.sankuai.meituan')
    assert.equal(p.model, 'Pixel-Test')
    assert.equal(p.androidVersion, '14')
    assert.equal(p.quality.recommend, 'tree')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// ── steps: action+assert+recover / evidence ────────────
test('waitForState: passes through upgrade popup then satisfies', async () => {
  const d = createMockDriver({ settlePages: { meituan: upgradeXml } })
  // mock driver dump 恒为 activePlatform 的页面；这里自定义一个可变的驱动更贴近真实。
  let phase = 0
  const driver: Driver = {
    async dump() {
      phase++
      return phase === 1 ? upgradeXml : settleXml
    },
    async tap() {
      phase = 1
    },
    async input() {},
    async swipe() {},
    async screencap() {
      return pngBytes()
    },
  }
  const xml = await waitForState(
    driver,
    { presentResourceIds: ['com.sankuai.meituan:id/payable'] },
    { timeoutMs: 2000, pollMs: 5, evidenceDir: undefined },
  )
  assert.ok(xml.includes('payable'))
  void d
})

test('waitForState: captcha → NeedsHumanError (red-line 2)', async () => {
  const driver: Driver = {
    async dump() {
      return captchaXml
    },
    async tap() {},
    async input() {},
    async swipe() {},
    async screencap() {
      return pngBytes()
    },
  }
  await assert.rejects(
    () =>
      waitForState(
        driver,
        { presentResourceIds: ['com.sankuai.meituan:id/payable'] },
        { timeoutMs: 500, pollMs: 5 },
      ),
    NeedsHumanError,
  )
})

test('waitForState: timeout writes dump evidence and throws StateAssertionError', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'evidence-'))
  try {
    const driver: Driver = {
      async dump() {
        return homeXml
      },
      async tap() {},
      async input() {},
      async swipe() {},
      async screencap() {
        return pngBytes()
      },
    }
    let err: unknown
    try {
      await waitForState(
        driver,
        { presentResourceIds: ['com.sankuai.meituan:id/payable'] },
        {
          timeoutMs: 60,
          pollMs: 10,
          evidenceDir: tmp,
          evidenceName: 'settle',
          evidenceRedact: false,
        },
      )
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof StateAssertionError)
    const dumpPath = (err as StateAssertionError).dumpPath
    assert.ok(dumpPath && dumpPath.endsWith('.xml'))
    assert.ok((await readFile(dumpPath!, 'utf8')).includes('<hierarchy'))
    assert.ok((err as StateAssertionError).screenshotPath?.endsWith('.png'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// 确保 MOCK_SETTLE_PAGES 未被本测试污染（引用一次以便类型）
void MOCK_SETTLE_PAGES

// ── task-level probe / selfCheck (tool actions) ────────
test('dispatch probe/selfCheck on mock driver → supported:false', async () => {
  const { makeEnv } = await import('./p1-env.ts')
  const { dispatch } = await import('../src/tools/price-agent.ts')
  const env = await makeEnv()
  try {
    const p = await dispatch(env.deps, { action: 'probe' })
    assert.equal(p.action, 'probe')
    if (p.action === 'probe') {
      assert.equal(p.reply.supported, false)
      assert.match(p.reply.message ?? '', /Mock/)
    }
    const s = await dispatch(env.deps, { action: 'selfCheck' })
    assert.equal(s.action, 'selfCheck')
    if (s.action === 'selfCheck') assert.equal(s.reply.supported, false)
  } finally {
    await env.cleanup()
  }
})

test('probeDevice / runMinExperiment with adb driver (fake runner)', async () => {
  const { makeEnv } = await import('./p1-env.ts')
  const { probeDevice, runMinExperiment } = await import('../src/task/lifecycle.ts')
  const tmp = await mkdtemp(join(tmpdir(), 'adb-task-'))
  const env = await makeEnv()
  try {
    const state: FakeAdbState = {
      devices: [{ serial: 'dev1', state: 'device' }],
      calls: [],
      dumpXml: settleXml,
      onPull: async (local: string) => {
        await writeFile(local, pngBytes())
      },
    }
    env.deps.driver = createAdbDriver({
      serial: 'dev1',
      runner: fakeAdbRunner(state),
      tmpDir: tmp,
    })
    const probe = await probeDevice(env.deps)
    assert.equal(probe.supported, true)
    assert.equal(probe.probe?.canDump, true)
    assert.equal(probe.probe?.resolution, '1080x2400')

    const min = await runMinExperiment(env.deps)
    assert.equal(min.supported, true)
    assert.equal(min.ok, true)
    assert.ok(min.checks.every((c) => c.ok))
  } finally {
    await env.cleanup()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('adb driver: falls back to learned mDNS serial when configured host:port is dead (P5)', async () => {
  // 配置的旧 host:port 已失效，但 mDNS 实例名在线（真机手机重启后端口变化的真实情形）。
  const calls: string[][] = []
  const mdns = 'adb-HA26JA4H-Qwlhvj._adb-tls-connect._tcp'
  const runner: AdbRunner = async (argv) => {
    calls.push(argv)
    const a = argv[0] === '-s' ? argv.slice(2) : argv
    if (a[0] === 'devices') {
      // 第一次：旧 host:port 不在；mDNS 通道在线
      return {
        code: 0,
        stdout: `List of devices attached\n${mdns}\tdevice\n`,
        stderr: '',
      }
    }
    if (a[0] === 'connect') {
      return { code: 0, stdout: '', stderr: 'failed to connect: Connection refused' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '192.168.3.44:44881', runner })
  await d.ensureConnected()
  // 应改用 mDNS 串号（并在后续命令带 -s 该串号）
  assert.equal(d.serial, mdns)
})

test('adb driver: discovers current mDNS port when configured host:port is dead (P5)', async () => {
  const calls: string[][] = []
  let connected = ''
  const runner: AdbRunner = async (argv) => {
    calls.push(argv)
    const a = argv[0] === '-s' ? argv.slice(2) : argv
    if (a[0] === 'devices') {
      const body = connected
        ? `List of devices attached\n${connected}\tdevice\n`
        : 'List of devices attached\n'
      return { code: 0, stdout: body, stderr: '' }
    }
    if (a[0] === 'mdns' && a[1] === 'services') {
      return {
        code: 0,
        stdout:
          'List of discovered mdns services\nadb-XYZ\t_adb-tls-connect._tcp\t192.168.3.44:37289\n',
        stderr: '',
      }
    }
    if (a[0] === 'connect') {
      connected = a[1] === '192.168.3.44:37289' ? a[1]! : ''
      return { code: 0, stdout: connected ? 'connected' : '', stderr: connected ? '' : 'refused' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '192.168.3.44:44881', runner })
  await d.ensureConnected()
  assert.equal(d.serial, '192.168.3.44:37289')
})

test('adb driver: stale dump file is NOT trusted when dump reports could not get idle (P5 regression)', async () => {
  // 真机踩坑：店铺页标准 dump 失败时**不覆盖**旧文件，直接 cat 会读到上一页（搜索结果），
  // 导致后续锚点全部误判。必须校验命令成功且先删旧文件；失败则走 --compressed。
  const state: FakeAdbState = {
    devices: [{ serial: '192.168.1.8:5555', state: 'device' }],
    calls: [],
    dumpXml: settleXml,
  }
  const runner: AdbRunner = async (argv) => {
    state.calls.push(argv)
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    const head = a[0]
    if (head === 'devices')
      return { code: 0, stdout: 'List of devices attached\n192.168.1.8:5555\tdevice\n', stderr: '' }
    if (head === 'shell' && a[1] === 'rm') return { code: 0, stdout: '', stderr: '' }
    if (head === 'shell' && a[1] === 'uiautomator') {
      if (a.includes('--compressed'))
        return { code: 0, stdout: 'UI hierchary dumped to: /sdcard/window_dump_c.xml', stderr: '' }
      return { code: 0, stdout: '', stderr: 'ERROR: could not get idle state.' }
    }
    if (head === 'exec-out' && a[1] === 'cat') {
      const target = a[2] ?? ''
      // 关键：标准文件里残留**上一页**的旧内容（含 OLD_PAGE 标记）
      if (target.includes('window_dump.xml'))
        return { code: 0, stdout: '<hierarchy><node text="OLD_PAGE"/></hierarchy>', stderr: '' }
      return { code: 0, stdout: settleXml, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '192.168.1.8:5555', runner })
  const xml = await d.dump()
  assert.ok(!xml.includes('OLD_PAGE'), 'must not return stale previous-page dump')
  assert.ok(xml.includes('<hierarchy'))
  // 必须真的先删了旧文件（防陈旧的第一道保险）
  assert.ok(
    state.calls.some((c) => c.includes('rm')),
    'should rm stale dump before dumping',
  )
})

// ── P5: 窗口几何 / 坐标映射 / 分屏守卫 ──────────────────────────
test('parseWindowGeometry: floating/split window uses focused window mBounds (PC mode)', async () => {
  const { parseWindowGeometry, parseFocusToken, sliceWindowBlock } =
    await import('../src/device/probe.ts')
  const displays = 'winConfig={ mBounds=Rect(0, 0 - 2560, 1600) }'
  const windowDump = 'mCurrentFocus=Window{d3d2a47 u0 com.sankuai.meituan/com.yoda.activity.Yoda}'
  const windows = [
    '  Window #42 Window{aaaaaaa u0 com.other}',
    '    mFullConfiguration={winConfig={ mBounds=Rect(0, 0 - 800, 600) }}',
    '  Window #43 Window{d3d2a47 u0 com.sankuai.meituan/com.yoda.activity.Yoda}:',
    '    mFullConfiguration={1.0 ... winConfig={ mBounds=Rect(1281, 0 - 2560, 1600) ... mWindowingMode=multi-window ... }}',
    '  Window #44 Window{bbbbbbb u0 com.sankuai.meituan/SearchActivity}:',
    '    mFullConfiguration={1.0 ... winConfig={ mBounds=Rect(0, 0 - 1279, 1600) ...}}',
  ].join('\n')
  const token = parseFocusToken(windowDump)
  assert.equal(token, 'd3d2a47')
  const block = sliceWindowBlock(windows, token!)
  assert.ok(block && block.includes('mBounds=Rect(1281, 0 - 2560, 1600)'))
  const geo = parseWindowGeometry(displays, block!)
  assert.ok(geo)
  assert.equal(geo!.appX, 1281)
  assert.equal(geo!.appW, 1279)
  assert.equal(geo!.multiWindow, true)
})

test('parseWindowGeometry: fullscreen single window → multiWindow false', async () => {
  const { parseWindowGeometry } = await import('../src/device/probe.ts')
  const displays = 'winConfig={ mBounds=Rect(0, 0 - 2560, 1600) }'
  const block =
    'mFullConfiguration={winConfig={ mBounds=Rect(0, 0 - 2560, 1600) mWindowingMode=fullscreen }}'
  const geo = parseWindowGeometry(displays, block)
  assert.ok(geo)
  assert.equal(geo!.multiWindow, false)
  assert.equal(geo!.appX, 0)
})

test('parseWindowGeometry: letterbox (portrait app on landscape screen) flagged, not multiWindow', async () => {
  const { parseWindowGeometry } = await import('../src/device/probe.ts')
  const displays = 'winConfig={ mBounds=Rect(0, 0 - 2560, 1600) }'
  const block =
    'mFullConfiguration={winConfig={ mBounds=Rect(641, 0 - 1920, 1600) mWindowingMode=fullscreen mAreBoundsLetterboxed=true }}'
  const geo = parseWindowGeometry(displays, block)
  assert.ok(geo)
  assert.equal(geo!.appX, 641)
  assert.equal(geo!.multiWindow, false)
  assert.equal(geo!.letterboxed, true)
})

test('toScreenPoint: window-local dump coords get window offset', async () => {
  const { toScreenPoint } = await import('../src/device/probe.ts')
  const geo = {
    screenW: 2560,
    screenH: 1600,
    appX: 641,
    appY: 0,
    appW: 1279,
    appH: 1600,
    multiWindow: false,
    letterboxed: true,
  }
  // dump 只有窗口内坐标（上限 ~1279）→ 必须加偏移，点 (1281,231) 才命中。
  assert.deepEqual(toScreenPoint(geo, 640, 231, { maxRight: 1251, maxBottom: 1600 }), {
    x: 1281,
    y: 231,
  })
})

test('toScreenPoint: already-screen-space dump coords are NOT offset twice', async () => {
  const { toScreenPoint } = await import('../src/device/probe.ts')
  const geo = {
    screenW: 2560,
    screenH: 1600,
    appX: 1281,
    appY: 0,
    appW: 1279,
    appH: 1600,
    multiWindow: true,
    letterboxed: false,
  }
  // 真机踩坑：dump 已是屏幕坐标（bounds 上限 1251+1281=2532）→ 原样返回。
  assert.deepEqual(toScreenPoint(geo, 1921, 231, { maxRight: 2532, maxBottom: 1600 }), {
    x: 1921,
    y: 231,
  })
})

test('assertUsableWindow: split-screen → NeedsHumanError(environment); fullscreen passes', async () => {
  const { assertUsableWindow } = await import('../src/platform/navigator.ts')
  const split = {
    geometry: async () => ({
      screenW: 2560,
      screenH: 1600,
      appX: 1281,
      appY: 0,
      appW: 1279,
      appH: 1600,
      multiWindow: true,
    }),
  } as unknown as Driver
  await assert.rejects(
    () => assertUsableWindow(split),
    (e: unknown) => {
      assert.ok(e instanceof NeedsHumanError)
      assert.equal((e as NeedsHumanError).reason, 'environment')
      return true
    },
  )
  const ok = {
    geometry: async () => ({
      screenW: 1600,
      screenH: 2560,
      appX: 0,
      appY: 0,
      appW: 1600,
      appH: 2560,
      multiWindow: false,
    }),
  } as unknown as Driver
  await assertUsableWindow(ok) // 不抛
  // Mock（无 geometry 能力）→ 跳过
  await assertUsableWindow({} as unknown as Driver)
})

// ── 掉线硬超时（回归：设备中途掉线不得让任务无限挂起）──────────────
test('adb driver: hung adb command (device dropped) rejects via stepTimeout, does not hang forever', async () => {
  // 模拟无线调试中途掉线：adb 命令一直不返回，只在被 abort 时才结束（真实 adb 卡住的行为）。
  const runner: AdbRunner = (argv, signal) => {
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    if (a[0] === 'devices')
      return Promise.resolve({
        code: 0,
        stdout: 'List of devices attached\n1.1.1.1:5555\tdevice\n',
        stderr: '',
      })
    // 其余命令（如 uiautomator dump / screencap）挂起，仅在 abort 时 reject。
    return new Promise((_resolve, reject) => {
      const onAbort = () => reject(new Error('aborted (device offline)'))
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
  const d = createAdbDriver({
    serial: '1.1.1.1:5555',
    runner,
    stepTimeoutMs: 120,
    disableAnimations: false,
  })
  const t0 = Date.now()
  // dump 内层单独 120ms 超时 × 4 次重试 + 3×500ms 退避 ≈ 2s 内必须失败，绝不可无限挂起。
  await assert.rejects(
    () => d.dump(),
    (e: Error) => /timeout|超时/.test(e.message),
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 4000, `应在有限时间内失败（实际 ${elapsed}ms）`)
})

test('adb driver: stepTimeout wraps every command including screencap', async () => {
  let abortables = 0
  const runner: AdbRunner = (argv, signal) => {
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    if (a[0] === 'devices')
      return Promise.resolve({
        code: 0,
        stdout: 'List of devices attached\n1.1.1.1:5555\tdevice\n',
        stderr: '',
      })
    abortables++
    return new Promise((_r, reject) => {
      if (signal)
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  const d = createAdbDriver({
    serial: '1.1.1.1:5555',
    runner,
    stepTimeoutMs: 80,
    disableAnimations: false,
  })
  await assert.rejects(() => d.screencap(), /timeout|超时/)
  assert.ok(abortables >= 1, 'screencap 命令应被摘时中止')
})

test('adb driver: 动画页面 dump 永不 idle 时，向上滚动后重试可解锁（2026-10-27 真机）', async () => {
  // 真机实测：美团店铺页有持续动图（KTV banner/视频）时，标准/压缩/--windows 全报
  // `could not get idle state` 且**一次也不产文件**；向上滚动让动图离开视口后 dump 才成功。
  let scrolled = false
  let dumpCalls = 0
  const calls: string[][] = []
  const runner: AdbRunner = async (argv) => {
    calls.push(argv)
    let a = argv.slice()
    if (a[0] === '-s') a = a.slice(2)
    if (a[0] === 'devices')
      return { code: 0, stdout: 'List of devices attached\n1.1.1.1:5555\tdevice\n', stderr: '' }
    if (a[0] === 'shell' && a[1] === 'input' && a[2] === 'swipe') {
      scrolled = true
      return { code: 0, stdout: '', stderr: '' }
    }
    if (a[0] === 'shell' && a[1] === 'uiautomator') {
      dumpCalls++
      // 滚动前一律报错、且不产文件；滚动后才成功
      return scrolled
        ? { code: 0, stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml', stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: could not get idle state.' }
    }
    if (a[0] === 'exec-out' && a[1] === 'cat')
      return { code: 0, stdout: scrolled ? settleXml : '', stderr: '' }
    if (a[0] === 'exec-out' && a[1] === 'uiautomator')
      return { code: 1, stdout: '', stderr: 'ERROR: could not get idle state.' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const d = createAdbDriver({ serial: '1.1.1.1:5555', runner })
  const xml = await d.dump()
  assert.ok(xml.includes('<hierarchy'))
  assert.ok(scrolled, '应在 dump 全败后向上滚动一次解锁')
  assert.ok(dumpCalls >= 5, '滚动后应重新尝试 dump')
  assert.ok(
    calls.some((c) => c.join(' ').includes('input swipe')),
    '应发出滚动指令',
  )
})
