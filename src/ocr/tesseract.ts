/**
 * ocr/tesseract.ts — 真实 OCR 适配器（tesseract.js WASM，§60）。
 * 层：capability。**只实现 Ocr 接口**，不依赖 price/task/platform/device（§4.4 R5）。
 *
 * 用途：真机某些 App（如饿了么 12.9.x 平板版）整屏是 **canvas/TMS 自绘**，uiautomator
 * 读取不到任何文本节点；只能截图后 OCR。此处把 tesseract.js 的逐词结果转成 `OcrResult`
 * （含 bbox + 逐词置信），并支持 `roi` 只识别屏幕某个矩形区域（避开同屏其它面板）。
 *
 * 依赖为可选依赖：`tesseract.js` 未安装时本模块 import 会失败——因此仅在 `ocr.enabled`
 * 且 `device.driver=adb` 时由 container 动态构造，不影响 Mock/离线测试。
 */
import type { Ocr, OcrBox, OcrResult, OcrWord } from './reader.ts'

export interface TesseractOptions {
  /** 语言包，默认简中+英文。 */
  lang?: string
  /** 模型缓存目录（避免每次联网）；默认 `.price-agent/ocr-cache`。 */
  cachePath?: string
}

interface TesseractWord {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}
interface TesseractData {
  text: string
  words?: TesseractWord[]
}
interface TesseractWorker {
  recognize(
    image: Uint8Array,
    options?: { rectangle?: { left: number; top: number; width: number; height: number } },
  ): Promise<{ data: TesseractData }>
  terminate(): Promise<unknown>
}

/** 创建 tesseract OCR（惰性初始化 worker，复用；调用方负责 `close()`）。 */
export function createTesseractOcr(opts: TesseractOptions = {}): Ocr & { close(): Promise<void> } {
  const lang = opts.lang ?? 'chi_sim+eng'
  const cachePath = opts.cachePath
  let workerPromise: Promise<TesseractWorker> | null = null

  async function getWorker(): Promise<TesseractWorker> {
    if (!workerPromise) {
      workerPromise = (async () => {
        const spec = 'tesseract.js'
        const mod = (await import(spec)) as unknown as {
          createWorker: (
            lang: string,
            oem: number,
            options?: Record<string, unknown>,
          ) => Promise<TesseractWorker>
        }
        return mod.createWorker(lang, 1, {
          logger: () => {},
          ...(cachePath ? { cachePath } : {}),
        })
      })()
    }
    return workerPromise
  }

  return {
    async read(png: Uint8Array, roi?: OcrBox): Promise<OcrResult> {
      const worker = await getWorker()
      const rectangle = roi
        ? {
            left: Math.round(roi.x),
            top: Math.round(roi.y),
            width: Math.round(roi.w),
            height: Math.round(roi.h),
          }
        : undefined
      const { data } = await worker.recognize(png, rectangle ? { rectangle } : undefined)
      const words: OcrWord[] = (data.words ?? [])
        .filter((w) => (w.text ?? '').trim())
        .map((w) => ({
          t: w.text,
          c: typeof w.confidence === 'number' ? w.confidence / 100 : 0,
          bbox: {
            x: w.bbox.x0,
            y: w.bbox.y0,
            w: Math.max(0, w.bbox.x1 - w.bbox.x0),
            h: Math.max(0, w.bbox.y1 - w.bbox.y0),
          },
        }))
      return { text: data.text ?? '', words }
    },
    async close(): Promise<void> {
      if (workerPromise) {
        const w = await workerPromise
        await w.terminate()
        workerPromise = null
      }
    },
  }
}
