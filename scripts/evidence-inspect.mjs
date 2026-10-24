#!/usr/bin/env node
/**
 * evidence-inspect.mjs — 真机证据的**文本**检查器（省上下文）。
 *
 * 背景：真机调试时若把 `screencap` 全屏 PNG 逐张读入（read_image），单张 1600×2560
 * 约 1–3MB 的图片会迅速吃满模型上下文。本脚本把 uiautomator dump(XML) 解析成
 * **紧凑文本**，足以判定页面、控件、坐标、金额，避免读图。
 *
 * 用法：
 *   node scripts/evidence-inspect.mjs <file.xml>            # 紧凑列出所有有文本/desc/id 的节点
 *   node scripts/evidence-inspect.mjs <file.xml> --filter 选规格 去结算
 *   node scripts/evidence-inspect.mjs <file.xml> --settle   # 只打印结算页关键行（实付/费用/优惠）
 *   node scripts/evidence-inspect.mjs <file.xml> --clickable # 只列可点节点（找可点目标）
 *
 * 纯只读、零依赖；只读本地 XML 文本。
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error(
    '用法: node scripts/evidence-inspect.mjs <file.xml> [--settle|--clickable] [--filter kw1 kw2]',
  )
  process.exit(2)
}
const mode = args.includes('--settle')
  ? 'settle'
  : args.includes('--clickable')
    ? 'clickable'
    : 'all'
const fi = args.indexOf('--filter')
const filters = fi >= 0 ? args.slice(fi + 1).filter((a) => !a.startsWith('--')) : []

const xml = readFileSync(file, 'utf8')
const tags = xml.match(/<node\b[^>]*?\/?>/g) ?? []
const nodes = tags.map(parseNode).filter(Boolean)
const texts = nodes.map((n) => n.text || n.label || '')

function attr(s, k) {
  const m = new RegExp(k + '\\s*=\\s*"([^"]*)"').exec(s)
  return m ? decode(m[1]) : ''
}
function decode(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}
function parseNode(tag) {
  const text = attr(tag, 'text')
  const label = attr(tag, 'content-desc')
  const id = attr(tag, 'resource-id')
  const bounds = attr(tag, 'bounds')
  const clickable = attr(tag, 'clickable') === 'true'
  if (!text && !label && !id && !(clickable && bounds)) return null
  return { text, label, id, bounds, clickable, cls: attr(tag, 'class') }
}
function shortId(id) {
  return id ? id.replace(/^.*\//, '') : ''
}
function center(b) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b || '')
  if (!m) return ''
  const x = Math.round((+m[1] + +m[3]) / 2)
  const y = Math.round((+m[2] + +m[4]) / 2)
  return `${x},${y}`
}
function money(t) {
  const m = /[¥￥]\s*(-?\d+(?:\.\d{1,2})?)/.exec(t || '') || /(-?\d+(?:\.\d{1,2})?)/.exec(t || '')
  return m ? m[1] : ''
}

console.log(`== ${file} ==  节点总数 ${tags.length}，有文本/desc/id/clickable ${nodes.length}`)

if (mode === 'settle') {
  const keys = [
    '商品原价',
    '打包费',
    '餐盒费',
    '用户配送费',
    '配送费',
    '服务费',
    '满减',
    '代金券',
    '红包',
    '券前',
    '实付',
    '共减',
    '合计',
    '应付',
    '起送',
    '到手约',
  ]
  const rows = nodes.filter((n) => {
    const t = n.text || n.label || ''
    return keys.some((k) => t.includes(k)) || (n.text && /[¥￥]\s*\d/.test(n.text))
  })
  for (const n of rows) {
    console.log(
      `  ${(n.text || n.label || '').slice(0, 26).padEnd(27)} ¥${money(n.text || n.label || '').padEnd(7)} @${center(n.bounds)}`,
    )
  }
} else if (mode === 'clickable') {
  const rows = nodes.filter((n) => n.clickable)
  for (const n of rows) {
    console.log(
      `  [${shortId(n.id) || 'no-id'}] "${(n.text || n.label || '').slice(0, 22)}" @${center(n.bounds)}`,
    )
  }
} else {
  const rows = filters.length
    ? nodes.filter((n) => filters.some((k) => (n.text || n.label || '').includes(k)))
    : nodes
  for (const n of rows) {
    const t = (n.text || n.label || '').replace(/\s+/g, ' ').slice(0, 34)
    const id = shortId(n.id)
    console.log(
      `  ${t.padEnd(35)} ${id ? '[' + id + ']' : ''}${n.clickable ? ' (可点)' : ''} @${center(n.bounds)}`,
    )
  }
}

// 便捷提示：若带 --filter 没命中，给出最接近的文本片段，避免再去读图。
if (filters.length && mode === 'all') {
  const hit = nodes.filter((n) => filters.some((k) => (n.text || n.label || '').includes(k)))
  if (!hit.length) {
    console.log('\n(未命中过滤词。页面可见文本前 20 条：)')
    for (const t of texts.filter(Boolean).slice(0, 20))
      console.log('  · ' + t.replace(/\s+/g, ' ').slice(0, 40))
  }
}
