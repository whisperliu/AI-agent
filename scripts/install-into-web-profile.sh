#!/usr/bin/env bash
# install-into-web-profile.sh — 把本地 dsh-price-agent 插件装进当前 DSH web profile。
#
# 为什么需要它：本会话的沙箱里 `/` 是只读挂载（WEB GUI 的 profile 在 ~/.dsh/profiles/web），
# 无法从沙箱内写入。请在**可写该目录的宿主机 shell**（即启动 dsh web 的那个 shell）里运行本脚本，
# 然后重启 `dsh web`（或按你的方式重启 GUI），再用浏览器里的 AI 调用 price_agent 即可。
#
# 幂等：重复运行安全（软链覆盖、patch 去重、自动备份）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"       # 本仓库根
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_LINK="$PROFILE_DIR/node_modules/dsh-price-agent"

echo "repo   = $REPO"
echo "profile= $PROFILE_DIR"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "✖ profile 目录不存在：$PROFILE_DIR（先正常启动过一次 dsh web 以生成 profile）" >&2
  exit 1
fi

# 0) 可写性自检
if ! touch "$PROFILE_DIR/.wtest" 2>/dev/null; then
  echo "✖ $PROFILE_DIR 不可写（只读挂载？）。请在可写该目录的宿主机 shell 运行本脚本。" >&2
  exit 1
fi
rm -f "$PROFILE_DIR/.wtest"

# 1) 预检：插件依赖可解析（在仓库里跑过 pnpm install）
if ! ( cd "$REPO" && node -e "import('@deepseek-ai/dsh-atomic-write');import('@deepseek-ai/dsh-storage-domain')" >/dev/null 2>&1 ); then
  echo "✖ 仓库依赖缺失：请先在 $REPO 执行 pnpm install" >&2
  exit 1
fi

# 2) 软链插件到 profile 的 node_modules（profile 从磁盘解析 name）
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$REPO" "$PLUGIN_LINK"
echo "✔ linked $PLUGIN_LINK -> $REPO"

# 3) 在 cordis.patch.yml 追加 price-agent insert（去重插入）
python3 - "$PATCH" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8') if p.exists() else "[]\n"

if 'id: price-agent' in text or 'dsh-price-agent' in text:
    print("✔ patch already contains price-agent (skip)")
    sys.exit(0)

block = """
- insert:
    - id: price-agent
      name: 'dsh-price-agent'
      config:
        device:
          driver: mock
          serial: auto
        task:
          stepTimeoutMs: 8000
          pageTimeoutMs: 20000
          taskTimeoutMs: 90000
          lockWaitMs: 5000
          idempotencyTtlMinutes: 30
        evidence:
          ttlMinutes: 10
          retainMax: 50
        ocr:
          enabled: false
        platforms:
          meituan:
            enabled: true
            appId: com.sankuai.meituan
            priceToleranceYuan: 1.0
          eleme:
            enabled: true
            appId: me.ele
            priceToleranceYuan: 1.0
"""

# 备份
bak = p.with_suffix('.yml.bak')
bak.write_text(text, encoding='utf-8')

# 若原文件是空列表 "[]"，替换为我们的块；否则在末尾追加（顶层为数组）
if text.strip() in ('[]', '', '---'):
    new = block.lstrip('\n')
else:
    new = text.rstrip('\n') + "\n" + block

p.write_text(new, encoding='utf-8')
print(f"✔ appended price-agent to {p} (backup: {bak.name})")
PY

echo
echo "完成。下一步："
echo "  1) 重启 GUI：在启动它的 shell 里 Ctrl-C 后重新运行 \`dsh web\`（或你的重启方式）。"
echo "  2) 浏览器打开 http://127.0.0.1:3080，向 AI 说：「用 price_agent 比价 香叶 烤鸭饭」。"
echo
echo "卸载：删除软链 $PLUGIN_LINK，并从 $PATCH 移除 id: price-agent 那一段（或恢复 .bak）。"
