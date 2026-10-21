/**
 * Smoke test: proves the test runner + schemastery runtime are wired.
 * Real coverage starts in P0 (price engine). See PLAN §9.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.ts'

test('Config applies defaults', () => {
  const c = Config({}) as {
    device: { driver: string }
    task: { taskTimeoutMs: number }
  }
  assert.equal(c.device.driver, 'mock')
  assert.equal(c.task.taskTimeoutMs, 90000)
})
