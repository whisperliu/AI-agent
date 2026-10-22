/**
 * platform/xml.ts — uiautomator XML 的最小结构化读取（零依赖）。
 * 层：strategy（platform）。只把 dump 变成中性节点，由策略映射为业务事实。
 *
 * 真机层级解析在 P2/P3 用 fast-xml-parser 深化；P1(Mock) 只需 resource-id / text 即可。
 */

export interface DumpNode {
  resourceId?: string
  text?: string
  label?: string
}

/** 提取 XML 中所有 `<node .../>` 的 resource-id / text / content-desc（顺序保持）。 */
export function parseNodes(xml: string): DumpNode[] {
  const out: DumpNode[] = []
  const tagRe = /<node\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1] ?? ''
    out.push({
      resourceId: attr(attrs, 'resource-id'),
      text: attr(attrs, 'text'),
      label: attr(attrs, 'content-desc'),
    })
  }
  return out
}

/** 某 resource-id 节点的 text（首个）。 */
export function textOf(xml: string, resourceId: string): string | undefined {
  for (const n of parseNodes(xml)) if (n.resourceId === resourceId) return n.text
  return undefined
}

/** 是否存在某 resource-id 节点。 */
export function hasResourceId(xml: string, resourceId: string): boolean {
  return parseNodes(xml).some((n) => n.resourceId === resourceId)
}

function attr(attrs: string, name: string): string | undefined {
  const esc = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const m = new RegExp(`${esc}\\s*=\\s*"([^"]*)"`).exec(attrs)
  return m ? decode(m[1] ?? '') : undefined
}

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
