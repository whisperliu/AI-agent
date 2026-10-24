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
  parseMoneyText,
  runMeituanReal,
  type Navigator,
} from '../src/platform/meituanReal.ts'
import { classifyObstruction } from '../src/device/recover.ts'
import { parseUiNodes, type UiNode } from '../src/device/uixml.ts'
import { priceQuote } from '../src/price/engine.ts'
import { NeedsHumanError } from '../src/core/errors.ts'
import type { ComparisonConditions } from '../src/price/model.ts'
import type { QuoteDraft } from '../src/price/model.ts'

const FIX = join(import.meta.dirname, 'fixtures')
const settleXml = await readFile(join(FIX, 'meituan-settle.real.xml'), 'utf8')
const homeXml = await readFile(join(FIX, 'home.real.xml'), 'utf8')
const captchaXml = await readFile(join(FIX, 'captcha.xml'), 'utf8')
const upgradeXml = await readFile(join(FIX, 'upgrade-popup.xml'), 'utf8')
const textlessCaptchaXml = await readFile(join(FIX, 'captcha.textless-webview.xml'), 'utf8')

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

// ────────────────── 选店导航链路（stub Navigator 回放） ──────────────────
function stubNavigator(screens: { home: string; store: string; settle: string }): {
  nav: Navigator
  taps: string[]
} {
  const taps: string[] = []
  const nodesOf = (x: string) => parseUiNodes(x)
  const ensure = (anchors: { resourceId?: string }[], xml: string, what: string) => {
    const ns = nodesOf(xml)
    const ok = anchors.some((a) =>
      a.resourceId ? ns.some((n) => n.resourceId?.endsWith(a.resourceId!)) : true,
    )
    if (!ok) throw new Error(`stub: anchor miss for ${what}`)
  }
  const nav: Navigator = {
    nodes: async () => nodesOf(screens.settle),
    dump: async () => screens.settle,
    tap: async (sel, what) => {
      taps.push(`${what}:${sel.resourceId ?? ''}`)
    },
    input: async (_sel, _t, what) => {
      taps.push(`input:${what}`)
    },
    swipeUp: async () => {},
    waitAny: async (anchors, what) => {
      const xml =
        what === '首页'
          ? screens.home
          : what === '店铺列表' || what === '店铺页'
            ? screens.store
            : screens.settle
      ensure(anchors as { resourceId?: string }[], xml, what)
      return { nodes: nodesOf(xml), dump: xml }
    },
  }
  return { nav, taps }
}

test('runMeituanReal: fires search→store→cart and extracts payable', async () => {
  const storeXml = `<hierarchy><node text="某店" resource-id="com.sankuai.meituan:id/poi_name" class="android.widget.TextView" package="com.sankuai.meituan" clickable="true" bounds="[0,0][100,50]"/><node text="加入购物车" resource-id="com.sankuai.meituan:id/add_to_cart" class="android.widget.Button" package="com.sankuai.meituan" clickable="true" bounds="[0,60][100,110]"/></hierarchy>`
  const { nav, taps } = stubNavigator({ home: homeXml, store: storeXml, settle: settleXml })
  const facts = await runMeituanReal(nav, cond)
  assert.equal(facts.payable, 26.9)
  assert.ok(taps.some((t) => t.includes('搜索框')))
  assert.ok(taps.some((t) => t.includes('第一家店铺')))
  assert.ok(taps.some((t) => t.includes('加入购物车')))
  assert.ok(taps.some((t) => t.includes('购物车')))
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
