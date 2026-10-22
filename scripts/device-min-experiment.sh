#!/usr/bin/env bash
# device-min-experiment.sh — §8.4 WSL2 无线调试最小可验证实验（10 分钟判定 P2 门槛）
#
# 判定标准（全部满足才算 PASS）：
#   1. adb devices 目标设备状态为 device（非 offline/空）
#   2. uiautomator dump 输出非空 XML，且含可读文本节点
#   3. screencap 得到有效 PNG
#   4. adb disconnect 后能 adb connect 自动重连 1 次成功
#
# 用法（WSL2 内）：
#   ADB=./.home/android-sdk/platform-tools/adb \
#   HOME=$(mktemp -d) \
#   ./scripts/device-min-experiment.sh 192.168.1.8 5555
#
# 参数：<手机IP> <调试端口>（端口见手机「无线调试」页面当前值）
# 说明：本脚本只读探活/dump/截屏，**绝不下单/支付**（AGENTS.md §0）。
set -u

IP="${1:-}"
PORT="${2:-}"
ADB="${ADB:-adb}"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
say()  { printf '%s\n' "$*"; }

if [ -z "$IP" ] || [ -z "$PORT" ]; then
  red "用法: $0 <手机IP> <调试端口>   （ADB=<adb路径> 可选，HOME 需可写）"
  exit 2
fi

SERIAL="$IP:$PORT"
say "== 0) adb 版本 =="
"$ADB" version || { red "adb 不可用：请设置 ADB 指向 platform-tools/adb，且 HOME 可写"; exit 1; }

say ""
say "== 1) 同网段检查（ping 手机）=="
if ping -c 3 "$IP" >/dev/null 2>&1; then grn "ping OK：$IP"; else
  red "ping 不通：WSL 可能处于 NAT；用 Windows 侧端口转发或 adb -H <windows-ip>"; fi

say ""
say "== 2) 连接 =="
"$ADB" connect "$SERIAL" || true
DEV_STATE="$("$ADB" devices | awk -v s="$SERIAL" '$1==s{print $2}')"
say "device 状态：${DEV_STATE:-<空>}"
if [ "${DEV_STATE}" != "device" ]; then
  red "FAIL(1)：设备不在 device 状态。请先在手机「无线调试」配对(adb pair)并确认端口/同网段。"
  exit 1
fi
grn "PASS(1)：adb devices = device"

say ""
say "== 3) 能力探测：dump + 文本节点 =="
if "$ADB" -s "$SERIAL" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; then
  XML="$("$ADB" -s "$SERIAL" exec-out cat /sdcard/ui.xml 2>/dev/null)"
  if printf '%s' "$XML" | grep -q '<hierarchy' && printf '%s' "$XML" | grep -Eq 'text="[^"]+"'; then
    grn "PASS(2)：dump 非空且有可读文本节点（$(printf '%s' "$XML" | wc -c) 字节）"
  else
    red "FAIL(2)：dump 无 <hierarchy> 或无文本节点（可能被系统限制/WebView 空壳）"; exit 1
  fi
else
  red "FAIL(2)：uiautomator dump 失败"; exit 1
fi

say ""
say "== 4) 能力探测：screencap =="
"$ADB" -s "$SERIAL" exec-out screencap -p > /tmp/price-agent-shot.png 2>/dev/null || true
if [ -s /tmp/price-agent-shot.png ] && head -c 8 /tmp/price-agent-shot.png | grep -q 'PNG'; then
  grn "PASS(3)：screencap 得到有效 PNG（$(wc -c < /tmp/price-agent-shot.png) 字节）"
else
  red "FAIL(3)：screencap 未得到有效 PNG"; exit 1
fi

say ""
say "== 5) 掉线重连演练 =="
"$ADB" disconnect "$SERIAL" >/dev/null 2>&1 || true
"$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
RE_STATE="$("$ADB" devices | awk -v s="$SERIAL" '$1==s{print $2}')"
if [ "${RE_STATE}" = "device" ]; then
  grn "PASS(4)：disconnect 后自动重连 1 次成功"
else
  red "FAIL(4)：重连失败（状态=${RE_STATE:-<空>}）"; exit 1
fi

say ""
grn "==== §8.4 最小实验全部通过：可进 P2 真机开发 ===="
