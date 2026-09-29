#!/usr/bin/env bash
#
# 把 nodeagent 控制端安装到 ~/.local/bin（通常已在 PATH 中）。
#
# 用法:
#   pnpm pack:mac && bash scripts/install-macos.sh
#   NODEAGENT_BIN_DIR=/usr/local/bin bash scripts/install-macos.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/release/nodeagent-macos"
BIN_DIR="${NODEAGENT_BIN_DIR:-$HOME/.local/bin}"

# 1. 检查 Node.js（Mac 作为控制端需要本机 Node；不像 Windows 被控端可自带运行时）
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 Node.js。请先安装 Node.js 22+（推荐: brew install node）" >&2
  exit 1
fi
VER="$(node --version | tr -d 'v')"
MAJOR="${VER%%.*}"
if [ "$MAJOR" -lt 22 ]; then
  echo "✗ 需要 Node.js 22+，当前 v$VER" >&2
  exit 1
fi
echo "✓ Node.js v$VER"

# 2. 检查构建产物
if [ ! -f "$SRC/nodeagent" ] || [ ! -f "$SRC/nodeagent-mcp" ] || [ ! -f "$SRC/nodeagentd" ]; then
  echo "✗ 未找到构建产物：$SRC" >&2
  echo "  请先在项目目录运行: pnpm pack:mac" >&2
  exit 1
fi

# 3. 安装（install 会设置 755 权限）
mkdir -p "$BIN_DIR"
install -m 755 "$SRC/nodeagent" "$BIN_DIR/nodeagent"
install -m 755 "$SRC/nodeagentd" "$BIN_DIR/nodeagentd"
install -m 755 "$SRC/nodeagent-mcp" "$BIN_DIR/nodeagent-mcp"
echo "✓ 已安装到 $BIN_DIR"
echo "  - nodeagent      控制端 CLI"
echo "  - nodeagentd     常驻连接池 daemon（nodeagent daemon start 拉起）"
echo "  - nodeagent-mcp  MCP server（供 WorkBuddy 调用）"

# 4. PATH 检查
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "⚠️  $BIN_DIR 不在 PATH 中，请追加到 ~/.zshrc："
    echo "     export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# 5. 打印 MCP 配置片段
cat <<EOF

── 把下面这段加入 ~/.workbuddy/mcp.json ─────────────────────────
{
  "mcpServers": {
    "nodeagent": {
      "command": "$BIN_DIR/nodeagent-mcp"
    }
  }
}
────────────────────────────────────────────────────────────────

验证: nodeagent --help
EOF
