#!/usr/bin/env node
/**
 * device-rehearsal.mjs — P2「只读演练 / 能力探测报告」脚本（§3.5.4(5) / tasks.md P2 DoD③）。
 *
 * 做什么（全部**只读**，绝不点结算/提交订单/支付）：
 *   1. 连接设备（探活 + 掉线重连一次）；
 *   2. 设备能力探测（dump 可用性/耗时、分辨率/DPI、前台包名、截屏、机型/Android 版本）；
 *   3. 对当前页面做「识别质量」评估（文本节点/资源 id/WebView/建议 tree|ocr|human）；
 *   4. 可选 `--open <包名>` 用 monkey 拉起 App 首页后再评估一次（不进入订单流程）；
 *   5. 产出 JSON + Markdown 能力探测报告到 `.price-agent/reports/`。
 *
 * 用法：
 *   HOME=$(mktemp -d) node scripts/device-rehearsal.mjs --serial 192.168.1.8:5555
 *   ADB_PATH=.home/android-sdk/platform-tools/adb node scripts/device-rehearsal.mjs --open com.sankuai.meituan
 *
 * 退出码：0=探测通过（能 dump + 截屏），1=不通过（带可读原因），2=参数错误。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAdbDriver } from '../src/device/adb.ts'
import { detectPage } from '../src/device/pageDetect.ts'
import { classifyObstruction } from '../src/device/recover.ts'

function parseArgs(argv) {
  const out = {
    serial: process.env.DEVICE_SERIAL || 'auto',
    open: undefined,
    outDir: '.price-agent/reports',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--serial') out.serial = argv[++i]
    else if (a === '--open') out.open = argv[++i]
    else if (a === '--out') out.outDir = argv[++i]
  }
  return out
}

const PAGE_CONTRACTS = [
  { page: 'home', anchors: [{ text: '外卖' }, { text: '首页' }, { text: '搜索' }] },
  { page: 'settle', anchors: [{ text: '确认订单' }, { text: '提交订单' }, { text: '实付' }] },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const adbPath = process.env.ADB_PATH || 'adb'
  const driver = createAdbDriver({
    serial: args.serial,
    adbPath,
    autoReconnect: true,
  })

  const report = {
    generatedAt: new Date().toISOString(),
    adbPath,
    requestedSerial: args.serial,
    ok: false,
    reason: '',
    probe: null,
    page: null,
    obstruction: null,
    checks: {},
  }

  try {
    await driver.ensureConnected()
    report.resolvedSerial = driver.serial
    report.checks.connected = true

    const probe = await driver.probe()
    report.probe = probe

    const dump = await driver.dump()
    report.page = detectPage(dump, PAGE_CONTRACTS)
    report.obstruction = classifyObstruction(dump)

    // 可选：拉起 App 首页（只读；用 monkey，不点任何订单控件）
    if (args.open) {
      const { runNativeCommand } = await import('@deepseek-ai/dsh-native-command')
      await runNativeCommand(
        adbPath,
        [
          '-s',
          driver.serial,
          'shell',
          'monkey',
          '-p',
          args.open,
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ],
        undefined,
        'hidden',
      ).catch((e) => {
        report.checks.launchError = String(e?.message || e)
      })
      await delay(2500)
      const dump2 = await driver.dump()
      report.afterOpen = {
        page: detectPage(dump2, PAGE_CONTRACTS),
        obstruction: classifyObstruction(dump2),
        quality: (await import('../src/device/probe.ts')).analyzeDump(dump2),
      }
    }

    report.checks.canDump = !!probe.canDump
    report.checks.canScreenshot = !!probe.canScreenshot
    report.ok = probe.canDump && probe.canScreenshot
    report.reason = report.ok ? 'PASS：可连接、可 dump、可截屏' : 'FAIL：dump 或截屏不可用'
  } catch (err) {
    report.ok = false
    report.reason = `FAIL：${err?.message || String(err)}`
  }

  await mkdir(args.outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(args.outDir, `device-rehearsal-${stamp}.json`)
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  const mdPath = join(args.outDir, `device-rehearsal-${stamp}.md`)
  await writeFile(mdPath, renderMarkdown(report), 'utf8')

  console.log(renderMarkdown(report))
  console.log(`\n报告已写入：\n  - ${jsonPath}\n  - ${mdPath}`)
  process.exit(report.ok ? 0 : 1)
}

function renderMarkdown(r) {
  const L = []
  L.push(`# 设备能力探测报告`)
  L.push('')
  L.push(`- 生成时间：${r.generatedAt}`)
  L.push(`- 请求 serial：${r.requestedSerial} → 解析：${r.resolvedSerial ?? '(未连接)'}`)
  L.push(`- 结论：**${r.ok ? 'PASS' : 'FAIL'}** — ${r.reason}`)
  L.push('')
  L.push(`## 设备能力`)
  const p = r.probe
  if (p) {
    L.push(`- 机型：${p.model ?? '?'} / Android ${p.androidVersion ?? '?'}`)
    L.push(`- 分辨率：${p.resolution ?? '?'} @ ${p.density ?? '?'}dpi`)
    L.push(`- 前台包名：${p.foreground ?? '?'}`)
    L.push(`- dump 可用：${p.canDump}（${p.dumpLatencyMs}ms）｜截屏可用：${p.canScreenshot}`)
    L.push(
      `- 页面识别质量：文本节点 ${p.quality.textNodes} / 资源 id ${p.quality.resourceIds} / WebView ${p.quality.hasWebview} / 丰富度 ${p.quality.treeRichness} → **建议 ${p.quality.recommend}**`,
    )
  } else {
    L.push('- （未取得探测结果）')
  }
  if (r.page) {
    L.push('')
    L.push(`## 页面识别`)
    L.push(`- 页面：${r.page.page}（置信 ${r.page.confidence}，建议 ${r.page.recommend}）`)
    L.push(
      `- 干扰：${r.obstruction?.kind ?? 'none'}${r.obstruction?.matched ? '（' + r.obstruction.matched + '）' : ''}`,
    )
  }
  if (r.afterOpen) {
    L.push('')
    L.push(`## 拉起 App 后`)
    L.push(`- 页面：${r.afterOpen.page.page}（建议 ${r.afterOpen.page.recommend}）`)
    L.push(`- 干扰：${r.afterOpen.obstruction.kind}`)
  }
  return L.join('\n') + '\n'
}

main().catch((e) => {
  console.error('rehearsal crashed:', e)
  process.exit(1)
})
