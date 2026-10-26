/**
 * tools/price-agent.ts — 模型可见工具 `price_agent`（§70-tools）。
 * 层：entry-tool。只调用 `task/*` 与 `price/model`；**不**直接碰 device/ocr 实现或 ctx.jobs/storageDomain。
 *
 * 设计：把可测的业务分派抽成 `dispatch(deps, args)`（纯逻辑，测试直接调用），
 * defineTool 只做参数 schema、异步执行与呈现，便于离线单测全链路。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Deps } from '../core/container.ts'
import type {
  CancelReply,
  CompareResult,
  DeviceProbeReply,
  GetResultReply,
  MinExperimentReply,
  StartReply,
  TaskSummary,
} from '../price/model.ts'
import {
  cancel,
  getResult,
  listTasks,
  probeDevice,
  runMinExperiment,
  startTask,
} from '../task/lifecycle.ts'

export type PriceAction = 'start' | 'getResult' | 'listTasks' | 'cancel' | 'probe' | 'selfCheck'

export interface PriceAgentArgs {
  action: PriceAction
  item?: string
  city?: string
  platforms?: string[]
  idempotencyKey?: string
  force?: boolean
  taskId?: string
  options?: { maxResults?: number; useOcr?: boolean }
}

export type PriceAgentReply =
  | { action: 'start'; reply: StartReply }
  | { action: 'getResult'; reply: GetResultReply }
  | { action: 'listTasks'; reply: TaskSummary[] }
  | { action: 'cancel'; reply: CancelReply }
  | { action: 'probe'; reply: DeviceProbeReply }
  | { action: 'selfCheck'; reply: MinExperimentReply }

/**
 * 清洗成 DSH 认可的「lossless JSON」：DSH 严格拒绝 `undefined`（对象里的可选字段、数组元素），
 * 也拒绝 `NaN`/`Infinity`/`-0`、`Date`、类实例等不可无损 JSON 的值。
 *
 * 背景（P5 回归）：`getResult` 的 reply 常带 `note: undefined`（证据未清理时）、
 * 非完成态带 `error: undefined`；`listTasks` 行的 `finishedAt` 也可能缺省。
 * 这些 `undefined` 会让整个工具输出被判 `invalid output: value is not lossless JSON`，
 * 模型侧拿不到结果。此处在返回前做一次无损 JSON 往返清洗（丢 `undefined`、NaN→null）。
 */
export function toLosslessJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** 业务分派（可离线单测；不经过 defineTool / ToolRunContext）。 */
export async function dispatch(
  deps: Deps,
  args: PriceAgentArgs,
  ctx?: { owner?: string },
): Promise<PriceAgentReply> {
  switch (args.action) {
    case 'start': {
      if (!args.item || !args.item.trim()) throw new Error('start 需要 item（菜品关键词）')
      const reply = await startTask(
        deps,
        {
          item: args.item,
          city: args.city,
          platforms: args.platforms,
          idempotencyKey: args.idempotencyKey,
          force: args.force,
          options: args.options,
        },
        { owner: ctx?.owner },
      )
      return { action: 'start', reply }
    }
    case 'getResult': {
      if (!args.taskId) throw new Error('getResult 需要 taskId')
      const reply = await getResult(deps, args.taskId)
      return { action: 'getResult', reply: toLosslessJson(reply) as unknown as GetResultReply }
    }
    case 'listTasks': {
      const reply = listTasks(deps, ctx?.owner)
      return { action: 'listTasks', reply: toLosslessJson(reply) as unknown as TaskSummary[] }
    }
    case 'cancel': {
      if (!args.taskId) throw new Error('cancel 需要 taskId')
      const reply = await cancel(deps, args.taskId)
      return { action: 'cancel', reply }
    }
    case 'probe': {
      const reply = await probeDevice(deps)
      return { action: 'probe', reply }
    }
    case 'selfCheck': {
      const reply = await runMinExperiment(deps)
      return { action: 'selfCheck', reply }
    }
    default:
      throw new Error(`unknown action: ${String((args as { action?: unknown }).action)}`)
  }
}

/** 把回复渲染成模型可读的文本（含比价表）。 */
export function renderReply(reply: PriceAgentReply): ContentBlock[] {
  const text = formatReply(reply)
  return [{ type: 'text', text }]
}

/** 格式化（纯函数，便于单测）。 */
export function formatReply(reply: PriceAgentReply): string {
  switch (reply.action) {
    case 'start':
      return `已开始比价（taskId=${reply.reply.taskId}，status=${reply.reply.status}）：${reply.reply.message}`
    case 'cancel':
      return `取消结果：${reply.reply.outcome}（status=${reply.reply.status}）`
    case 'listTasks':
      if (reply.reply.length === 0) return '没有未消费的已完成任务'
      return reply.reply.map((t) => `- ${t.taskId} · ${t.status} · ${t.phase}`).join('\n')
    case 'getResult':
      return formatGetResult(reply.reply)
    case 'probe':
      return formatProbe(reply.reply)
    case 'selfCheck':
      return formatSelfCheck(reply.reply)
  }
}

function formatProbe(r: DeviceProbeReply): string {
  if (!r.supported) return `设备能力探测：不支持 — ${r.message ?? ''}`
  if (!r.probe) return `设备能力探测：${r.message ?? '未取得结果'}`
  const p = r.probe
  const L = ['设备能力探测报告：']
  L.push(`- 机型：${p.model ?? '?'} / Android ${p.androidVersion ?? '?'}`)
  L.push(`- 分辨率：${p.resolution ?? '?'} @ ${p.density ?? '?'}dpi`)
  L.push(`- 前台包名：${p.foreground ?? '?'}`)
  L.push(`- dump 可用：${p.canDump}（${p.dumpLatencyMs ?? '?'}ms）｜截屏可用：${p.canScreenshot}`)
  if (p.quality) {
    L.push(
      `- 页面识别质量：文本节点 ${p.quality.textNodes} / 资源 id ${p.quality.resourceIds} / WebView ${p.quality.hasWebview} / 丰富度 ${p.quality.treeRichness} → 建议 ${p.quality.recommend}`,
    )
  }
  return L.join('\n')
}

function formatSelfCheck(r: MinExperimentReply): string {
  if (!r.supported) return `§8.4 最小实验：不支持 — ${r.message}`
  const L = [`§8.4 无线调试最小实验：${r.ok ? 'PASS ✅' : 'FAIL ❌'}`]
  for (const c of r.checks) L.push(`- [${c.ok ? 'x' : ' '}] ${c.name}：${c.detail}`)
  if (!r.ok) L.push(`提示：${r.message}`)
  return L.join('\n')
}

function formatGetResult(r: GetResultReply): string {
  if (r.status === 'expired') return `任务 ${r.taskId}：${r.note ?? '结果已过期，请重新核价'}`
  if (r.status !== 'completed' || !r.result) {
    const err = r.error ? `（${r.error.reason}: ${r.error.message}）` : ''
    return `任务 ${r.taskId}：status=${r.status}${err}`
  }
  const table = formatCompareResult(r.result)
  // 证据降级说明（P5）：如截图已被本地留存策略清理，提示需重新核价。
  return r.note ? `${table}\n· ${r.note}` : table
}

/** 分组比价表（纯函数）。 */
export function formatCompareResult(result: CompareResult): string {
  const lines: string[] = []
  lines.push(`比价结果（taskId=${result.taskId}）`)
  for (const g of result.groups) {
    lines.push(`\n组「${g.key}」${g.comparable ? '(可比)' : '(不可比，不参与最低价)'}`)
    lines.push('平台 | 实付(payable) | 综合到手(effective) | 可信度 | 需复核')
    for (const q of g.quotes) {
      const eff = q.effectivePrice ?? q.payable
      lines.push(
        `${q.platform} | ¥${q.payable.toFixed(2)} | ¥${eff.toFixed(2)} | ${q.extraction.confidence} | ${q.needsConfirm ? '是' : '否'}`,
      )
    }
  }
  if (result.cheapest) {
    const c = result.cheapest
    lines.push(
      `\n最便宜（同组可比、可信、未过期）：${c.platform} ¥${(c.effectivePrice ?? c.payable).toFixed(2)}`,
    )
  } else {
    lines.push('\n无可信最低价（见下方提示）')
  }
  for (const n of result.note) lines.push(`· ${n}`)
  return lines.join('\n')
}

/** 构造 `price_agent` 工具定义（defineTool）。 */
export function priceAgentTool(deps: Deps): ToolDefinition {
  return defineTool({
    name: 'price_agent',
    description:
      '手机外卖比价：在本机美团/饿了么 App 读取结算页“到手价”并横向对比（只读、绝不代下单/支付）。' +
      '异步：start 立即返回 taskId；用 getResult(taskId) 取分组比价表，listTasks 补取，cancel 取消。',
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'getResult', 'listTasks', 'cancel', 'probe', 'selfCheck'],
        required: true,
        description:
          'start=发起比价; getResult=取结果; listTasks=列未消费结果; cancel=取消; probe=设备能力探测(真机); selfCheck=§8.4 无线调试最小实验(真机)',
      },
      item: { type: 'string', description: '菜品关键词，如“香叶 烤鸭饭”（start 必填）' },
      city: { type: 'string', description: '城市（可选，默认上海）' },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: '平台 id 列表（可选，如 ["meituan","eleme"]）',
      },
      idempotencyKey: { type: 'string', description: '显式幂等键（可选；缺省系统按快照计算）' },
      force: { type: 'boolean', description: '强制重跑：忽略既有幂等记录（用于卡死/失败态重试）' },
      taskId: { type: 'string', description: '任务 id（getResult/cancel 必填）' },
      options: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxResults: { type: 'integer', description: '每平台最多候选数' },
          useOcr: { type: 'boolean', description: '是否允许 OCR 兜底（P1 仅 Mock）' },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderReply(value as unknown as PriceAgentReply),
    },
    async execute(args, exec): Promise<JsonValue> {
      const owner = exec.agent?.id
      const reply = await dispatch(deps, args as unknown as PriceAgentArgs, { owner })
      // 最后一道兜底：任何 action 的可选字段缺省（undefined）都清洗掉，避免整个工具输出被判非法。
      return toLosslessJson(reply)
    },
  })
}
