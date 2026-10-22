/**
 * Smoke test: proves the test runner + schemastery runtime are wired.
 * Real coverage starts in P0 (price engine). See PLAN §9.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.ts'

test('Config applies defaults', () => {
  const c = Config({}) as {
    device: { driver: string; serial: string; adbPath: string; autoReconnect: boolean }
    task: { taskTimeoutMs: number }
  }
  assert.equal(c.device.driver, 'mock')
  assert.equal(c.device.serial, 'auto')
  assert.equal(c.device.adbPath, 'adb')
  assert.equal(c.device.autoReconnect, true)
  assert.equal(c.task.taskTimeoutMs, 90000)
})

test('Config accepts adb driver with custom adbPath/serial', () => {
  const c = Config({
    device: {
      driver: 'adb',
      serial: '192.168.1.8:5555',
      adbPath: '/opt/adb',
      autoReconnect: false,
    },
  }) as { device: { driver: string; serial: string; adbPath: string; autoReconnect: boolean } }
  assert.equal(c.device.driver, 'adb')
  assert.equal(c.device.serial, '192.168.1.8:5555')
  assert.equal(c.device.adbPath, '/opt/adb')
  assert.equal(c.device.autoReconnect, false)
})

test('Config rejects invalid driver', () => {
  assert.throws(() => Config({ device: { driver: 'nope' as unknown as 'mock' } }))
})
