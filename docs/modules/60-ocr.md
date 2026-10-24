# 60 · ocr（识别）`src/ocr/*`

> 层：capability。实现 `Ocr` 接口；实现文件内可用 `tesseract.js`，**不依赖 price/task/device**（§4.4）。

## 子文件职责
| 文件 | 职责 | 公开 API |
|---|---|---|
| `reader.ts` | Ocr 接口（唯一真源） | `Ocr`, `OcrResult`, `OcrWord`, `OcrBox` |
| `mock.ts` | 从预置条目返回文本+置信 | `createMockOcr(entries)` |
| `tesseract.ts` | **真实 OCR 适配器**（tesseract.js WASM，P4） | `createTesseractOcr({lang,cachePath})` → `read(png, roi)` + `close()` |

```ts
interface Ocr {
  read(png: Uint8Array, roi?: OcrBox): Promise<{ text: string; words: {t:string;c:number;bbox:OcrBox}[] }>
}
```

> 真机 tesseract 实现 `createTesseractOcr`（§60）在 **P4 接入**：`ocr.enabled=true && device.driver=adb` 时由 `core/container.ts` 构造，否则用 `createMockOcr`。逐词结果含 `bbox`+置信（0–1），支持 `roi` 只识别屏幕某矩形（避开同屏其它面板）。

## 实现要点（特有：四步质量门，§6.3.4）
1. **逐字段置信分**：`payable` 等关键字段 `c ≥ 0.8` 否则判 `low`。
2. **二次比对**：不同预处理/ROI 再识别，两次一致才认可。
3. **ROI 对照**：数字映射回截图区域核验小数点（`¥28.9` vs `¥289`）。
4. **合理性先验**：单份均价区间、缺 delivery/packing、量级同级。
> 本模块**输出** `extraction.confidence`；zod 只做算术护栏，OCR 永不单独产 `high`（最高 `medium`）。

## 本模块必须遵守的共享规则（清单）
- OCR 质量评估（先评再校验）：§6.3.4
- 证据绑定（原始识别结果留存）：§6.5

## P4 真机 OCR 兜底（饿了么 canvas 自绘）
- **背景（真机实测 2026-10，TB321FU / 饿了么 12.9.78）**：饿了么**整个 App 是 canvas/TMS 自绘**，`uiautomator dump` 全页只有 1 个 `water_mark_view` 节点——首页/搜索/结果/店铺/**结算页**都读不到任何文本/金额节点。控件树路径对饿了么**不可行**，**只能截图 OCR**。
- **ROI 裁剪**：结算页控件树里 `me.ele:id/tms_fragment_container` 的 `bounds` = 右侧结算面板（平板横屏分栏，左 0–1280 是首页）。`elemeReal.settlePanelRoi` 用它做 OCR 的 `roi`，避免把左侧首页内容混入。
- **抽取**：`elemeReal.extractElemeSettleFromOcr` 按 y 聚"视觉行"（OCR 会把中文标签拆 token：`优惠`+`后`、`免`+`配送`），行内取最右金额；映射 打包费/配送费/商品(优惠后)价/免配送费减免/实付。**"已优惠 ¥X"是整单汇总，绝不当独立 discount 叠加**（防 §5.3 重复扣）。
- **诚实性**：OCR 路径 `confidence` 永不 `high`；关键金额置信低或算术不平 → `low` → `needsConfirm`。真机实测：payable=**¥20.8** 稳定读出；某次 OCR 丢了"打包费 ¥1"的数字 → delta −1 → 如实降级 `low/needsConfirm`（不硬凑，符合 §6.3.4）。

## 测试
- `createMockOcr` 喂低置信样本 → 上层应标 `needsConfirm`（联动 price）。
- `test/platform-p4.test.ts`：`extractElemeSettleFromOcr`（合成行 + 真实脱敏 fixture `eleme-settle.ocr.json`）、`ocrMoney` 归一、`clusterOcrRows`、`settlePanelRoi`。
- 真实 tesseract 仅在集成测试/真机阶段启用（WASM 首次加载需下载语言包，走 `.price-agent/ocr-cache`）。
