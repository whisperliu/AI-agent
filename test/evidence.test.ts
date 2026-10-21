/**
 * evidence.test.ts — 证据 TTL / 完整性（docs/module-spec.md §6.5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceComplete, evidenceGap, isExpired, remainingMs } from '../src/price/evidence.ts'
import { evidence, NOW } from './helpers.ts'

test('isExpired: future validUntil is not expired', () => {
  assert.equal(isExpired(evidence(), NOW), false)
})

test('isExpired: past validUntil is expired', () => {
  assert.equal(isExpired(evidence({ validUntil: '2026-10-22T11:00:00+08:00' }), NOW), true)
})

test('isExpired: unparsable time treated as expired (conservative)', () => {
  assert.equal(isExpired(evidence({ validUntil: 'not-a-date' }), NOW), true)
})

test('evidenceComplete: dump/ocr/screenshot any one is enough', () => {
  assert.equal(evidenceComplete(evidence()), true) // has treeDumpPath + screenshot
  assert.equal(evidenceComplete({ rawExtraction: {}, screenshotPath: undefined }), false)
  assert.equal(
    evidenceComplete({ rawExtraction: { ocrText: 'x' }, screenshotPath: undefined }),
    true,
  )
})

test('evidenceGap: explains missing evidence', () => {
  assert.equal(evidenceGap(evidence()), undefined) // 有 dump/截图 -> 无 gap
  assert.match(evidenceGap({ rawExtraction: {}, screenshotPath: undefined }) as string, /证据缺失/)
})

test('remainingMs is positive before expiry', () => {
  assert.ok(remainingMs(evidence(), NOW) > 0)
})
