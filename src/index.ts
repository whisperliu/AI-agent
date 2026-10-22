/**
 * src/index.ts — 插件入口（§00-index）。
 * 层：entry（只装配，无业务）。
 *
 * 导出 cordis 插件契约：{ name, inject, apply, Config }。
 * apply 只做三件事：① 打开任务存储领域；② buildCapabilities 组装能力与端口；③ 注册 price_agent 工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { AppConfig } from './config.ts'
import { Config } from './config.ts'
import { buildCapabilities, TaskDomainSpec } from './core/container.ts'
import type { JobsPort } from './core/container.ts'
import { createJobsPort } from './core/jobs-adapter.ts'
import { recoverOnStartup } from './task/lifecycle.ts'
import { priceAgentTool } from './tools/price-agent.ts'

export const name = 'price-agent'

/** Services required from the composed DSH tree. */
export const inject = ['tools', 'jobs', 'storageDomain'] as const

/** 结果/证据落盘根目录（本地、脱敏、不入库；§5.5 隐私）。 */
function dataDir(): string {
  return process.env.DSH_PRICE_AGENT_DATA ?? join(process.cwd(), '.price-agent')
}

/** 注册插件：装配依赖并注册工具（不写业务逻辑）。 */
export async function apply(ctx: Context, config: AppConfig): Promise<void> {
  const domain = await ctx.storageDomain.open(TaskDomainSpec)
  ctx.effect(() => () => domain.close(), 'price-agent:close-domain')

  const caps = buildCapabilities(config, { dataDir: dataDir() })
  const jobs: JobsPort = createJobsPort(ctx)

  const deps = { ...caps, jobs, tasks: domain, config }
  await recoverOnStartup(deps)

  ctx.tools.register(priceAgentTool(deps))
}

export { Config }
