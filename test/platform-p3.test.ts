/**
 * platform-p3.test.ts — P3 美团真机抓价的离线测试（不依赖真机，按 fixture 回放）。
 * 覆盖：
 *  - 真机结算页抽取（resource-id 路径 / 文案回退路径）→ RawQuoteFacts → price 折算
 *  - 选店导航链路（stub Navigator：首页→搜索→店铺→加购→结算）
 *  - 验证码（含 **无字 WebView 滑块**）→ NeedsHumanError（红线 2）
 *  - 3 类干扰（升级弹窗 / 定位授权 / 加载慢）可恢复
 *  - OCR 质量门：读不到实付 → confidence=low → needsConfirm
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractMeituanSettleFromDump,
  firstActionableCenter,
  firstResultCardCenter,
  isDangerNode,
  parseMoneyText,
  runMeituanReal,
  type Navigator,
} from '../src/platform/meituanReal.ts'
import { classifyObstruction } from '../src/device/recover.ts'
import { parseUiNodes, type UiNode } from '../src/device/uixml.ts'
import { priceQuote } from '../src/price/engine.ts'
import { ForbiddenActionError, NeedsHumanError } from '../src/core/errors.ts'
import type { ComparisonConditions } from '../src/price/model.ts'
import type { QuoteDraft } from '../src/price/model.ts'

const FIX = join(import.meta.dirname, 'fixtures')
const settleXml = await readFile(join(FIX, 'meituan-settle.real.xml'), 'utf8')
const homeXml = await readFile(join(FIX, 'home.real.xml'), 'utf8')
const captchaXml = await readFile(join(FIX, 'captcha.xml'), 'utf8')
const upgradeXml = await readFile(join(FIX, 'upgrade-popup.xml'), 'utf8')
const textlessCaptchaXml = await readFile(join(FIX, 'captcha.textless-webview.xml'), 'utf8')
const realDeviceXml = await readFile(join(FIX, 'meituan-settle.real-device.xml'), 'utf8')

const cond: ComparisonConditions = {
  snapshotId: 'snap-test',
  item: '香叶 烤鸭饭',
  qty: 1,
  spec: [],
  composition: [],
  deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
  fixedAt: '2026-10-24T13:00:00+08:00',
  hash: 'h-test',
}

function draftFrom(facts: ReturnType<typeof extractMeituanSettleFromDump>): QuoteDraft {
  return {
    platform: 'meituan',
    store: { name: facts.storeName, matchedScore: 1 },
    item: { name: facts.itemName, qty: facts.qty, matchedScore: 1, spec: facts.itemSpec },
    fees: facts.fees,
    discounts: facts.discounts,
    payable: facts.payable,
    extraction: { confidence: facts.confidence, byField: facts.byField },
    evidence: {
      quoteId: 'q',
      platform: 'meituan',
      storeName: facts.storeName,
      itemSpec: `${facts.itemName} x${facts.qty}`,
      qty: facts.qty,
      feeBreakdown: facts.fees,
      rawExtraction: { treeDumpPath: '/tmp/x.xml' },
      capturedAt: '2026-10-24T13:00:00+08:00',
      validUntil: '2026-10-24T13:10:00+08:00',
      redaction: 'applied',
    },
  }
}

// ────────────────── 抽取：resource-id 路径 ──────────────────
test('extract: resource-id settle page → costs + payable balanced', () => {
  const facts = extractMeituanSettleFromDump(settleXml, cond)
  assert.equal(facts.payable, 26.9)
  assert.equal(facts.storeName, '香叶烤鸭（人民广场店）')
  assert.equal(facts.qty, 1)
  // goods 28.90 + delivery 2.00 + packing 1.00 = 31.90；满30减5 => 26.90
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.goods, 28.9)
  assert.equal(kinds.delivery, 2)
  assert.equal(kinds.packing, 1)
  assert.equal(facts.discounts.length, 1)
  assert.equal(facts.discounts[0]!.amount, 5)
  // 已含在实付 → 不重复扣
  assert.equal(facts.discounts[0]!.alreadyIncludedInPayable, true)
  assert.equal(facts.confidence, 'high')

  const quote = priceQuote(draftFrom(facts))
  assert.equal(quote.arithmetic.balanced, true)
  assert.equal(quote.effectivePrice, 26.9)
  assert.equal(quote.needsConfirm, false)
})

// ────────────────── 抽取：文案回退路径（真机常见） ──────────────────
test('extract: text-label rows (no fee ids) → still extracts', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
 <node text="确认订单" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,0][100,50]"/>
 <node text="某某炸鸡店" resource-id="com.sankuai.meituan:id/poi_name" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,60][500,110]"/>
 <node text="香辣鸡腿堡 x2" resource-id="com.sankuai.meituan:id/food_name" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,120][500,170]"/>
 <node text="商品金额 ¥40.00" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,200][500,250]"/>
 <node text="配送费 ¥3.00" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,260][500,310]"/>
 <node text="打包费 ¥2.00" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,320][500,370]"/>
 <node text="红包 -¥5.00" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,380][500,430]"/>
 <node text="实付 ¥40.00" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,900][500,950]"/>
</hierarchy>`
  const facts = extractMeituanSettleFromDump(xml, cond)
  assert.equal(facts.payable, 40)
  assert.equal(facts.qty, 2)
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.goods, 40)
  assert.equal(kinds.delivery, 3)
  assert.equal(kinds.packing, 2)
  assert.equal(facts.discounts[0]!.amount, 5)
  // 40 + 3 + 2 - 5 = 40 → balanced
  const quote = priceQuote(draftFrom(facts))
  assert.equal(quote.arithmetic.balanced, true)
})

test('parseMoneyText: ¥28.9 vs ¥289 distinguish', () => {
  assert.equal(parseMoneyText('¥28.9'), 28.9)
  assert.equal(parseMoneyText('¥289'), 289)
  assert.equal(parseMoneyText('满30减5 -¥5.00'), 5) // 首个金额
  assert.ok(Number.isNaN(parseMoneyText('无金额')))
})

// ────────────────── OCR 质量门：读不到实付 → needsConfirm ──────────────────
test('extract: missing payable → confidence low → needsConfirm (OCR gate)', () => {
  const xml = homeXml.replace('com.sankuai.meituan:id/search_entry', 'x') // 无 payable
  const facts = extractMeituanSettleFromDump(xml, cond)
  assert.ok(Number.isNaN(facts.payable))
  assert.equal(facts.confidence, 'low')
  const quote = priceQuote(draftFrom(facts))
  assert.equal(quote.needsConfirm, true)
})

// ────────────────── 全流程导航（真实 fixture 回放：首页→搜索→结果→店铺→规格→购物车→结算） ──────────────────
const homeRd = await readFile(join(FIX, 'meituan-home.real-device.xml'), 'utf8')
const searchRd = await readFile(join(FIX, 'meituan-search.real-device.xml'), 'utf8')
const resultsRd = await readFile(join(FIX, 'meituan-results.real-device.xml'), 'utf8')
const storeRd = await readFile(join(FIX, 'meituan-store.real-device.xml'), 'utf8')
const specRd = await readFile(join(FIX, 'meituan-specsheet.real-device.xml'), 'utf8')
const storeAddedRd = await readFile(join(FIX, 'meituan-store-added.real-device.xml'), 'utf8')

function flowNavigator(): { nav: Navigator; taps: string[] } {
  const taps: string[] = []
  const nodesOf = (x: string) => parseUiNodes(x)
  // 屏幕状态机：记录当前应回放哪一屏的 dump（供 firstActionable 用）。
  const screen: Record<string, string> = { current: homeRd }
  const ensure = (anchors: { resourceId?: string; text?: string }[], xml: string, what: string) => {
    const ns = nodesOf(xml)
    const ok = anchors.some((a) =>
      a.resourceId
        ? ns.some((n) => n.resourceId?.endsWith(a.resourceId!))
        : a.text
          ? ns.some((n) => (n.text ?? '').includes(a.text!) || (n.label ?? '').includes(a.text!))
          : false,
    )
    if (!ok) throw new Error(`flow: anchor miss for ${what}`)
  }
  const nav: Navigator = {
    nodes: async () => nodesOf(screen.current!),
    dump: async () => screen.current!,
    tap: async (sel, what) => {
      taps.push(`${what}:${sel.resourceId ?? sel.text ?? ''}`)
      if (what === '搜索入口') screen.current = searchRd
      else if (what === '选规格') screen.current = specRd
      else if (what === '加入购物车') screen.current = storeAddedRd
    },
    tapPoint: async (x, y, what) => {
      taps.push(`point:${what}@${x},${y}`)
      if (what === '第一家店铺') screen.current = storeRd
    },
    input: async (_sel, _t, what) => {
      taps.push(`input:${what}`)
    },
    swipeUp: async () => {
      // 店铺页首次下滚越过 banner 后，菜单/规格进入视野。
      if (screen.current === storeRd) screen.current = storeAddedRd
    },
    repaint: async () => {},
    hasAny: async (keywords) => {
      const ns = nodesOf(screen.current!)
      return ns.some((n) =>
        keywords.some((k) => (n.text ?? '').includes(k) || (n.label ?? '').includes(k)),
      )
    },
    firstResultCard: async () => firstResultCardCenter(nodesOf(resultsRd)),
    firstActionable: async (keywords) => firstActionableCenter(nodesOf(screen.current!), keywords),
    waitAny: async (anchors, what) => {
      if (what.startsWith('结算页(已在)')) throw new Error('flow: not on settle yet')
      const xml =
        what === '首页'
          ? homeRd
          : what === '搜索页'
            ? searchRd
            : what === '搜索结果'
              ? resultsRd
              : what === '店铺页'
                ? storeRd
                : what === '结算页'
                  ? realDeviceXml
                  : undefined
      if (!xml) throw new Error(`flow: unknown wait "${what}"`)
      ensure(anchors as { resourceId?: string; text?: string }[], xml, what)
      screen.current = xml
      return { nodes: nodesOf(xml), dump: xml }
    },
  }
  return { nav, taps }
}

test('runMeituanReal: full cold-start flow (home→search→result→store→spec→cart→settle) reads payable', async () => {
  const { nav, taps } = flowNavigator()
  const facts = await runMeituanReal(nav, cond)
  // 真实结算页读数（券前 ¥30.98）。
  assert.equal(facts.payable, 30.98)
  // 关键步骤都发生了（且不含任何下单/支付点击）。
  assert.ok(taps.some((t) => t.includes('搜索入口')))
  assert.ok(taps.some((t) => t.includes('搜索输入')))
  assert.ok(taps.some((t) => t.includes('第一家店铺')))
  assert.ok(taps.some((t) => t.includes('选规格')))
  assert.ok(taps.some((t) => t.includes('加入购物车')))
  assert.ok(taps.some((t) => t.includes('去结算')))
  assert.ok(!taps.some((t) => /支付|提交订单|付款/.test(t)), '绝不应点支付/提交')
})

// ────────────────── 坐标点按安全：tapPoint 命中支付控件必须被拦（红线 1） ──────────────────
test('tapPoint (adb) on a pay button → ForbiddenActionError, no input tap', async () => {
  const calls: string[] = []
  const runner2 = async (argv: string[]) => {
    calls.push(argv.join(' '))
    if (argv[0] === 'devices')
      return { code: 0, stdout: 'List of devices attached\nx\tdevice\n', stderr: '' }
    if (argv.includes('uiautomator')) return { code: 0, stdout: realDeviceXml, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const { createAdbDriver } = await import('../src/device/adb.ts')
  const d2 = createAdbDriver({ serial: 'x', runner: runner2 as never, disableAnimations: false })
  // "极速支付" 按钮 bounds [1270,2395][1570,2505]（见 fixture），点其中心。
  await assert.rejects(
    () => d2.tapPoint!(1420, 2450),
    (e: unknown) => e instanceof ForbiddenActionError,
  )
  assert.ok(!calls.some((c) => c.includes('input tap')), '被拦截时不应真正 input tap')
})

// ────────────────── 验证码：含无字 WebView 滑块 ──────────────────
test('classifyObstruction: crafted slider captcha → captcha', () => {
  assert.equal(classifyObstruction(captchaXml).kind, 'captcha')
})

test('classifyObstruction: textless WebView slider (real meituan) → captcha', () => {
  // 真机实测形态：无 text / 无 content-desc，仅一个大 WebView。
  assert.equal(classifyObstruction(textlessCaptchaXml).kind, 'captcha')
})

test('runMeituanReal: captcha screen → NeedsHumanError, never taps verify control', async () => {
  const taps: string[] = []
  const nav: Navigator = {
    nodes: async () => parseUiNodes(captchaXml),
    dump: async () => captchaXml,
    tap: async (sel) => {
      taps.push(sel.resourceId ?? sel.text ?? '')
    },
    input: async () => {},
    swipeUp: async () => {},
    waitAny: async () => {
      // 直接用 steps 的判定语义：验证码 → throw
      const kind = classifyObstruction(captchaXml).kind
      if (kind === 'captcha') throw new NeedsHumanError('captcha')
      return { nodes: parseUiNodes(captchaXml), dump: captchaXml }
    },
  }
  await assert.rejects(() => runMeituanReal(nav, cond), NeedsHumanError)
  // 关键：遇到验证码时不应产生任何"点击验证"动作
  assert.equal(taps.length, 0)
})

// ────────────────── 干扰恢复：升级弹窗可识别 ──────────────────
test('classifyObstruction: upgrade popup → upgrade (recoverable, not human)', () => {
  assert.equal(classifyObstruction(upgradeXml).kind, 'upgrade')
})

// ────────────────── 干扰恢复：定位授权 ──────────────────
test('classifyObstruction: permission dialog → permission', () => {
  const permXml = `<hierarchy><node text="开启定位服务" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,0][100,50]"/><node text="允许" resource-id="" class="android.widget.Button" package="com.sankuai.meituan" clickable="true" bounds="[0,60][100,110]"/></hierarchy>`
  assert.equal(classifyObstruction(permXml).kind, 'permission')
})

// ────────────────── 干扰恢复：加载慢（无文本 WebView 但无列表）不应误判为验证码？──────────────────
test('classifyObstruction: loading text → loading', () => {
  const loadXml = `<hierarchy><node text="加载中" resource-id="" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[0,0][100,50]"/></hierarchy>`
  assert.equal(classifyObstruction(loadXml).kind, 'loading')
})

// ────────────────── 危险控件识别（只读，不点击） ──────────────────
test('isDangerNode flags submit/pay controls', async () => {
  const { isDangerNode } = await import('../src/platform/meituanReal.ts')
  const nodes: UiNode[] = parseUiNodes(settleXml)
  const submit = nodes.find((n) => n.resourceId?.endsWith('submit_order_btn'))!
  assert.equal(isDangerNode(submit), true)
  const store = nodes.find((n) => n.resourceId?.endsWith('store_name'))!
  assert.equal(isDangerNode(store), false)
})

// ────────────────── 真机结算页（无 resource-id，坐标/行抽取）──────────────────

test('extract (real device, no ids): row/坐标抽取实付+费用+优惠 → balanced', () => {
  const realCond: ComparisonConditions = {
    snapshotId: 'snap-real',
    item: '毛豆炒肉木桶饭',
    qty: 1,
    spec: [],
    composition: [],
    deliverTo: { city: '上海', lat: 0, lng: 0 },
    fixedAt: '2026-10-24T14:40:00+08:00',
    hash: 'h-real',
  }
  const facts = extractMeituanSettleFromDump(realDeviceXml, realCond)
  // 实付：底部「券前 ¥30.98」（未使用红包前的到手价）。
  assert.equal(facts.payable, 30.98)
  assert.equal(facts.confidence, 'high')
  // 门店/商品/规格/数量来自坐标定位。
  assert.equal(facts.storeName, '江西小炒(盛夏路店)')
  assert.equal(facts.itemName, '毛豆炒肉木桶饭')
  assert.ok(facts.itemSpec?.includes('人份') && facts.itemSpec?.includes('不辣'))
  assert.equal(facts.qty, 1)
  // 费用：商品原价 29.98 + 打包 2 + 用户配送 3.9。
  const kinds = Object.fromEntries(facts.fees.map((f) => [f.kind, f.amount]))
  assert.equal(kinds.goods, 29.98)
  assert.equal(kinds.packing, 2)
  assert.equal(kinds.delivery, 3.9)
  // 已减：配送费减免 3.9 + 商家代金券/满减 1（均含在实付里）。
  const dk = Object.fromEntries(facts.discounts.map((d) => [d.kind, d.amount]))
  assert.equal(dk.delivery_waiver, 3.9)
  assert.equal(dk.promo, 1)
  // "待使用 ¥15 红包" → optionalSaving(presumed)，**不得**当作已减优惠。
  assert.equal(
    facts.discounts.some((d) => d.kind === 'coupon'),
    false,
  )
  assert.equal(facts.optionalSavings?.length, 1)
  assert.equal(facts.optionalSavings?.[0]?.amount, 15)
  assert.equal(facts.optionalSavings?.[0]?.availability, 'presumed')

  const quote = priceQuote(draftFrom(facts))
  // 29.98 + 2 + 3.9 − 3.9 − 1 = 30.98 → 平衡
  assert.equal(quote.arithmetic.balanced, true)
  assert.equal(quote.arithmetic.expected, 30.98)
  // presumed 红包不抵扣 → 到手价仍 30.98
  assert.equal(quote.effectivePrice, 30.98)
  assert.equal(quote.needsConfirm, false)
})

test('extract: "待使用红包" never inflates discount (regression)', () => {
  // 仅一行"美团红包 待使用 15元红包" + 一条费用行，确保红包不被计入 discounts。
  const xml = `<hierarchy rotation="0">
   <node text="商品原价" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[50,100][210,150]"/>
   <node text="29.98" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[1427,100][1520,150]"/>
   <node text="美团红包" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[50,300][190,350]"/>
   <node text="待使用" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[1263,300][1368,350]"/>
   <node text="15元红包" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[1388,300][1510,350]"/>
   <node text="实付" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[50,900][120,950]"/>
   <node text="¥29.98" class="android.widget.TextView" package="com.sankuai.meituan" clickable="false" bounds="[1400,900][1520,950]"/>
  </hierarchy>`
  const facts = extractMeituanSettleFromDump(xml, cond)
  assert.equal(facts.payable, 29.98)
  assert.equal(facts.discounts.filter((d) => d.kind === 'coupon').length, 0)
  const quote = priceQuote(draftFrom(facts))
  // 未把 15 元红包当已减 → 不会把 29.98 算成 14.98
  assert.equal(quote.arithmetic.expected, 29.98)
  assert.equal(quote.arithmetic.balanced, true)
})

// ────────────────── 真机短路：已在结算页 → 直接读实付、零点击 ──────────────────
test('runMeituanReal: already on settle page → reads payable with zero taps', async () => {
  const taps: string[] = []
  const nav: Navigator = {
    nodes: async () => parseUiNodes(realDeviceXml),
    dump: async () => realDeviceXml,
    tap: async (sel, what) => {
      taps.push(`${what}:${sel.resourceId ?? sel.text ?? ''}`)
    },
    input: async (_sel, _t, what) => {
      taps.push(`input:${what}`)
    },
    swipeUp: async () => {},
    waitAny: async (anchors, _what, _t) => {
      const ns = parseUiNodes(realDeviceXml)
      const ok = anchors.some((a) =>
        a.resourceId
          ? ns.some((n) => n.resourceId?.endsWith(a.resourceId!))
          : a.text
            ? ns.some((n) => (n.text ?? '').includes(a.text!))
            : false,
      )
      if (!ok) throw new Error('anchor miss')
      return { nodes: ns, dump: realDeviceXml }
    },
  }
  const realCond: ComparisonConditions = {
    snapshotId: 's',
    item: '毛豆炒肉木桶饭',
    qty: 1,
    spec: [],
    composition: [],
    deliverTo: { city: '上海', lat: 0, lng: 0 },
    fixedAt: '2026-10-24T14:40:00+08:00',
    hash: 'h',
  }
  const facts = await runMeituanReal(nav, realCond)
  assert.equal(facts.payable, 30.98)
  // 已在结算页 → 不应发生任何点击（最安全路径）。
  assert.equal(taps.length, 0)
})

// ────────────────── 红线：真机真实付款按钮"极速支付"必须被识别为危险控件 ──────────────────
test('isDangerNode flags real 美团 "极速支付" pay button', () => {
  const nodes = parseUiNodes(realDeviceXml)
  const payBtn = nodes.find((n) => (n.text ?? '').includes('极速支付'))
  assert.ok(payBtn, 'fixture 应含"极速支付"')
  assert.equal(isDangerNode(payBtn!), true)
})

// ────────────────── 红线：真机满页验证码（home 拦截）→ runMeituanReal 走真实代码路径必须 NeedsHumanError 且零点击 ──────────────────
test('runMeituanReal (real code path): home captcha → NeedsHumanError, zero taps', async () => {
  let taps = 0
  let dumps = 0
  const fakeDriver = {
    dump: async () => {
      dumps++
      return captchaXml
    },
    tap: async () => {
      taps++
    },
    input: async () => {
      taps++
    },
    swipe: async () => {},
    screencap: async () => new Uint8Array(),
  }
  // createNavigator + runMeituanReal 走真实 waitForAnyState/classifyObstruction 路径。
  const { createNavigator } = await import('../src/platform/meituanReal.ts')
  await assert.rejects(
    () => runMeituanReal(createNavigator(fakeDriver as never, 500), cond),
    (e: unknown) => e instanceof NeedsHumanError,
  )
  assert.equal(taps, 0, '命中验证码时绝不能有任何点击')
  assert.ok(dumps >= 1)
})

// ────────────────── 结算页变体 B：神抢手/一口价店（无"券前"标签，底部"¥19.9 共减¥10.98"）──────────────────
const shenqiandXml = await readFile(join(FIX, 'meituan-settle-shenqiand.real-device.xml'), 'utf8')
test('extract (real 神抢手): no "券前" label → payable from left of "共减" → balanced', () => {
  const c: ComparisonConditions = {
    snapshotId: 's',
    item: '腐竹炒肉木桶饭',
    qty: 1,
    spec: [],
    composition: [],
    deliverTo: { city: '上海', lat: 0, lng: 0 },
    fixedAt: '2026-10-24T15:32:00+08:00',
    hash: 'h',
  }
  const facts = extractMeituanSettleFromDump(shenqiandXml, c)
  assert.equal(facts.payable, 19.9) // 底部"¥19.9 共减¥10.98"的 ¥19.9
  assert.equal(facts.storeName, '江西小炒(盛夏路店)')
  const quote = priceQuote(draftFrom(facts))
  // 26.98 + 0 + 3.9 − 3.9(配送减免) − 7.08(商家代金券) = 19.9 → 平衡
  assert.equal(quote.arithmetic.balanced, true)
  assert.equal(quote.needsConfirm, false)
})

test('extractMeituanSettle: 结算页含两道菜各 x1 时，件数应为 2（防"单行 x1 通过校验但总额是多道菜"的静默错价）', async () => {
  const { extractMeituanSettle } = await import('../src/platform/meituanReal.ts')
  const { parseUiNodes } = await import('../src/device/uixml.ts')
  const xml = `<hierarchy>
    <node text="江西小炒(盛夏路店)" bounds="[50,1004][310,1046]" />
    <node text="腐竹炒肉木桶饭" bounds="[195,1081][440,1119]" />
    <node text="1 人份，不辣" bounds="[195,1124][353,1163]" />
    <node text="x1" bounds="[195,1163][295,1197]" />
    <node text="小炒肉木桶饭" bounds="[195,1297][405,1335]" />
    <node text="1 人份，微辣" bounds="[195,1340][353,1379]" />
    <node text="x1" bounds="[195,1379][295,1413]" />
    <node text="商品原价" bounds="[50,1521][210,1571]" />
    <node text="55.86" bounds="[1422,1526][1520,1566]" />
    <node text="打包费" bounds="[50,1609][155,1654]" />
    <node text="2" bounds="[1497,1611][1520,1651]" />
  </hierarchy>`
  const cond = {
    snapshotId: 's',
    item: '小炒肉木桶饭',
    qty: 1,
    spec: [],
    composition: [],
    deliverTo: { city: '上海', lat: 31.23, lng: 121.47 },
    fixedAt: '2026-10-27T00:00:00+08:00',
    hash: 'h',
  }
  const facts = extractMeituanSettle(parseUiNodes(xml), cond, xml)
  // 关键：总件数=2（两道菜各 1），而不是只看当前菜品行的 1
  assert.equal(facts.qty, 2)
})
