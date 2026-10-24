# 05 · 配置 `src/config.ts`

> 层：config。策略字段的语义见 [§5](../module-spec.md)。

## 职责
用 **schemastery** 定义并校验插件配置；导出 `Config`。这是**唯一**的配置真源，`cordis.patch.yml` 必须与其结构一致。

## 公开 API
```ts
export const Config  // schemastery object
export type ConfigInput = Infer<typeof Config>
```

## 本模块特有字段（只列这里才有的）
| 路径 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `device.driver` | `'mock' \| 'adb'` | `mock` | P1 先 mock；P2 切 `adb` 上真机 |
| `device.serial` | string | `auto` | `auto`=唯一在线设备；或 `host:port` / 序列号 |
| `device.adbPath` | string | `adb` | adb 可执行文件路径（无系统 adb 时填 platform-tools 绝对路径） |
| `device.autoReconnect / unicodeIme` | boolean | `true` | 掉线自动 `adb connect` 重连一次（§8.3） |
| `task.stepTimeoutMs` / `pageTimeoutMs` / `taskTimeoutMs` | natural | 8000 / 20000 / 90000 | 三级超时 |
| `task.idempotencyTtlMinutes` | natural | 30 | 幂等保留期（§7.6） |
| `evidence.ttlMinutes` | natural | 10 | 证据有效期（§6.5） |
| `evidence.retainMax` | natural | 50 | 证据保留上限 |
| `ocr.enabled` | boolean | false | P1 仅 MockOcr |
| `platforms.<id>.enabled/appId/priceToleranceYuan` | — | — | 平台开关与勾稽容差（§5.1/§6.3） |

## 实现要点
- 校验失败要**点名到字段**（schemastery 原生报错即可），不吞异常。
- 敏感信息（卡号等）**不得**进配置；只存卡种/权益（§10）。
- 平台策略的复杂结构（strategies/quota）在 P1 扩展时补进 `platforms.<id>`，**不要**塞进 `task/device`。

## 本模块必须遵守的共享规则（清单）
- 策略/额度语义：§5.1–§5.6
- 数据模型字段：§6.2

## 测试
- `test/config.test.ts`：空配置套默认值；非法 `driver` 被拒。
