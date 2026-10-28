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
import { createOcrNav } from '../src/platform/ocrNav.ts'
import { NeedsHumanError } from '../src/core/errors.ts'
import type { Ocr, OcrWord } from '../src/ocr/reader.ts'
import type { Driver } from '../src/device/driver.ts'
import type { ComparisonConditions } from '../src/price/model.ts'
import type { PlatformStrategy } from '../src/platform/types.ts'

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
  const STORE = [
    w('点餐', 60, 920),
    w('小炒肉木桶饭', 400, 950),
    w('¥30.98', 300, 955),
    w('选规格', 1470, 950, 120, 50),
  ]
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
  assert.equal(rec.taps[3]!.x, 1530) // 选规格
  assert.deepEqual(rec.taps[4], { x: 800, y: 2432 }) // 选好了
  assert.deepEqual(rec.taps[5], { x: 1453, y: 2432 }) // 去结算
  // 红线：加购（选规格）**只点一次**
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 1)
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
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 0)
})

test('瞬时故障（非红线）→ 整条重试，下一次成功即返回', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  const STORE = [w('点餐', 60, 920), w('小炒肉木桶饭', 400, 950), w('选规格', 1470, 950, 120, 50)]
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

test('红线：整条重试时加购只发生一次（真机曾因重试把同菜加到 ×4）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  const STORE = [w('点餐', 60, 920), w('小炒肉木桶饭', 400, 950), w('选规格', 1470, 950, 120, 50)]
  const SPEC = [w('份量', 60, 877), w('选好了', 800, 2432, 200, 60)]
  const CART = [w('去结算', 1453, 2432, 200, 60)]
  const SETTLE = [w('合计', 1100, 2400, 120, 50), w('¥30.98', 1240, 2405, 120, 50)]
  // 第一轮在「结算页」之后缺失 → 用一个永不匹配的帧让第一轮读不到实付而失败
  const NO_SETTLE = [w('加载中', 100, 100)]
  const frames = [
    HOME,
    SEARCH,
    RESULT,
    STORE,
    STORE,
    SPEC,
    CART,
    NO_SETTLE,
    HOME,
    SEARCH,
    RESULT,
    STORE,
    CART,
    SETTLE,
  ]
  const { ocr, driver, rec } = makeFake(frames)

  const facts = await runElemeOcrNav(driver, ocr, cond, 2, sleep)
  assert.equal(facts.payable, 30.98)
  // 两轮里「选规格」只点了一次
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 1)
})

test('waitFor：慢设备单帧吃掉全部预算时，仍至少看 2 帧（真机 OCR 6.2s/帧）', async () => {
  let reads = 0
  const ocr: Ocr = {
    read: async () => {
      reads++
      // 模拟单帧耗时 400ms
      await new Promise((r) => setTimeout(r, 400))
      return { text: 'x', words: [w('x', 10, 10)] }
    },
  }
  const driver = { screencap: async () => new Uint8Array([1]) } as unknown as Driver
  const nav = createOcrNav(driver, ocr)
  // 预算 200ms 远小于单帧 400ms：旧实现只读 1 帧就超时
  await assert.rejects(() => nav.waitFor(() => false, '慢页面', 200), /OCR 等待超时/)
  assert.ok(reads >= 2, `应至少看 2 帧，实际 ${reads}`)
})

test('waitFor(roi)：ROI 透传给 OCR（慢设备底部条只识别 1s vs 全屏 6s）', async () => {
  const rois: unknown[] = []
  const ocr: Ocr = {
    read: async (_png: Uint8Array, roi?: unknown) => {
      rois.push(roi)
      return { text: '去结算', words: [w('去结算', 1453, 2432, 200, 60)] }
    },
  }
  const driver = { screencap: async () => new Uint8Array([1]) } as unknown as Driver
  const nav = createOcrNav(driver, ocr)
  const roi = { x: 0, y: 2150, w: 1600, h: 410 }
  const words = await nav.waitFor((ws) => ws.some((x) => x.t === '去结算'), '购物车栏', 5000, roi)
  assert.equal(words.length, 1)
  assert.deepEqual(rois[0], roi)
})

test('isCartBar: 底部条结构信号（去结算按钮 OCR 不稳时仍能判定）', async () => {
  const { isCartBar } = await import('../src/platform/elemeReal.ts')
  // 真机实拍：按钮白字被读成「丝」「sa」，但「券后约」「免配送费」稳定可读
  assert.equal(isCartBar([w('¥60.96', 26, 2432), w('券后约', 200, 2432), w('丝', 900, 2470)]), true)
  assert.equal(isCartBar([w('¥13.98', 176, 2432), w('免配送费', 177, 2477)]), true)
  assert.equal(isCartBar([w('凑单', 1200, 2349)]), true)
  // 店铺页顶部（无购物车条）不应误判
  assert.equal(isCartBar([w('点餐', 60, 920), w('评价', 300, 920)]), false)
})

test('extractElemeSettleFromOcr: 读「共N件」为页面事实（购物车累积时能暴露不可比）', async () => {
  const { extractElemeSettleFromOcr } = await import('../src/platform/elemeReal.ts')
  // 真机实拍：购物车累积 2 件，页面「共 2 件 已优惠 ¥32.14」+ 合计 ¥44.96
  const words = [
    w('打包费', 40, 1172),
    w('¥4', 300, 1172),
    w('配送费', 40, 1265),
    w('¥9', 300, 1265),
    w('合计', 40, 1537),
    w('¥44.96', 900, 1537),
    w('共', 40, 2359, 30, 30),
    w('2', 90, 2359, 20, 30),
    w('件', 120, 2359, 30, 30),
  ]
  const facts = extractElemeSettleFromOcr(words, cond, '')
  assert.equal(facts.payable, 44.96)
  // 关键：qty 取页面事实 2（而非期望 1）→ runner 的 detectDeviations 会判不可比
  assert.equal(facts.qty, 2)
})

test('红线：购物车非空时拒绝加购（避免多件总额被当单品实付）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  // 店铺页（全屏 OCR 含底部购物车条）：底部已有合计金额 → 购物车非空
  const STORE = [
    w('点餐', 60, 920),
    w('选规格', 1470, 950, 120, 50),
    w('¥60.96', 26, 2432),
    w('券后约', 200, 2432),
    w('¥40.86', 420, 2432),
    w('免配送费', 177, 2477),
  ]
  const { ocr, driver, rec } = makeFake([HOME, SEARCH, RESULT, STORE])
  await assert.rejects(
    () => runElemeOcrNav(driver, ocr, cond, 1, sleep),
    (e: unknown) => e instanceof NeedsHumanError && /购物车非空/.test(String(e.hint ?? '')),
  )
  // 关键：一次都没点「选规格」（绝不往非空购物车再加）
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 0)
})

test('runCompare: 非幂等入口平台（饿了么）不被外层重试（避免内外重试相乘导致重复加购）', async () => {
  const { runCompare } = await import('../src/task/runner.ts')
  let enterCalls = 0
  const fakeStrategy = {
    id: 'eleme',
    appId: 'me.ele',
    settleAnchor: 'x',
    idempotentEnter: false,
    selectors: {},
    async enterSettlePage() {
      enterCalls++
      throw new Error('uiautomator dump 失败（可重试特征）')
    },
  } as unknown as PlatformStrategy
  const deps = {
    driver: {},
    ocr: { read: async () => ({ text: '', words: [] }) },
    clock: { now: () => Date.now() },
    dataDir: '/tmp/pa-x',
    lockRoot: '/tmp/pa-x/locks',
    serial: 'fake',
    jobs: {},
    tasks: {},
    config: {
      task: { retryAttempts: 3, lockWaitMs: 1000 },
      evidence: { ttlMinutes: 10, redact: false },
      platforms: {},
    },
  } as unknown as Parameters<typeof runCompare>[0]
  const p = { update: () => {}, append: () => {} }
  await assert.rejects(() => runCompare(deps, { taskId: 't', cond, platforms: [fakeStrategy] }, p))
  // 即使配置 retryAttempts=3，非幂等平台也只调一次（不放大加购风险）
  assert.equal(enterCalls, 1)
})

test('extractElemeSettleFromOcr: 商品/店名从版面抽取，绝不伪造查询词（真机串品可被发现）', async () => {
  const { extractElemeSettleFromOcr } = await import('../src/platform/elemeReal.ts')
  // 真机实拍：查询「小炒肉木桶饭」，实际加购的是「小炒猪肝木桶饭」
  const words = [
    w('江西小炒(盛夏路店)', 41, 771, 400, 40),
    w('小炒猪肝木桶饭', 186, 848, 400, 40),
    w('¥29.98', 900, 848, 120, 40),
    w('不辣', 187, 896, 80, 40),
    w('x1', 187, 933, 40, 40),
    w('打包费', 41, 1012),
    w('¥2', 300, 1012),
    w('合计', 41, 1378),
    w('¥13.98', 900, 1378),
  ]
  const facts = extractElemeSettleFromOcr(words, cond, '')
  // 关键：itemName 必须是**页面实际商品**，不是查询词
  assert.equal(facts.itemName, '小炒猪肝木桶饭')
  assert.notEqual(facts.itemName, cond.item)
  assert.ok(facts.storeName.includes('江西小炒'))
  assert.equal(facts.itemSpec, '不辣')
})

test('extractElemeSettleFromOcr: 抽不到商品时留查询词（不崩），但绝不伪造规格', async () => {
  const { extractElemeSettleFromOcr } = await import('../src/platform/elemeReal.ts')
  const words = [w('合计', 41, 1378), w('¥13.98', 900, 1378)]
  const facts = extractElemeSettleFromOcr(words, cond, '')
  assert.equal(facts.itemName, cond.item) // 无证据时退回查询词
  assert.equal(facts.itemSpec, undefined) // 规格绝不伪造
  assert.equal(facts.storeName, '(未知门店)')
})

test('加购：无规格弹窗时按"底部购物车条出现"判定加购成功（该店菜品带默认规格）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  // 店铺页：空购物车（无券后/合计金额）
  const STORE = [w('点餐', 60, 920), w('小炒肉木桶饭', 400, 950), w('选规格', 1470, 950, 120, 50)]
  // 点「选规格」后**直接加购**：没有规格弹窗，但底部条出现「券后约 ¥13.98」
  const AFTER_ADD = [w('点餐', 60, 920), w('¥13.98', 176, 2432), w('券后约', 300, 2432)]
  const CART = [w('去结算', 1453, 2432, 200, 60), w('券后约', 300, 2432)]
  const SETTLE = [w('合计', 1100, 2400), w('¥13.98', 1240, 2405)]
  const { ocr, driver, rec } = makeFake([HOME, SEARCH, RESULT, STORE, AFTER_ADD, CART, SETTLE])
  const facts = await runElemeOcrNav(driver, ocr, cond, 1, sleep)
  assert.equal(facts.payable, 13.98)
  // 加购只点一次
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 1)
})

test('extractElemeSettleFromOcr: OCR 前置噪声与小写误识时仍能取整菜名（不取"木桶饭"碎片）', async () => {
  const { extractElemeSettleFromOcr } = await import('../src/platform/elemeReal.ts')
  const words = [
    w('区购江西小炒(盛夏路店)蜂鸟准时达', 41, 771, 700, 40),
    w('二呈小炒猪肝木桶饭', 186, 848, 400, 40),
    w('¥29.98', 900, 848, 120, 40),
    w('合计', 41, 1378),
    w('¥13.98', 900, 1378),
  ]
  const facts = extractElemeSettleFromOcr(words, cond, '')
  // 菜名必须保留完整主体（不能因为"木桶饭"是子集而得 0.9 就取碎片）
  assert.equal(facts.itemName, '小炒猪肝木桶饭')
  // 店名剥掉"区购…蜂鸟准时达"噪声
  assert.equal(facts.storeName, '江西小炒(盛夏路店)')
})

// ───────────────────── 2026-10-28：按目标菜名选规格（绝不点第一个/近名菜） ─────────────────────

test('红线：按目标菜名定位「选规格」，跳过位置更靠前但近名的菜（小炒田螺肉 ≠ 小炒肉）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  // 店铺菜单：第一道是"小炒田螺肉木桶饭"（近名，itemScore≈0.9），目标"小炒肉木桶饭"在下方。
  const STORE = [
    w('点餐', 60, 920),
    w('小炒田螺肉木桶饭', 360, 1000),
    w('¥35', 300, 1040),
    w('选规格', 1470, 1000, 120, 50),
    w('小炒肉木桶饭', 360, 1400),
    w('¥29.98', 300, 1440),
    w('选规格', 1470, 1400, 120, 50),
  ]
  const SPEC = [w('份量', 60, 877), w('选好了', 800, 2432, 200, 60)]
  const CART = [w('去结算', 1453, 2432, 200, 60)]
  const SETTLE = [w('合计', 1100, 2400, 120, 50), w('¥29.98', 1240, 2405, 120, 50)]
  // STORE 出现两次（店铺页等待 + 点选规格前判定）
  const { ocr, driver, rec } = makeFake([HOME, SEARCH, RESULT, STORE, STORE, SPEC, CART, SETTLE])
  const facts = await runElemeOcrNav(driver, ocr, cond, 1, sleep)
  assert.equal(facts.payable, 29.98)
  // 关键：点的是 y=1400（小炒肉）那个「选规格」，不是 y=1000（田螺肉）。
  const specTaps = rec.taps.filter((t) => t.x === 1530)
  assert.equal(specTaps.length, 1)
  assert.equal(specTaps[0]!.y, 1425) // 1400+25(按钮中心)，是"小炒肉"行而非"田螺"行(1000→1025)
})

test('红线：菜单里没有目标菜 → NeedsHumanError（不乱点近名菜、不整条重试）', async () => {
  const HOME = [w('推荐', 100, 300)]
  const SEARCH = [w('历史搜索', 100, 200)]
  const RESULT = [w('销量', 60, 180)]
  // 只有"小炒田螺肉木桶饭"（近名），没有"小炒肉木桶饭"。
  const STORE = [
    w('点餐', 60, 920),
    w('小炒田螺肉木桶饭', 360, 1000),
    w('¥35', 300, 1040),
    w('选规格', 1470, 1000, 120, 50),
  ]
  const { ocr, driver, rec, reads } = makeFake([HOME, SEARCH, RESULT, STORE])
  await assert.rejects(
    () => runElemeOcrNav(driver, ocr, cond, 3, sleep), // attempts=3 也不该重试
    (e: unknown) =>
      e instanceof NeedsHumanError &&
      /未找到目标菜品/.test(String(e.hint ?? '') + String(e.message ?? '')),
  )
  // 没有任何「选规格」点击；4 帧读完即停（非瞬时故障不重试）
  assert.equal(rec.taps.filter((t) => t.x === 1530).length, 0)
  assert.equal(reads(), 4)
})
