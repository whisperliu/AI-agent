/**
 * ocrNavFlow.test.ts — 饿了么 canvas **OCR 盲导航全流程**离线回放（P6 收尾）。
 *
 * 背景：`runElemeOcrNav`（首页→搜索→选店→选规格→去结算→读实付）此前只有各原语的单测，
 * **整条走查没有被离线回放覆盖**——真机是唯一验证手段，设备离线时改这段代码等于"盲改"。
 * 这里用一个按序返回 OCR 帧的假驱动回放整条链路，钉住三件事：
 *   1) 正常链路能走到结算页并读出 payable，且各步动作（launch/输入/提交/加购/去结算）都对；
 *   2) **加购只点一次**（红线：加购非幂等，多点会误加多道菜）；
 *   3) 验证码/拼单页 → `NeedsHumanError` **立即上抛、不整条重试**（红线：验证码即停）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runElemeOcrNav } from '../src/platform/elemeReal.ts'
import { NeedsHumanError } from '../src/core/errors.ts'
import type { Ocr, OcrWord } from '../src/ocr/reader.ts'
import type { Driver } from '../src/device/driver.ts'
import type { ComparisonConditions } from '../src/price/model.ts'

function w(t: string, x: number, y: number, ww = 80, hh = 30, c = 0.9): OcrWord {
  return { t, c, bbox: { x, y, w: ww, h: hh } }
}

const cond: ComparisonConditions = {
  snapshotId: 's',
  item: '小炒肉木桶饭',
  qty: 1,
  spec: [],
  composition: [],
  deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
  fixedAt: '2026-10-27T00:00:00+08:00',
  hash: 'h',
}

interface Recorded {
  launch: string[]
  taps: { x: number; y: number }[]
  texts: string[]
  keys: number[]
}

/** 按序返回 OCR 帧的假 OCR + 记录动作的假驱动。帧耗尽后重复最后一帧。 */
function makeFake(frames: OcrWord[][]) {
  let i = 0
  let reads = 0
  const rec: Recorded = { launch: [], taps: [], texts: [], keys: [] }
  const ocr: Ocr = {
    read: async () => {
      reads++
      const words = frames[Math.min(i, frames.length - 1)]!
      i++
      return { text: words.map((x) => x.t).join(''), words }
    },
  }
  const driver = {
    async screencap() {
      return new Uint8Array([1, 2, 3])
    },
    async dump() {
      return '<hierarchy></hierarchy>'
    },
    async tap() {},
    async input() {},
    async swipe() {},
    async launchApp(appId: string) {
      rec.launch.push(appId)
    },
    async tapPoint(x: number, y: number) {
      rec.taps.push({ x, y })
    },
    async inputText(t: string) {
      rec.texts.push(t)
    },
    async key(code: number) {
      rec.keys.push(code)
    },
  } as unknown as Driver
  return { ocr, driver, rec, reads: () => reads }
}

const sleep = async () => {}

test('OCR 盲导航全流程：首页→搜索→选店→选规格→去结算→读实付（可离线回放）', async () => {
  const HOME = [w('推荐', 100, 300), w('搜索', 700, 312, 200, 50)]
  const SEARCH = [w('历史搜索', 100, 200), w('搜索', 700, 120)]
  const RESULT = [w('销量', 60, 180), w('木桶饭', 300, 400)]
  const STORE = [w('点餐', 60, 920), w('¥30.98', 300, 955), w('选规格', 1470, 950, 120, 50)]
  const SPEC = [w('份量', 60, 877), w('辣度', 60, 1107), w('选好了', 800, 2432, 200, 60)]
  const CART = [w('去结算', 1453, 2432, 200, 60)]
  const SETTLE = [
    w('商品金额', 40, 1200),
    w('¥26.98', 1300, 1205),
    w('打包费', 40, 1300),
    w('¥1', 1320, 1305),
    w('配送费', 40, 1400),
    w('¥3', 1320, 1405),
    w('合计', 1100, 2400, 120, 50),
    w('¥30.98', 1240, 2405, 120, 50),
  ]
  // 顺序：首页(1) 搜索页(2) 结果页(3) 店铺页(4) 点选规格后 look(5) 规格弹窗(6) 购物车栏(7) 结算页(8)
  const { ocr, driver, rec } = makeFake([HOME, SEARCH, RESULT, STORE, STORE, SPEC, CART, SETTLE])

  const facts = await runElemeOcrNav(driver, ocr, cond, 1, sleep)

  // 读数：合计行最右 ¥30.98
  assert.equal(facts.payable, 30.98)
  assert.ok(facts.screenshot) // 结算页截屏已绑定

  // 动作：强制拉起 App、注入搜索词、ENTER 提交
  assert.deepEqual(rec.launch, ['me.ele'])
  assert.deepEqual(rec.texts, [cond.item])
  assert.deepEqual(rec.keys, [66])

  // 坐标点按顺序：搜索框→输入框→第一家店→选规格→选好了→去结算
  assert.equal(rec.taps.length, 6)
  assert.deepEqual(rec.taps[0], { x: 800, y: 312 })
  assert.deepEqual(rec.taps[1], { x: 735, y: 128 })
  assert.deepEqual(rec.taps[2], { x: 342, y: 400 })
  assert.equal(rec.taps[3]!.x, 1490) // 选规格
  assert.deepEqual(rec.taps[4], { x: 800, y: 2432 }) // 选好了
  assert.deepEqual(rec.taps[5], { x: 1453, y: 2432 }) // 去结算
  // 红线：加购（选规格）**只点一次**
  assert.equal(rec.taps.filter((t) => t.x === 1490).length, 1)
})

test('验证码页 → NeedsHumanError 立即上抛，绝不整条重试', async () => {
  const CAPTCHA = [w('请拖动下方滑块完成拼图', 10, 10)]
  const { ocr, driver, reads } = makeFake([CAPTCHA])
  await assert.rejects(
    () => runElemeOcrNav(driver, ocr, cond, 3, sleep),
    (e: unknown) => e instanceof NeedsHumanError && e.reason === 'captcha',
  )
  // 只读了 1 帧即停：attempts=3 也不会继续重试
  assert.equal(reads(), 1)
})

test('店铺页是「拼单详情」→ NeedsHumanError 立即上抛（不盲点、不重试）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  const GROUP = [w('点餐', 60, 920), w('邀请好友', 800, 350), w('取消拼单', 1500, 185)]
  const { ocr, driver, rec, reads } = makeFake([HOME, SEARCH, RESULT, GROUP])
  await assert.rejects(
    () => runElemeOcrNav(driver, ocr, cond, 3, sleep),
    (e: unknown) => e instanceof NeedsHumanError && /拼单/.test(String(e.hint ?? '')),
  )
  // 4 帧读完即停（首页/搜索/结果/店铺页），没有因 attempts=3 而重跑
  assert.equal(reads(), 4)
  // 拼单页守卫在「选规格」之前触发：没有任何 tapPoint 落在加购按钮上
  assert.equal(rec.taps.filter((t) => t.x === 1490).length, 0)
})

test('瞬时故障（非红线）→ 整条重试，下一次成功即返回', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  const STORE = [w('点餐', 60, 920), w('选规格', 1470, 950, 120, 50)]
  const SPEC = [w('份量', 60, 877), w('选好了', 800, 2432, 200, 60)]
  const CART = [w('去结算', 1453, 2432, 200, 60)]
  const SETTLE = [w('合计', 1100, 2400, 120, 50), w('¥30.98', 1240, 2405, 120, 50)]
  const { ocr, driver } = makeFake([HOME, SEARCH, RESULT, STORE, STORE, SPEC, CART, SETTLE])

  // 第一次 launchApp 抛瞬时错误（如 adb 抖动），第二次成功
  let launches = 0
  const flaky = {
    ...driver,
    async launchApp() {
      launches++
      if (launches === 1) throw new Error('adb 命令超时 timeout（设备可能掉线）')
    },
  } as unknown as Driver

  const facts = await runElemeOcrNav(flaky, ocr, cond, 2, sleep)
  assert.equal(facts.payable, 30.98)
  assert.equal(launches, 2) // 整条重跑了一次
})
