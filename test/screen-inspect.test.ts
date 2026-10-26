/**
 * screen-inspect.test.ts — 省上下文检查器（scripts/screen-inspect.mjs）的裁剪/缩放回归。
 * OCR 路径依赖 tesseract 较慢，这里只测**纯图像数学**（裁剪尺寸、降采样/放大尺寸、越界钳制），
 * 确保"只裁关键区/降采样"这条替代 read_image 的路径不会算错尺寸（算错就会again 读大图）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng, encodePng } from '../src/device/redact.ts'

const ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'screen-inspect.mjs')

function solidPng(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10
    data[i + 1] = 20
    data[i + 2] = 30
    data[i + 3] = 255
  }
  return encodePng({ width: w, height: h, data })
}

test('screen-inspect: --scale 0.5 降采样尺寸正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinspect-'))
  try {
    const src = join(dir, 'in.png')
    const out = join(dir, 'out.png')
    writeFileSync(src, solidPng(200, 100))
    execFileSync('node', [SCRIPT, src, '--scale', '0.5', '--out', out], { cwd: ROOT })
    const img = decodePng(readFileSync(out))
    assert.equal(img.width, 100)
    assert.equal(img.height, 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('screen-inspect: --crop 尺寸正确且越界被钳制', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinspect-'))
  try {
    const src = join(dir, 'in.png')
    writeFileSync(src, solidPng(200, 100))
    const out1 = join(dir, 'o1.png')
    execFileSync('node', [SCRIPT, src, '--crop', '10,10,50,20', '--out', out1], { cwd: ROOT })
    const i1 = decodePng(readFileSync(out1))
    assert.deepEqual([i1.width, i1.height], [50, 20])

    // 越界：从 180,90 取 100x100 → 只应剩 20x10
    const out2 = join(dir, 'o2.png')
    execFileSync('node', [SCRIPT, src, '--crop', '180,90,100,100', '--out', out2], { cwd: ROOT })
    const i2 = decodePng(readFileSync(out2))
    assert.deepEqual([i2.width, i2.height], [20, 10])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('screen-inspect: --scale 2 放大尺寸正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinspect-'))
  try {
    const src = join(dir, 'in.png')
    const out = join(dir, 'out.png')
    writeFileSync(src, solidPng(50, 40))
    execFileSync('node', [SCRIPT, src, '--crop', '0,0,20,10', '--scale', '2', '--out', out], {
      cwd: ROOT,
    })
    const img = decodePng(readFileSync(out))
    assert.deepEqual([img.width, img.height], [40, 20])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
