# dsh-price-agent

DSH 插件：在你自己的 Android 手机上打开外卖 App（美团 / 饿了么），按**结算页真实实付**抓价，
按平台策略（信用卡 / 会员 / 红包）折算 `effectivePrice`，横向对比给出**可信的最低价**。

- **只读**：只到结算页读价，**不自动下单、不支付**；遇验证码暂停并请人工处理。
- **隐私**：截图默认脱敏后仅存本地，不上传；信用卡只存"卡种/权益"，不存卡号。

## 状态

**方案阶段（v0.7.0）**，代码尚未实现。完整设计见 [PLAN.md](./PLAN.md)，变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 环境（详见 PLAN §4.1）

- WSL2 (Ubuntu 26.04) + Windows；Node v24.22（直接运行 `.ts`）；pnpm 12.14
- DSH `@deepseek-ai/dsh` 0.2.1-rc.2（profile `web`）
- 手机 Android 11+，开启无线调试；`adb`（`apt install android-tools-adb`）

## 目录结构（详见 PLAN §4.3 / §4.4）

```
src/
  index.ts        插件入口（组装）
  config.ts       schemastery 配置
  core/           DI / Clock / 锁
  task/           编排与生命周期（幂等/取消/重取）
  platform/       美团/饿了么策略 + 选择器
  device/         Driver 接口 + adb/mock 实现 + 状态机断言
  price/          纯核心：模型/zod 校验/折算引擎/相似度
  ocr/            OCR 接口 + tesseract/mock
  tools/          defineTool(price_agent)
test/             node --test 单测 + fixtures
```

## 开发

```bash
pnpm install
pnpm test          # node --test
pnpm typecheck     # tsc --noEmit
```

## 许可

MIT
