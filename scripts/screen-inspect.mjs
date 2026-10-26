#!/usr/bin/env node
/**
 * screen-inspect.mjs — 真机截图/证据 PNG 的**文本优先**检查器（省上下文）。
 *
 * 背景（AGENTS.md §2「真机调试 · 省上下文（强制）」）：
 *   真机 1600×2560 的 `screencap` PNG 单张约 1–3MB，直接 `read_image` 几张就会把模型上下文撑爆
 *   （2026-10-26 一次饿了么调试会话读了 28 张整屏图 → 上下文超出）。本脚本把"看图"换成两种
 *   不撑爆上下文的路径：
 *     1) **OCR → 文本**：解码 PNG → tesseract 逐词（含屏幕坐标/置信度）→ 打印紧凑文本行。
 *        绝大多数判定（页面是否到位、按钮文案、金额、坐标）用它就够，**完全不把图片读进模型**。
 *     2) **裁剪 + 缩放 → 小图**：确有必要看视觉（布局/图片文案）时，只裁关键区域并降采样，
 *        把一张 3MB 整屏图压到几十 KB 的小图再给模型看。
 *
 * 零依赖：PNG 解码/编码复用 `src/device/redact.ts`（只用 node:zlib）；OCR 仅在 `--ocr` 时才
 * 动态 import 可选依赖 `tesseract.js`（未安装则给出可读提示，不崩溃）。
 *
 * 用法：
 *   node scripts/screen-inspect.mjs <shot.png> --ocr                 # 全屏 OCR → 文本（推荐首选）
 *   node scripts/screen-inspect.mjs <shot.png> --ocr --roi 1280,0,320,2560   # 只 OCR 右栏
 *   node scripts/screen-inspect.mjs <shot.png> --ocr --filter 合计 支付 去结算  # 只打印命中关键词的行
 *   node scripts/screen-inspect.mjs <shot.png> --crop 700,2350,300,120 --scale 2 --out a.png # 裁出关键区再放大 2×(小字更清楚)
 *   node scripts/screen-inspect.mjs <shot.png> --scale 0.25 --out small.png                  # 整屏降采样到 1/4（更小更省）
 *
 * 约定：任何会产出图片的用法都必须给 `--out`，且脚本会打印最终**尺寸/字节数**；若仍偏大
 * （默认 >300KB）会警告，提示继续裁剪/降采样，避免又一次把大图读进上下文。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { decodePng, encodePng } from '../src/device/redact.ts'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--') && !/^-?\d/.test(a) && !isValueOfFlag(a))
if (!file) usage('缺少输入 PNG 路径')

function isValueOfFlag(tok) {
  // 跳过紧跟在需要取值的 flag 后面的 token（如 --roi 1,2,3,4 / --out a.png）
  const i = argv.indexOf(tok)
  if (i <= 0) return false
  const prev = argv[i - 1]
  return ['--roi', '--crop', '--scale', '--out', '--lang', '--min-conf', '--filter'].includes(prev)
}
function flag(name) {
  return argv.includes(name)
}
function val(name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
function numList(s) {
  return (s ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x))
}
function usage(msg) {
  if (msg) console.error('错误：' + msg)
  console.error(
    '用法: node scripts/screen-inspect.mjs <shot.png> [--ocr] [--roi x,y,w,h] [--filter kw…] [--min-conf 0.3]\n' +
      '       [--crop x,y,w,h] [--scale N] [--out file.png] [--max-tokens 1200]',
  )
  process.exit(2)
}

const png = readFileSync(file)
let img
try {
  img = decodePng(png)
} catch (e) {
  console.error(`无法解码 PNG（${basename(file)}）：${e.message}`)
  process.exit(3)
}

const cropArg = val('--crop', undefined)
const scaleArg = val('--scale', undefined)
const roiArg = val('--roi', undefined)
const wantOcr = flag('--ocr')
const out = val('--out', undefined)

console.log(
  `输入 ${basename(file)}：${img.width}×${img.height}，${(png.length / 1024).toFixed(0)}KB`,
)

// ── 裁剪 ──────────────────────────────────────────────────────────────
let work = img
const crop = cropArg ? numList(cropArg) : null
if (cropArg) {
  if (crop.length !== 4) usage('--crop 需要 4 个数字 x,y,w,h')
  work = cropImage(img, crop[0], crop[1], crop[2], crop[3])
  console.log(`裁剪 → ${work.width}×${work.height}（源 x=${crop[0]},y=${crop[1]}）`)
}

// ── 缩放（缩小=1/N 降采样；>1 放大=最近邻）──────────────────────────────
const scale = scaleArg ? Number(scaleArg) : 1
if (scaleArg && scale !== 1) {
  if (!(scale > 0)) usage('--scale 必须是正数')
  work = scaleImage(work, scale)
  console.log(`缩放(×${scale}) → ${work.width}×${work.height}`)
}

// ── OCR → 文本（不产出图片）─────────────────────────────────────────────
if (wantOcr) {
  await runOcr(work, {
    roi: roiArg ? numList(roiArg) : null,
    minConf: Number(val('--min-conf', '0.3')),
    filters: filterList(),
  })
  if (!out) process.exit(0) // 纯 OCR：结束
}

// ── 产出小图 ──────────────────────────────────────────────────────────
if (out) {
  const bytes = encodePng(work)
  writeFileSync(out, bytes)
  const kb = bytes.length / 1024
  // 真正撑爆上下文的是**像素数**（视觉 token ≈ 宽×高/750），不是文件字节。
  const estTokens = Math.round((work.width * work.height) / 750)
  console.log(
    `已写 ${out}：${work.width}×${work.height}，${kb.toFixed(0)}KB，≈${estTokens} 视觉token`,
  )
  const maxTokens = Number(val('--max-tokens', '1200'))
  if (estTokens > maxTokens) {
    console.warn(
      `⚠️ 估算 ${estTokens} 视觉token > 阈值 ${maxTokens} —— 读进上下文仍偏大；` +
        `请继续 --crop 只保留关键区域，或 --scale 0.5 之类降采样后再看。`,
    )
  }
} else if (!wantOcr) {
  console.error(
    '提示：未指定 --ocr 或 --out，什么都没做。加 --ocr 看文本，或 --crop/--scale 配 --out 出小图。',
  )
  process.exit(2)
}

function filterList() {
  const i = argv.indexOf('--filter')
  if (i < 0) return []
  const out = []
  for (let k = i + 1; k < argv.length; k++) {
    if (argv[k].startsWith('--')) break
    out.push(argv[k])
  }
  return out
}

// ── OCR 实现（tesseract.js，可选依赖）──────────────────────────────────
async function runOcr(image, o) {
  let createTesseractOcr
  try {
    ;({ createTesseractOcr } = await import('../src/ocr/tesseract.ts'))
  } catch (e) {
    console.error(`无法加载 tesseract.js（可选依赖未安装？）：${e.message}`)
    process.exit(4)
  }
  const ocr = createTesseractOcr({ cachePath: join(process.cwd(), '.price-agent', 'ocr-cache') })
  const roi =
    o.roi && o.roi.length === 4 ? { x: o.roi[0], y: o.roi[1], w: o.roi[2], h: o.roi[3] } : undefined
  try {
    const t0 = Date.now()
    const res = await ocr.read(encodePng(image), roi)
    const ms = Date.now() - t0
    const words = res.words.filter((w) => (w.t ?? '').trim().length > 0)
    const lines = groupLines(words)
    const filtered = o.filters.length
      ? lines.filter((ln) => o.filters.some((k) => ln.text.includes(k)))
      : lines
    console.log(
      `OCR：${words.length} 词 / ${lines.length} 行，${ms}ms` +
        (roi ? `（ROI ${roi.x},${roi.y},${roi.w},${roi.h}）` : '') +
        (o.filters.length ? `，过滤命中 ${filtered.length} 行` : ''),
    )
    for (const ln of filtered) {
      const conf = (ln.conf * 100).toFixed(0).padStart(3)
      console.log(
        `  y=${String(ln.y).padStart(4)} x=${String(ln.x).padStart(4)}  c=${conf}%  ${ln.text}`,
      )
    }
    // 置信度低的词单列，避免"把低置信当真"
    const low = words.filter((w) => w.c < o.minConf)
    if (low.length) {
      console.log(
        `  · 低置信(${low.length})：` +
          low
            .slice(0, 20)
            .map((w) => `${w.t}(${w.c.toFixed(2)})`)
            .join(' '),
      )
    }
  } finally {
    await ocr.close?.()
  }
}

/** 把逐词按行聚拢（同 y 带），行内按 x 排序；输出行首坐标供坐标判定。 */
function groupLines(words) {
  const sorted = [...words].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const lines = []
  for (const w of sorted) {
    const cy = w.bbox.y + w.bbox.h / 2
    let ln = lines.find((l) => Math.abs(l.cy - cy) <= Math.max(12, w.bbox.h * 0.6))
    if (!ln) {
      ln = { cy, x: w.bbox.x, y: Math.round(cy), words: [], confSum: 0 }
      lines.push(ln)
    }
    ln.words.push(w)
    ln.confSum += w.c
    ln.x = Math.min(ln.x, w.bbox.x)
  }
  return lines
    .map((l) => ({
      text: l.words
        .sort((a, b) => a.bbox.x - b.bbox.x)
        .map((w) => w.t)
        .join(' '),
      x: Math.round(l.x),
      y: l.y,
      conf: l.confSum / Math.max(1, l.words.length),
    }))
    .sort((a, b) => a.y - b.y)
}

// ── 图像操作（RGBA）────────────────────────────────────────────────────
function cropImage(src, x, y, w, h) {
  const x0 = clamp(x, 0, src.width)
  const y0 = clamp(y, 0, src.height)
  const x1 = clamp(x + w, 0, src.width)
  const y1 = clamp(y + h, 0, src.height)
  const cw = Math.max(1, x1 - x0)
  const ch = Math.max(1, y1 - y0)
  const data = new Uint8Array(cw * ch * 4)
  for (let row = 0; row < ch; row++) {
    const s = ((y0 + row) * src.width + x0) * 4
    data.set(src.data.subarray(s, s + cw * 4), row * cw * 4)
  }
  return { width: cw, height: ch, data }
}

function scaleImage(src, f) {
  if (f < 1) {
    // 降采样（f=缩放系数，0<f<1）：面积平均，每边缩为 f 倍
    const w = Math.max(1, Math.round(src.width * f))
    const h = Math.max(1, Math.round(src.height * f))
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx0 = Math.floor((x * src.width) / w)
        const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / w))
        const sy0 = Math.floor((y * src.height) / h)
        const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / h))
        let r = 0,
          g = 0,
          b = 0,
          a = 0,
          n = 0
        for (let yy = sy0; yy < sy1; yy++) {
          for (let xx = sx0; xx < sx1; xx++) {
            const i = (yy * src.width + xx) * 4
            r += src.data[i]
            g += src.data[i + 1]
            b += src.data[i + 2]
            a += src.data[i + 3]
            n++
          }
        }
        const o = (y * w + x) * 4
        data[o] = r / n
        data[o + 1] = g / n
        data[o + 2] = b / n
        data[o + 3] = a / n
      }
    }
    return { width: w, height: h, data }
  }
  // 放大（f>1）：最近邻
  const w = Math.max(1, Math.round(src.width * f))
  const h = Math.max(1, Math.round(src.height * f))
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / f))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / f))
      const si = (sy * src.width + sx) * 4
      const di = (y * w + x) * 4
      data[di] = src.data[si]
      data[di + 1] = src.data[si + 1]
      data[di + 2] = src.data[si + 2]
      data[di + 3] = src.data[si + 3]
    }
  }
  return { width: w, height: h, data }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}
