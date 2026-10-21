# 模块说明文档（Module Notes）

**用法（重要）**：开发某个模块时，**只读该模块这一份 `NN-*.md`**，不要去读整份 `module-spec.md`。
每份只写**本模块特有的**：职责、公开 API、内部实现要点、测试、以及"必须遵守的共享规则清单（仅列标题+§号）"。

- **共享规则不在此重复**：分层/边界见 [`../module-spec.md`](../module-spec.md) §4.4；解耦/DI/复用见 §2.1/§2.2；数据模型见 §6；异步/幂等/并发见 §7。本目录只讲"这个模块自己怎么干活"。
- **改动本文档**：只改对应模块文件；接口变了才同步 `module-spec.md` §6/§7。

| 模块 | 文档 | 层 |
|---|---|---|
| 入口 | [00-index.md](./00-index.md) | entry |
| 配置 | [05-config.md](./05-config.md) | config |
| core（装配/时钟/锁） | [10-core.md](./10-core.md) | infra |
| task（编排/生命周期） | [20-task.md](./20-task.md) | orchestration |
| platform（平台策略） | [30-platform.md](./30-platform.md) | strategy |
| device（设备/Driver） | [40-device.md](./40-device.md) | capability |
| price（纯核心） | [50-price.md](./50-price.md) | pure |
| ocr（识别） | [60-ocr.md](./60-ocr.md) | capability |
| tools（工具定义） | [70-tools.md](./70-tools.md) | entry-tool |
