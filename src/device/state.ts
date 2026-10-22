/**
 * device/state.ts — 状态机断言（§3.5.1）。
 * 层：capability。失败抛 `StateAssertionError`（带取证路径，§3.5.1）。
 *
 * 说明：为避免 device 依赖 platform 的 XML 解析，`presentResourceIds` 用内联属性匹配；
 * `presentTexts` 由调用方从 dump 文本层判断（platform 负责解析）。
 */
import { StateAssertionError } from '../core/errors.ts'

export interface StateAssertion {
  /** 必须出现的 resource-id（内联 XML 属性匹配）。 */
  presentResourceIds?: string[]
  /** 必须缺席的 resource-id。 */
  absentResourceIds?: string[]
}

/** 按断言校验 dump；失败抛 StateAssertionError（可带 dump/截图路径作证据）。 */
export function assertState(
  dump: string,
  a: StateAssertion,
  evidence?: { dumpPath?: string; screenshotPath?: string },
): void {
  for (const id of a.presentResourceIds ?? []) {
    if (!hasResourceId(dump, id)) {
      throw new StateAssertionError(
        `missing resourceId ${id}`,
        evidence?.dumpPath,
        evidence?.screenshotPath,
      )
    }
  }
  for (const id of a.absentResourceIds ?? []) {
    if (hasResourceId(dump, id)) {
      throw new StateAssertionError(
        `unexpected resourceId ${id}`,
        evidence?.dumpPath,
        evidence?.screenshotPath,
      )
    }
  }
}

/** XML 中是否存在带给定 resource-id 的 `<node>`。 */
export function hasResourceId(xml: string, resourceId: string): boolean {
  const esc = resourceId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp(`resource-id\\s*=\\s*"${esc}"`).test(xml)
}
