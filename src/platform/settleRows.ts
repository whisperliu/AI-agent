/**
 * platform/settleRows.ts — 结算页"坐标/行"抽取的**通用原语**（平台共享，无平台知识）。
 * 层：strategy。真机各平台结算页几乎无 resource-id，值靠右、标签靠左、同 y 同一行；
 * 本文件提供与具体 App 无关的几何/文案工具，供 meituanReal / elemeReal 复用，避免重复实现。
 *
 * 无 IO；输入为 `device/uixml.ts` 解析出的中性节点 `UiNode[]`。
 */
import type { Bounds, UiNode } from '../device/uixml.ts'

const MONEY_YEN_RE = /[¥￥]\s*(-?\d+(?:\.\d{1,2})?)/
const MONEY_ANY_RE = /-?\d+(?:\.\d{1,2})?/

/**
 * 从一段文案里取金额（元）；取不到返回 NaN。
 * 优先取 **¥/￥ 前缀** 的数（避免 "满30减5 -¥5.00" 误取 30），无 ¥ 时退回第一个数字。
 */
export function parseMoneyText(s: string | undefined): number {
  if (!s) return Number.NaN
  const yen = MONEY_YEN_RE.exec(s)
  const m = yen ? yen : MONEY_ANY_RE.exec(s)
  if (!m) return Number.NaN
  const n = Number.parseFloat(m[1] ?? m[0] ?? '')
  return Number.isFinite(n) ? n : Number.NaN
}

/** 纯价格文本（如 "¥19.9" / "-3.90"），不含文字标签。 */
export const PRICE_ONLY_RE = /^[¥￥\-−—\s\d.,]+$/
export const ROW_TOL_Y = 26

export interface Row {
  y0: number
  y1: number
  yc: number
  nodes: UiNode[]
}

/** 按 y 中心把有文本的节点聚成"视觉行"，行内按 x 升序。 */
export function buildRows(nodes: UiNode[], tolY = ROW_TOL_Y): Row[] {
  const rows: Row[] = []
  for (const n of nodes) {
    const t = (n.text ?? n.label ?? '').trim()
    if (!t || !n.bounds) continue
    const [, y1, , y2] = n.bounds
    const yc = (y1 + y2) / 2
    let row = rows.find((r) => Math.abs(r.yc - yc) <= tolY)
    if (!row) {
      row = { y0: y1, y1: y2, yc, nodes: [] }
      rows.push(row)
    }
    row.nodes.push(n)
    row.y0 = Math.min(row.y0, y1)
    row.y1 = Math.max(row.y1, y2)
  }
  for (const r of rows) r.nodes.sort((a, b) => a.bounds![0] - b.bounds![0])
  return rows
}

export function rowText(r: Row): string {
  return r.nodes
    .map((n) => (n.text ?? n.label ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * 节点级"标签→金额"：找文本以 label 开头的标签节点，取其**同一视觉行、右侧最近**的金额节点。
 * 比"按行合并"更稳（避免底部按钮栏被合并导致误取"极速支付"旁的金额）。
 */
export function amountNearLabel(nodes: UiNode[], keys: string[]): number {
  const labels = nodes.filter((n) => {
    const t = (n.text ?? '').trim()
    return t && n.bounds && keys.some((k) => t === k || t.startsWith(k))
  })
  for (const label of labels) {
    const lb = label.bounds!
    const lyc = (lb[1] + lb[3]) / 2
    const cands = nodes
      .filter((n) => {
        if (n === label || !n.bounds) return false
        const t = (n.text ?? '').trim()
        if (!t || !Number.isFinite(parseMoneyText(t))) return false
        const b = n.bounds
        const yc = (b[1] + b[3]) / 2
        // 同一行（|Δy| 小）且金额中心在标签中心右侧（比端点比较更能容忍轻微重叠）。
        const labelCx = (lb[0] + lb[2]) / 2
        const amountCx = (b[0] + b[2]) / 2
        return Math.abs(yc - lyc) <= 30 && amountCx > labelCx
      })
      .sort((a, b) => a.bounds![0] - b.bounds![0])
    for (const c of cands) {
      const v = parseMoneyText((c.text ?? '').trim())
      if (Number.isFinite(v)) return Math.abs(v)
    }
  }
  return Number.NaN
}

/** 找"标签行"的金额（费用行用）。 */
export function amountFromRow(nodes: UiNode[], keys: string[]): number {
  return amountNearLabel(nodes, keys)
}

/**
 * 取"标签右侧最近金额"的通用变体 B：找含 anchor 文案的节点，取其**同一行左侧**最近的金额
 * （如"¥19.9 共减¥10.98"无券前标签时，取"共减"左侧金额）。
 */
export function amountLeftOfAnchor(nodes: UiNode[], anchorPrefix: string): number {
  const anchor = nodes.find((n) => n.bounds && (n.text ?? '').trim().startsWith(anchorPrefix))
  if (!anchor?.bounds) return Number.NaN
  const ay = (anchor.bounds[1] + anchor.bounds[3]) / 2
  const left = nodes
    .filter((n) => {
      if (!n.bounds) return false
      const t = (n.text ?? '').trim()
      if (!t || !Number.isFinite(parseMoneyText(t))) return false
      const yc = (n.bounds[1] + n.bounds[3]) / 2
      return Math.abs(yc - ay) <= 30 && n.bounds[2] <= anchor.bounds![0] + 4
    })
    .sort((a, b) => b.bounds![0] - a.bounds![0])
  if (!left[0]) return Number.NaN
  const v = parseMoneyText((left[0].text ?? '').trim())
  return Number.isFinite(v) ? Math.abs(v) : Number.NaN
}

/** 搜索结果页第一张"可点结果卡"中心点：取面积最大的可点容器里、含菜品/店铺特征的那张。 */
export function firstResultCardCenter(nodes: UiNode[]): { x: number; y: number } | undefined {
  const cards = nodes
    .filter((n) => n.clickable && n.bounds)
    .map((n) => ({ n, area: (n.bounds![2] - n.bounds![0]) * (n.bounds![3] - n.bounds![1]) }))
    .filter((c) => c.area > 300_000) // 大卡片（整店条目）
    .sort((a, b) => a.n.bounds![1] - b.n.bounds![1]) // 从上到下
  const top = cards[0]?.n
  if (!top?.bounds) return undefined
  const b = top.bounds
  // 点卡片上部（店铺名区），避开菜品缩略图/加号。
  return { x: Math.round((b[0] + b[2]) / 2), y: Math.round(b[1] + (b[3] - b[1]) * 0.25) }
}

/** 第一个"文案命中关键词（含 content-desc）且可点"的控件中心点；找不到就在命中文本节点附近找可点。 */
export function firstActionableCenter(
  nodes: UiNode[],
  keywords: string[],
): { x: number; y: number } | undefined {
  const hit = nodes.find(
    (n) =>
      n.bounds && keywords.some((k) => (n.text ?? '').includes(k) || (n.label ?? '').includes(k)),
  )
  if (hit?.bounds) {
    let target: UiNode | undefined = hit.clickable ? hit : undefined
    if (!target) {
      const yc = (hit.bounds[1] + hit.bounds[3]) / 2
      const near = nodes
        .filter(
          (n) => n.clickable && n.bounds && Math.abs((n.bounds[1] + n.bounds[3]) / 2 - yc) < 40,
        )
        .sort(
          (a, b) =>
            (a.bounds![2] - a.bounds![0]) * (a.bounds![3] - a.bounds![1]) -
            (b.bounds![2] - b.bounds![0]) * (b.bounds![3] - b.bounds![1]),
        )
      target = near[0]
    }
    const b = (target ?? hit).bounds!
    return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) }
  }
  return undefined
}

/** bounds 仅用于调试打印，避免未使用告警。 */
export function describeBounds(b: Bounds | undefined): string {
  return b ? `[${b.join(',')}]` : 'n/a'
}
