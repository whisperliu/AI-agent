/**
 * device/redact.ts — 截图默认脱敏（P5 打磨 · §6.5 / decisions §10-4）。
 * 层：capability（device）。**零依赖**：只用 `node:zlib` 解码/编码 PNG（8-bit，非隔行），
 * 不引入 sharp/jimp 等原生库（AGENTS.md §2 依赖纪律）。
 *
 * 策略（隐私优先）：
 *  - 从 dump XML 里找出**可能含个人信息**的节点（手机号/门牌地址/收件人/支付尾号），取其 bounds；
 *  - 对截图的这些矩形填黑；
 *  - 若**无法解码 PNG** 或**未定位到任何敏感区域** → `applied=false`，调用方应**不落盘原图**
 *    （宁可不留图，也不能把未脱敏截图存下来）。
 */

import { deflateSync, inflateSync } from 'node:zlib'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ─────────────────────────────── 敏感文本识别 ───────────────────────────────

/** 手机号（11 位大陆号）、门牌/地址、收件人、支付信息 等 PII 特征。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const TEL_RE = /(?<!\d)\d{3,4}[- ]\d{4}[- ]\d{4}(?!\d)/
/** 门牌号：数字紧跟 号/栋/幢/单元/楼/层/室。 */
const DOOR_RE = /\d+\s*(?:号|栋|幢|单元|楼|层|室)/
/** 路名：大道/街道/路/街/巷/弄 + 数字（不写单字"道"，避免"味道赞"误伤）。 */
const ROAD_RE = /(?:大道|街道|路|街|巷|弄)\s*\d/
/** 具体场所名（小区/大厦/广场/公寓/花园…）。 */
const PLACE_RE = /(?:小区|大厦|广场|公寓|花园|写字楼|科技园)/
const RECIPIENT_RE = /(?:先生|女士|小姐|收件人|收货人)/
const PAYMENT_RE = /(?:尾号|银行卡|信用卡|储蓄卡)/

/** 文本是否像个人信息。保守：宁可误伤（涂黑）也不漏网。 */
export function looksSensitive(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return (
    PHONE_RE.test(t) ||
    TEL_RE.test(t) ||
    DOOR_RE.test(t) ||
    ROAD_RE.test(t) ||
    PLACE_RE.test(t) ||
    RECIPIENT_RE.test(t) ||
    PAYMENT_RE.test(t)
  )
}

/** 从 dump XML 中解析 "text=... bounds=[x1,y1][x2,y2]" 的节点，返回敏感节点矩形。 */
export function sensitiveTextRects(dumpXml: string): Rect[] {
  const rects: Rect[] = []
  const nodeRe = /<node\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = nodeRe.exec(dumpXml))) {
    const tag = m[0]
    const text = attr(tag, 'text') ?? attr(tag, 'content-desc') ?? ''
    if (!looksSensitive(text)) continue
    const bounds = attr(tag, 'bounds')
    if (!bounds) continue
    const b = parseBounds(bounds)
    if (b) rects.push(b)
  }
  return rects
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`)
  const m = re.exec(tag)
  return m ? decodeXmlEntities(m[1]!) : undefined
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** `[x1,y1][x2,y2]` → Rect。 */
export function parseBounds(s: string): Rect | undefined {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s)
  if (!m) return undefined
  const x1 = Number(m[1])
  const y1 = Number(m[2])
  const x2 = Number(m[3])
  const y2 = Number(m[4])
  if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return undefined
  return { x: x1, y: y1, w, h }
}

// ─────────────────────────────── PNG 编解码（8-bit） ───────────────────────────────

export interface DecodedImage {
  width: number
  height: number
  /** RGBA，每像素 4 字节。 */
  data: Uint8Array
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 是否 PNG 魔数。 */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b)
}

/** 解码 PNG（8-bit，非隔行，支持灰度/RGB/灰度+A/RGBA）→ RGBA。失败抛错。 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (!isPng(bytes)) throw new Error('不是 PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Uint8Array[] = []
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(
      bytes[off + 4]!,
      bytes[off + 5]!,
      bytes[off + 6]!,
      bytes[off + 7]!,
    )
    off += 8
    const data = bytes.subarray(off, off + len)
    off += len + 4 // 跳过 CRC
    if (type === 'IHDR') {
      width = view.getUint32(off - len - 4)
      height = view.getUint32(off - len - 4 + 4)
      bitDepth = bytes[off - len - 4 + 8]!
      colorType = bytes[off - len - 4 + 9]!
      if (bytes[off - len - 4 + 12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`)
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const raw = inflateSync(concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let prev: Uint8Array<ArrayBufferLike> = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!
    const row = raw.subarray(p, p + stride)
    p += stride
    const cur = unfilter(filter, row, prev, channels)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (channels === 4) {
        out[o] = cur[x * 4]!
        out[o + 1] = cur[x * 4 + 1]!
        out[o + 2] = cur[x * 4 + 2]!
        out[o + 3] = cur[x * 4 + 3]!
      } else if (channels === 3) {
        out[o] = cur[x * 3]!
        out[o + 1] = cur[x * 3 + 1]!
        out[o + 2] = cur[x * 3 + 2]!
        out[o + 3] = 255
      } else if (channels === 2) {
        const g = cur[x * 2]!
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
        out[o + 3] = cur[x * 2 + 1]!
      } else {
        const g = cur[x]!
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
        out[o + 3] = 255
      }
    }
    prev = cur
  }
  return { width, height, data: out }
}

function unfilter(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length)
  for (let i = 0; i < row.length; i++) {
    const raw = row[i]!
    const a = i >= bpp ? out[i - bpp]! : 0
    const b = prev[i]!
    const c = i >= bpp ? prev[i - bpp]! : 0
    let v: number
    switch (filter) {
      case 0:
        v = raw
        break
      case 1:
        v = raw + a
        break
      case 2:
        v = raw + b
        break
      case 3:
        v = raw + ((a + b) >> 1)
        break
      case 4:
        v = raw + paeth(a, b, c)
        break
      default:
        throw new Error(`未知 PNG 过滤器 ${filter}`)
    }
    out[i] = v & 0xff
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 把 RGBA 编码为 PNG（filter=0，8-bit RGBA）。 */
export function encodePng(img: DecodedImage): Uint8Array {
  const { width, height, data } = img
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter: none
    raw.set(data.subarray(y * stride, (y + 1) * stride), rowStart + 1)
  }
  const idat = deflateSync(raw)

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ]
  return concat([Uint8Array.from(PNG_SIG), ...chunks])
}

/** 对解码后的 RGBA 图，把若干矩形填黑（不透明）。 */
export function maskRegions(img: DecodedImage, regions: Rect[]): void {
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(img.width, Math.ceil(r.x + r.w))
    const y1 = Math.min(img.height, Math.ceil(r.y + r.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4
        img.data[o] = 0
        img.data[o + 1] = 0
        img.data[o + 2] = 0
        img.data[o + 3] = 255
      }
    }
  }
}

export interface RedactResult {
  /** 是否实际做了脱敏（true 才可以安全落盘）。 */
  applied: boolean
  /** 脱敏后的 PNG（applied=false 时为 undefined）。 */
  png?: Uint8Array
  /** 实际掩码的区域数（诊断用）。 */
  masked: number
  /** 未应用原因（applied=false 时给出）。 */
  reason?: string
}

/**
 * 一站式：给定原始截图与 dump XML，定位敏感区域并掩码。
 * 无法解码 / 无敏感区域 → `applied=false`（调用方**不得**保存原图）。
 */
/**
 * 从 **OCR 逐词结果**里找敏感词矩形（canvas 自绘页面没有 dump XML，只能靠 OCR 文本定位）。
 *
 * 2026-10-27 真机：饿了么整页 canvas 自绘 → `facts.dump` 是 OCR 纯文本、**没有 bounds**，
 * 于是 `redactScreenshot(png, dumpText)` 永远"定位不到敏感区域"→ 截图永不落盘
 * （真机表现：`redaction=none, shot=-`，证据链缺失）。本函数补上这条路径：
 * 把 OCR 词里像 PII 的词（手机号/地址/门牌/收件人）按它自己的 bbox 转成待涂黑矩形。
 */
export function sensitiveOcrRects(
  words: { t?: string; bbox?: { x: number; y: number; w: number; h: number } }[],
): Rect[] {
  const rects: Rect[] = []
  for (const w of words) {
    const t = (w.t ?? '').trim()
    if (!t || !w.bbox) continue
    if (!looksSensitive(t)) continue
    const { x, y, w: bw, h } = w.bbox
    if (bw > 0 && h > 0) rects.push({ x, y, w: bw, h })
  }
  return rects
}

export function redactScreenshot(
  png: Uint8Array,
  dumpXml: string,
  extra: Rect[] = [],
): RedactResult {
  let img: DecodedImage
  try {
    img = decodePng(png)
  } catch (err) {
    return {
      applied: false,
      masked: 0,
      reason: `截图无法解码：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const regions = [...sensitiveTextRects(dumpXml), ...extra]
  // 夹到画布内，过滤完全在画布外的区域。
  const effective = regions.filter(
    (r) => r.x < img.width && r.y < img.height && r.x + r.w > 0 && r.y + r.h > 0,
  )
  if (effective.length === 0) {
    return { applied: false, masked: 0, reason: '未定位到敏感区域（无法确认已脱敏）' }
  }
  maskRegions(img, effective)
  return { applied: true, png: encodePng(img), masked: effective.length }
}

// ─────────────────────────────── 内部小工具 ───────────────────────────────

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** CRC32（PNG 标准多项式）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
