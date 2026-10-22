/**
 * device/uixml.ts — 真机 uiautomator dump 的最小结构化解析（§3.5.4）。
 * 层：capability（device）。只把 XML 变成中性节点供 adb 驱动与能力探测使用，
 * **不做业务映射**（业务映射在 platform/*）。零依赖、无 IO。
 *
 * 与 platform/xml.ts 的区别：此处额外解析 `bounds`（tap 坐标）、`class`、`clickable`，
 * 供真机点击与"能力探测"判断 tree 丰富度 / WebView 迹象（§3.5.4(1)）。
 */

export type Bounds = [number, number, number, number] // [x1, y1, x2, y2]

export interface UiNode {
  index?: number
  resourceId?: string
  text?: string
  label?: string // content-desc
  className?: string
  packageName?: string
  clickable: boolean
  bounds?: Bounds
}

/** 解析全部 `<node ...>`（含嵌套，顺序保持）。 */
export function parseUiNodes(xml: string): UiNode[] {
  const out: UiNode[] = []
  const tagRe = /<node\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1] ?? ''
    const b = attr(attrs, 'bounds')
    out.push({
      index: toInt(attr(attrs, 'index')),
      resourceId: attr(attrs, 'resource-id') || undefined,
      text: attr(attrs, 'text') || undefined,
      label: attr(attrs, 'content-desc') || undefined,
      className: attr(attrs, 'class') || undefined,
      packageName: attr(attrs, 'package') || undefined,
      clickable: attr(attrs, 'clickable') === 'true',
      bounds: b ? parseBounds(b) : undefined,
    })
  }
  return out
}

/** 解析 `[x1,y1][x2,y2]`。非法返回 undefined。 */
export function parseBounds(s: string): Bounds | undefined {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

/** 控件中心点（tap 坐标）。 */
export function centerOf(b: Bounds): { x: number; y: number } {
  return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) }
}

/** 按选择器定位第一个命中节点（优先 resourceId > label > text 精确 > text 包含）。 */
export function findBySelector(
  nodes: UiNode[],
  sel: { resourceId?: string; label?: string; text?: string },
): UiNode | undefined {
  if (sel.resourceId) {
    const hit = nodes.find((n) => n.resourceId === sel.resourceId)
    if (hit) return hit
  }
  if (sel.label) {
    const hit = nodes.find((n) => n.label === sel.label || n.label?.includes(sel.label!))
    if (hit) return hit
  }
  if (sel.text) {
    const exact = nodes.find((n) => n.text === sel.text)
    if (exact) return exact
    return nodes.find((n) => n.text?.includes(sel.text!))
  }
  return undefined
}

/** 统计"可读文本节点"数（text 或 content-desc 非空）。 */
export function countTextNodes(nodes: UiNode[]): number {
  return nodes.filter((n) => (n.text && n.text.trim()) || (n.label && n.label.trim())).length
}

/** 统计带稳定 resource-id 的节点数（越少越可能动态生成/WebView）。 */
export function countResourceIds(nodes: UiNode[]): number {
  return nodes.filter((n) => !!n.resourceId).length
}

/** 是否出现 WebView 迹象（§3.5.4：dump 里出现 android.webkit.WebView 类节点）。 */
export function hasWebview(nodes: UiNode[]): boolean {
  return nodes.some((n) => (n.className ?? '').toLowerCase().includes('webview'))
}

/** 抽取所有可见文案（text/content-desc），用于弹窗/验证码识别（§3.5.2）。 */
export function visibleTexts(nodes: UiNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.text && n.text.trim()) out.push(n.text.trim())
    if (n.label && n.label.trim()) out.push(n.label.trim())
  }
  return out
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
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
}

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}
