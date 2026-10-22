/**
 * core/jobs-adapter.ts — `ctx.jobs` → JobsPort 适配器（§2.2 复用 ctx.jobs）。
 * 层：infra。把 DSH 后台任务能力包成 task 需要的结构化端口，隔离具体服务。
 *
 * 任务 id 由 task 层确定性生成并传入；本适配器把它与 job 记录对齐（label/owner/kind）。
 * 取消走已登记的 producer `cancel`（abort 我们的控制器），无需依赖 caller 会话栅栏。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobHandle, JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { JobsPort, ProgressPort } from './container.ts'

// 登记本插件使用的 job kind（dsh-jobs 的 JobKindMap 通过声明合并扩展）。
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'price-compare': 'price-compare'
  }
}

export function createJobsPort(ctx: Context): JobsPort {
  const cancels = new Map<string, (reason?: string) => void>()
  const jobIds = new Map<string, string>()

  return {
    start({ taskId, label, owner, work }): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const controller = new AbortController()
        try {
          const jobId = ctx.jobs.start({
            kind: 'price-compare',
            label,
            ...(owner ? { owner: owner as SessionId } : {}),
            run(job: JobHandle): JobHooks {
              const progress: ProgressPort = {
                update: (line) => job.updateProgress(line),
                append: (line) => job.append(`${line}\n`),
              }
              const done = (async (): Promise<JobOutcome> => {
                try {
                  await work(progress, controller.signal)
                  return { status: 'completed' }
                } catch (err) {
                  if (controller.signal.aborted) return { status: 'killed', detail: 'cancelled' }
                  return {
                    status: 'failed',
                    detail: err instanceof Error ? err.message : String(err),
                  }
                }
              })()
              const cancel = (reason?: string): void => {
                if (!controller.signal.aborted) controller.abort(reason)
              }
              cancels.set(taskId, cancel)
              done.finally(() => cancels.delete(taskId))
              resolve(taskId)
              return { cancel, done }
            },
          })
          jobIds.set(taskId, jobId)
        } catch (err) {
          reject(err)
        }
      })
    },
    cancel(taskId: string): void {
      const kill = cancels.get(taskId)
      if (kill) {
        kill('cancelled')
        return
      }
      // 无本地登记时尝试直接 kill 对应 job（尽力而为）。
      const jid = jobIds.get(taskId) ?? taskId
      try {
        ctx.jobs.kill(jid as never, undefined, 'cancelled')
      } catch {
        /* 任务已终结或未知：幂等忽略 */
      }
    },
  }
}
