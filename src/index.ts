/**
 * dsh-price-agent —— plugin entry.
 *
 * Layer: entry (assembly only, no business logic). See PLAN §4.4.
 * P0/P1 will register the `price_agent` tool here via `ctx.tools.register(defineTool(...))`.
 *
 * Exports are the cordis plugin contract: { name, inject, apply, Config }.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'price-agent'

/** Services required from the composed DSH tree. */
export const inject = ['tools'] as const

/**
 * Register the plugin. No-op skeleton; the tool registration lands in P1.
 * @param _ctx cordis context carrying the composed services.
 */
export function apply(_ctx: Context): void {
  // P1: _ctx.tools.register(defineTool(priceAgentTool))
}

export { Config } from './config.ts'
