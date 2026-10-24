/**
 * device/state.ts — 状态机断言（§3.5.1）。
 * 层：capability。失败抛 `StateAssertionError`（带取证路径）。
 *
 * 说明：此处的断言基于 dump 文本做内联匹配（resource-id / 文案），
 * 不依赖 platform 的 XML 解析（保持 device 层独立，§4.4）。
 */
import { StateAssertionError } from '../core/errors.ts'
import { parseUiNodes } from './uixml.ts'

export interface StateAssertion {
  /** 必须出现的 resource-id（内联 XML 属性匹配）。 */
  presentResourceIds?: string[]
  /** 必须出现的文案（正则；匹配 text 或 content-desc）。 */
  presentTexts?: RegExp[]
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
  if (a.presentTexts?.length) {
    const texts = visibleTextsOf(dump)
    for (const re of a.presentTexts) {
      if (!texts.some((t) => re.test(t))) {
        throw new StateAssertionError(
          `missing text /${re.source}/`,
          evidence?.dumpPath,
          evidence?.screenshotPath,
        )
      }
    }
  }
}

/**
 * XML 中是否存在带给定 resource-id 的 `<node>`。
 * 支持**短名后缀**：`search_button` 命中 `com.xxx:id/search_button`；全名则按精确匹配。
 * （真机 id 通常带包名前缀，而选择器写短名，故这里按 `resource-id="…<name>"` 结尾匹配。）
 */
export function hasResourceId(xml: string, resourceId: string): boolean {
  const esc = resourceId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  // 精确：resource-id="name"；后缀：resource-id="…<pkg>/name"（name 前须是 / 或引号）。
  const re = new RegExp(`resource-id\\s*=\\s*"(?:[^"]*/)?${esc}"`)
  return re.test(xml)
}

function visibleTextsOf(xml: string): string[] {
  const out: string[] = []
  for (const n of parseUiNodes(xml)) {
    if (n.text) out.push(n.text)
    if (n.label) out.push(n.label)
  }
  return out
}
