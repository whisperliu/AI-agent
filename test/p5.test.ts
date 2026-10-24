/**
 * p5.test.ts — P5 打磨：证据落盘/脱敏绑定、TTL+保留上限清理（§6.5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindEvidence } from '../src/task/runner.ts'
import { cleanupEvidence, cleanupResults } from '../src/task/cleanup.ts'
import { encodePng } from '../src/device/redact.ts'
import { makeEnv } from './p1-env.ts'
import type { RawQuoteFacts } from '../src/platform/types.ts'

const DUMP = `<hierarchy>
  <node text="收货人 李四 13900000000" bounds="[0,0][120,20]" />
  <node text="实付 ¥19.9" bounds="[0,40][100,60]" />
</hierarchy>`

function facts(over: Partial<RawQuoteFacts> = {}): RawQuoteFacts {
  return {
    storeName: '测试店',
    itemName: '烤鸭饭',
    qty: 1,
    fees: [{ kind: 'goods', label: '商品', amount: 19.9, source: 'tree' }],
    discounts: [],
    payable: 19.9,
    confidence: 'high',
    byField: { payable: 'tree' },
    dump: DUMP,
    ...over,
  }
}

function grayPng(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) data.fill(200, i * 4, i * 4 + 3)
  return encodePng({ width: w, height: h, data })
}

test('bindEvidence: writes dump + redacted screenshot, marks redaction=applied', async () => {
  const env = await makeEnv()
  try {
    const shot = grayPng(200, 80)
    const bound = await bindEvidence(env.deps, facts({ screenshot: shot }), 'q-p5-1')
    assert.equal(bound.redaction, 'applied')
    assert.ok(bound.dumpPath?.endsWith('q-p5-1.xml'))
    assert.ok(bound.screenshotPath?.endsWith('q-p5-1.png'))
    // dump 原样落盘
    assert.match(await readFile(bound.dumpPath!, 'utf8'), /收货人/)
    // 截图确实是 PNG 且已掩码（第一像素黑）
    const png = await readFile(bound.screenshotPath!)
    assert.equal(png[0], 0x89)
    const { decodePng } = await import('../src/device/redact.ts')
    const decoded = decodePng(new Uint8Array(png))
    assert.deepEqual([...decoded.data.subarray(0, 4)], [0, 0, 0, 255])
    assert.equal(bound.missingReason, undefined)
  } finally {
    await env.cleanup()
  }
})

test('bindEvidence: cannot redact (no sensitive region) → screenshot NOT saved, reason recorded', async () => {
  const env = await makeEnv()
  try {
    const shot = grayPng(40, 40)
    const safeDump = '<hierarchy><node text="实付 ¥9.9" bounds="[0,0][40,40]"/></hierarchy>'
    const bound = await bindEvidence(
      env.deps,
      facts({ screenshot: shot, dump: safeDump }),
      'q-p5-2',
    )
    assert.equal(bound.screenshotPath, undefined)
    assert.equal(bound.redaction, 'none')
    assert.match(bound.missingReason ?? '', /截图未落盘/)
    // 确认目录里没有这张截图
    await assert.rejects(() => stat(join(env.deps.dataDir, 'evidence', 'q-p5-2.png')))
  } finally {
    await env.cleanup()
  }
})

test('draftFromFacts: evidence carries bound dump/screenshot + ocrText for OCR facts', async () => {
  const { draftFromFacts } = await import('../src/task/runner.ts')
  const env = await makeEnv()
  try {
    const plan = {
      taskId: 't',
      cond: {
        snapshotId: 's',
        item: '烤鸭饭',
        qty: 1,
        spec: [],
        composition: [],
        deliverTo: { city: '上海', lat: 1, lng: 1 },
        fixedAt: '2026-10-22T12:00:00+08:00',
        hash: 'h',
      },
      platforms: [],
    }
    const ocrFacts = facts({
      byField: { payable: 'ocr' },
      dump: 'OCR TEXT 实付 19.9',
      confidence: 'low',
    })
    const draft = draftFromFacts(ocrFacts, 'eleme', plan, env.deps, 'q-ocr', {
      dumpPath: undefined,
      screenshotPath: '/tmp/x.png',
      redaction: 'applied',
    })
    assert.equal(draft.evidence.rawExtraction.ocrText, 'OCR TEXT 实付 19.9')
    assert.equal(draft.evidence.screenshotPath, '/tmp/x.png')
    assert.equal(draft.evidence.redaction, 'applied')
  } finally {
    await env.cleanup()
  }
})

test('cleanupEvidence: deletes by age (retainDays) and by count (retainMax)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cleanup-ev-'))
  try {
    const now = Date.parse('2026-10-24T12:00:00+08:00')
    // 老文件（10 天前）→ 超 retainedays(7) 删
    const old = join(dir, 'old.xml')
    await writeFile(old, 'x')
    await utimes(old, new Date(now - 10 * 86400_000), new Date(now - 10 * 86400_000))
    // 新文件 5 组，retainMax=2 → 保留最新 2 组
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `g${i}.xml`)
      await writeFile(p, 'x')
      const t = new Date(now - i * 60_000) // g0 最新
      await utimes(p, t, t)
    }
    const stats = await cleanupEvidence({ dir, retainMax: 2, retainDays: 7, now })
    assert.equal(stats.expired, 1)
    assert.equal(stats.overLimit, 3) // g2 g3 g4 被删
    assert.equal(stats.kept, 2) // g0 g1
    await assert.rejects(() => stat(old))
    await assert.rejects(() => stat(join(dir, 'g4.xml')))
    await stat(join(dir, 'g0.xml'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanupEvidence: missing dir is a no-op (does not throw)', async () => {
  const stats = await cleanupEvidence({
    dir: join(tmpdir(), 'definitely-not-exist-xyz'),
    retainMax: 10,
    retainDays: 7,
    now: Date.now(),
  })
  assert.deepEqual(stats, { deleted: 0, kept: 0, expired: 0, overLimit: 0 })
})

test('cleanupResults: deletes only expired result files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cleanup-res-'))
  try {
    const now = Date.parse('2026-10-24T12:00:00+08:00')
    const fresh = join(dir, 'a.json')
    const stale = join(dir, 'b.json')
    await writeFile(fresh, '{}')
    await writeFile(stale, '{}')
    await utimes(fresh, new Date(now - 60_000), new Date(now - 60_000))
    await utimes(stale, new Date(now - 30 * 86400_000), new Date(now - 30 * 86400_000))
    const stats = await cleanupResults({ dir, retainMax: 0, retainDays: 7, now })
    assert.equal(stats.expired, 1)
    assert.equal(stats.kept, 1)
    await stat(fresh)
    await assert.rejects(() => stat(stale))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

void mkdir

test('formatGetResult: appends evidence-degradation note after the table', async () => {
  const { formatReply } = await import('../src/tools/price-agent.ts')
  const text = formatReply({
    action: 'getResult',
    reply: {
      taskId: 't1',
      status: 'completed',
      note: '1 条报价的截图证据已清理（本地留存策略），如需复核请重新核价',
      result: {
        taskId: 't1',
        query: {
          snapshotId: 's',
          item: '烤鸭饭',
          qty: 1,
          spec: [],
          composition: [],
          deliverTo: { city: '上海', lat: 1, lng: 1 },
          fixedAt: '2026-10-22T12:00:00+08:00',
          hash: 'h',
        },
        groups: [],
        cheapest: null,
        note: [],
      },
    },
  })
  assert.match(text, /比价结果/)
  assert.match(text, /截图证据已清理/)
})
