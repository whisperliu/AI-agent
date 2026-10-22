# 60 · ocr（识别）`src/ocr/*`

> 层：capability。实现 `Ocr` 接口；实现文件内可用 `tesseract.js`，**不依赖 price/task/device**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `reader.ts` | Ocr 接口（唯一真源） | `Ocr`, `OcrResult`, `OcrWord`, `OcrBox` |
| `mock.ts` | 从预置条目返回文本+置信 | `createMockOcr(entries)` |

```ts
interface Ocr {
  read(png: Uint8Array, roi?: OcrBox): Promise<{ text: string; words: {t:string;c:number;bbox:OcrBox}[] }>
}
```

> 真机 tesseract 实现（`createTesseractOcr`）在 P3 接入；P1 用 `createMockOcr`。

## 实现要点（特有：四步质量门，§6.3.4）
1. **逐字段置信分**：`payable` 等关键字段 `c ≥ 0.8` 否则判 `low`。
2. **二次比对**：不同预处理/ROI 再识别，两次一致才认可。
3. **ROI 对照**：数字映射回截图区域核验小数点（`¥28.9` vs `¥289`）。
4. **合理性先验**：单份均价区间、缺 delivery/packing、量级同级。
> 本模块**输出** `extraction.confidence`；zod 只做算术护栏，OCR 永不单独产 `high`（最高 `medium`）。

## 本模块必须遵守的共享规则（清单）
- OCR 质量评估（先评再校验）：§6.3.4
- 证据绑定（原始识别结果留存）：§6.5

## 测试
- `createMockOcr` 喂低置信样本 → 上层应标 `needsConfirm`（联动 price）。
- 真实 tesseract 仅在集成测试/真机阶段启用。
