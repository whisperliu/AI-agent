/**
 * ocr/reader.ts — Ocr 接口（唯一真源，§60 / §4.4）。
 * 层：capability。**不依赖** price/task/device。
 */

export interface OcrBox {
  x: number
  y: number
  w: number
  h: number
}

export interface OcrWord {
  t: string
  c: number
  bbox: OcrBox
}

export interface OcrResult {
  text: string
  words: OcrWord[]
}

/** 识别接口：输入 PNG 字节（可限定 ROI），输出文本与逐词置信。 */
export interface Ocr {
  read(png: Uint8Array, roi?: OcrBox): Promise<OcrResult>
}
