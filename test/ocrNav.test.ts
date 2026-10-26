/**
 * ocrNav.test.ts — OCR 盲导航原语（P6，离线）。覆盖：
 *  - 坐标点命中最小词、邻域取词；
 *  - **canvas 支付红线**：点击坐标邻近出现"立即支付"等即拒绝（canvas 无控件时的唯一防线）；
 *  - 文案定位 find（ltr/rtl）与 waitFor 超时语义；
 *  - ELEME_LAYOUT / supportsOcrNav。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  wordAtPoint,
  wordsNearPoint,
  assertOcrTapSafe,
  createOcrNav,
  describeWords,
} from '../src/platform/ocrNav.ts'
import { ELEME_LAYOUT, supportsOcrNav } from '../src/platform/elemeReal.ts'
import { ForbiddenActionError, NeedsHumanError } from '../src/core/errors.ts'
import type { Ocr, OcrWord } from '../src/ocr/reader.ts'
import type { Driver } from '../src/device/driver.ts'

function w(t: string, x: number, y: number, ww = 80, hh = 30, c = 0.9): OcrWord {
  return { t, c, bbox: { x, y, w: ww, h: hh } }
}

test('wordAtPoint: 命中坐标处面积最小的词（避免大框 banner）', () => {
  const words = [w('大banner', 0, 0, 1600, 400), w('搜索', 700, 300, 120, 40)]
  assert.equal(wordAtPoint(words, 750, 315)?.t, '搜索')
  assert.equal(wordAtPoint(words, 10, 10)?.t, '大banner')
  assert.equal(wordAtPoint(words, 2000, 2000), undefined)
})

test('wordsNearPoint: 返回点邻域内的词', () => {
  const words = [w('立即支付', 700, 2400), w('合计', 40, 1400), w('远', 40, 100)]
  const near = wordsNearPoint(words, 715, 2410, 60).map((x) => x.t)
  assert.ok(near.includes('立即支付'))
  assert.ok(!near.includes('远'))
})

test('assertOcrTapSafe: 点击邻近"立即支付" → 抛 ForbiddenActionError（canvas 支付红线）', () => {
  const words = [w('立即支付', 700, 2400, 200, 60), w('¥16.98', 780, 2405, 120, 50)]
  assert.throws(() => assertOcrTapSafe(words, { x: 800, y: 2432 }), ForbiddenActionError)
})

test('assertOcrTapSafe: 点击普通区域（合计/去结算）不误伤', () => {
  const words = [w('合计', 40, 1400), w('去结算', 1450, 2432)]
  assert.doesNotThrow(() => assertOcrTapSafe(words, { x: 1450, y: 2432 }))
})

test('createOcrNav: look() 拦截验证码文案 → NeedsHumanError', async () => {
  const ocr: Ocr = {
    read: async () => ({
      text: '请拖动下方滑块完成拼图',
      words: [w('请拖动下方滑块完成拼图', 10, 10)],
    }),
  }
  const driver = { screencap: async () => new Uint8Array() } as unknown as Driver
  const nav = createOcrNav(driver, ocr)
  await assert.rejects(
    () => nav.look(),
    (e: unknown) => e instanceof NeedsHumanError,
  )
})

test('createOcrNav: find ltr/rtl + waitFor 超时', async () => {
  const words = [w('a', 100, 10), w('b', 500, 10), w('c', 900, 10)]
  const ocr: Ocr = { read: async () => ({ text: 'a b c', words }) }
  const driver = { screencap: async () => new Uint8Array() } as unknown as Driver
  const nav = createOcrNav(driver, ocr)
  const ws = await nav.look()
  assert.equal(nav.find(ws, /a|b|c/)?.t, 'a')
  assert.equal(nav.find(ws, /a|b|c/, { dir: 'rtl' })?.t, 'c')
  await assert.rejects(() => nav.waitFor(() => false, '不存在', 300), /OCR 等待超时/)
})

test('waitFor 超时：异常自带末帧文本（省上下文，排查不必读图）', async () => {
  const words = [w('合计', 40, 1400), w('¥16.98', 780, 1405)]
  const ocr: Ocr = { read: async () => ({ text: '', words }) }
  const driver = { screencap: async () => new Uint8Array() } as unknown as Driver
  const nav = createOcrNav(driver, ocr)
  await assert.rejects(
    () => nav.waitFor(() => false, '结算页', 250),
    (e: Error) => /末帧文本/.test(e.message) && /合计/.test(e.message) && /16\.98/.test(e.message),
  )
})

test('describeWords: 按行聚拢、带 y 坐标、限行限词', () => {
  const words = [w('合计', 40, 1400), w('¥16.98', 780, 1405), w('去结算', 1450, 2432)]
  const s = describeWords(words)
  assert.match(s, /y=14\d\d\|合计 ¥16\.98/)
  assert.match(s, /去结算/)
  // 上限：给 200 个词也只输出有限长度
  const many = Array.from({ length: 200 }, (_, i) => w('x' + i, i * 10, i * 40))
  assert.ok(describeWords(many).length < 700)
  assert.equal(describeWords([]), '；末帧无可读文本')
})

test('supportsOcrNav: 需 tapPoint + inputText + key', () => {
  const full = { tapPoint: () => {}, inputText: () => {}, key: () => {} } as unknown as Driver
  const partial = { tapPoint: () => {} } as unknown as Driver
  assert.equal(supportsOcrNav(full), true)
  assert.equal(supportsOcrNav(partial), false)
})

test('ELEME_LAYOUT: 关键锚点齐全且为数字坐标', () => {
  for (const k of [
    'homeSearch',
    'searchInput',
    'storeFirstDishSpec',
    'pickDone',
    'goSettle',
  ] as const) {
    const p = ELEME_LAYOUT[k]
    assert.equal(typeof p.x, 'number')
    assert.equal(typeof p.y, 'number')
  }
  assert.equal(ELEME_LAYOUT.enterKey, 66)
})

test('locateFirstDishY: 跳过顶部促销价（¥15/¥20），取菜单列表区首个菜价 y', async () => {
  const { locateFirstDishY } = await import('../src/platform/elemeReal.ts')
  const words = [
    w('¥15', 50, 470), // 超级吃货卡（促销，应跳过）
    w('¥20', 120, 630), // 满减券（促销，应跳过）
    w('¥29.88', 300, 1240), // 菜单首个菜
    w('¥30.98', 300, 1500),
  ]
  assert.equal(locateFirstDishY(words, 1242), 1255)
  // 无菜单价时回退 fallback
  assert.equal(locateFirstDishY([w('¥15', 50, 470)], 1242), 1242)
})

test('locateFirstDishY: 首个菜价在 y≈950（旧下界 1150 会漏掉前两道菜 → 回归）', async () => {
  const { locateFirstDishY } = await import('../src/platform/elemeReal.ts')
  const words = [
    w('爆¥19', 700, 653), // 促销（<850，跳过）
    w('¥30.98', 300, 955), // 首个菜价
    w('¥31.98', 300, 1300),
  ]
  assert.equal(locateFirstDishY(words, 1242), 970)
})

test('locateFirstDishSpecY: 优先用「选规格」文案定位首个菜行（比价格行更准）', async () => {
  const { locateFirstDishSpecY } = await import('../src/platform/elemeReal.ts')
  const words = [
    w('¥30.98', 300, 955),
    w('选规格', 1470, 950, 120, 50), // 首个菜「选规格」
    w('选规格', 1470, 1300, 120, 50), // 第二个菜
  ]
  // 取最靠上的「选规格」中心 y=975
  assert.equal(locateFirstDishSpecY(words, 1242), 975)
  // 没有「选规格」文案 → 退回价格行定位
  assert.equal(locateFirstDishSpecY([w('¥30.98', 300, 955)], 1242), 970)
})

test('isGroupOrderPage: 拼单详情页（邀请好友/取消拼单，且无规格）→ true；店铺页「拼单进行中」不误判', async () => {
  const { isGroupOrderPage } = await import('../src/platform/elemeReal.ts')
  const groupPage = [
    w('拼单详情', 700, 80),
    w('邀请好友', 800, 350),
    w('取消拼单', 1500, 185),
    w('合计', 1100, 2400),
  ]
  assert.equal(isGroupOrderPage(groupPage), true)

  // 店铺页有「拼单进行中」入口按钮，但不是拼单详情页（且没有规格弹窗）→ 不应误判
  const storePage = [w('拼单进行中', 1470, 920), w('点餐', 60, 920), w('¥30.98', 300, 955)]
  assert.equal(isGroupOrderPage(storePage), false)

  // 规格弹窗（有份量/辣度/选好了）永远不算拼单页
  const specSheet = [w('份量', 60, 877), w('辣度', 60, 1107), w('选好了', 800, 2432)]
  assert.equal(isGroupOrderPage(specSheet), false)
})
