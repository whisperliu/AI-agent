/**
 * redact.test.ts — P5 截图默认脱敏（§6.5 / decisions §10-4）。
 * 零依赖：用 `src/device/redact.ts` 自带的 encode/decode 造图，不引入图片库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodePng,
  encodePng,
  looksSensitive,
  maskRegions,
  parseBounds,
  redactScreenshot,
  sensitiveTextRects,
  isPng,
} from '../src/device/redact.ts'

/** 造一张纯色 RGBA 图。 */
function makeImage(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0]
    data[i * 4 + 1] = rgba[1]
    data[i * 4 + 2] = rgba[2]
    data[i * 4 + 3] = rgba[3]
  }
  return { width, height, data }
}

const DUMP = `<hierarchy>
  <node text="收货人：张三 13812345678" bounds="[0,0][100,20]" />
  <node text="上海市浦东新区世纪大道100号" bounds="[0,20][120,40]" />
  <node text="实付 ¥28.9" bounds="[0,40][100,60]" />
</hierarchy>`

test('looksSensitive: phone / address / recipient / card are sensitive; price is not', () => {
  assert.equal(looksSensitive('13812345678'), true)
  assert.equal(looksSensitive('收货人 张三'), true)
  assert.equal(looksSensitive('世纪大道100号'), true)
  assert.equal(looksSensitive('银行卡 尾号 8888'), true)
  assert.equal(looksSensitive('实付 ¥28.9'), false)
  assert.equal(looksSensitive(''), false)
})

test('looksSensitive: does not false-positive on 味道赞/知道 style text (真机校准)', () => {
  // 真机 mt-s6 曾误把"11人觉得味道赞"当地址（因含"道"）；已收窄路名规则。
  assert.equal(looksSensitive('11人觉得味道赞'), false)
  assert.equal(looksSensitive('3人觉得味道赞'), false)
  assert.equal(looksSensitive('我知道了'), false)
})

test('parseBounds: parses ui bounds; invalid rejected', () => {
  assert.deepEqual(parseBounds('[10,20][110,60]'), { x: 10, y: 20, w: 100, h: 40 })
  assert.equal(parseBounds('[10,20][10,60]'), undefined) // 零宽
  assert.equal(parseBounds('nope'), undefined)
})

test('sensitiveTextRects: only sensitive nodes with bounds', () => {
  const rects = sensitiveTextRects(DUMP)
  assert.equal(rects.length, 2) // 收货人 + 地址；"实付 ¥28.9" 不算
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 100, h: 20 })
})

test('encode/decode PNG round-trips (RGBA)', () => {
  const img = makeImage(8, 6, [10, 20, 30, 255])
  const png = encodePng(img)
  assert.equal(isPng(png), true)
  const back = decodePng(png)
  assert.equal(back.width, 8)
  assert.equal(back.height, 6)
  assert.equal(back.data[0], 10)
  assert.equal(back.data[1], 20)
  assert.equal(back.data[2], 30)
  assert.equal(back.data[3], 255)
})

test('maskRegions: fills rectangle black', () => {
  const img = makeImage(10, 10, [200, 200, 200, 255])
  maskRegions(img, [{ x: 2, y: 2, w: 3, h: 3 }])
  const idx = (3 * 10 + 3) * 4 // 矩形内
  assert.deepEqual([...img.data.subarray(idx, idx + 4)], [0, 0, 0, 255])
  const outside = 0 // 矩形外
  assert.equal(img.data[outside], 200)
})

test('redactScreenshot: masks sensitive regions and returns re-encodable PNG', () => {
  const img = makeImage(200, 80, [230, 230, 230, 255])
  const png = encodePng(img)
  const r = redactScreenshot(png, DUMP)
  assert.equal(r.applied, true)
  assert.equal(r.masked, 2)
  assert.ok(r.png && r.png.length > 0)
  const out = decodePng(r.png!)
  // 收货人区域 (0,0)-(100,20) 应为黑。
  assert.deepEqual([...out.data.subarray(0, 4)], [0, 0, 0, 255])
  // 未覆盖的右下角应保持原色。
  const far = (70 * 200 + 180) * 4
  assert.equal(out.data[far], 230)
})

test('redactScreenshot: no sensitive region → applied=false (must not save original)', () => {
  const png = encodePng(makeImage(50, 50, [1, 2, 3, 255]))
  const r = redactScreenshot(
    png,
    '<hierarchy><node text="实付 ¥9.9" bounds="[0,0][50,50]"/></hierarchy>',
  )
  assert.equal(r.applied, false)
  assert.equal(r.png, undefined)
  assert.match(r.reason ?? '', /敏感区域/)
})

test('redactScreenshot: non-PNG input → applied=false', () => {
  const r = redactScreenshot(new Uint8Array([1, 2, 3]), DUMP)
  assert.equal(r.applied, false)
  assert.match(r.reason ?? '', /无法解码/)
})
