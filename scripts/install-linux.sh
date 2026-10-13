#!/usr/bin/env bash
#
# nodeagent 被控端 —— Linux 安装器（Debian 12 / Ubuntu / NAS 系统等 systemd 系统）
#
# 用法:
#   sudo bash scripts/install-linux.sh                        # 系统级（/opt/nodeagent + 系统 systemd）
#   bash scripts/install-linux.sh --user                      # 用户级（~/.local/share + user systemd + linger）
#   sudo bash scripts/install-linux.sh --node-id nas-01 --port 8765
#   sudo bash scripts/install-linux.sh --no-service            # 只装程序+配置，不注册 systemd
#   sudo bash scripts/install-linux.sh --uninstall             # 卸载（保留配置）
#   sudo bash scripts/install-linux.sh --uninstall --purge     # 卸载并删配置
#
# 这套脚本要解决的实际问题（与 Windows 的 install.ps1 同语义）：
#   1) 目标机未必有 Node → 自带运行时（下载 linux-<arch> 到安装目录）
#   2) 要开机自启 → 用 systemd（对齐 Windows 的「计划任务」角色）
#   3) 密钥要生成/复用 → 写进 <数据目录>/agent.json，并在屏幕上打印（供控制端连接）
#   4) 幂等 → 重复执行不丢配置、不产生重复服务
#
# ⚠️ 本平台没有 GUI 能力（截图/键鼠/窗口/剪贴板/音量均为 Windows/macOS 实现），
#    故 --allow-input 即使打开也只影响「是否允许输入类能力注册」，
#    **在 Linux 上不会有实际输入能力可用**。默认关闭。
#
set -euo pipefail

# ---------------- 常量 ----------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

NODE_VERSION="${NODEAGENT_NODE_VERSION:-v22.20.0}"
NODE_MIRROR="${NODEAGENT_NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
DEFAULT_PORT=8765
DEFAULT_NODE_ID="$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' || echo linux_01)"
[ -z "$DEFAULT_NODE_ID" ] && DEFAULT_NODE_ID="linux_01"

UNIT_NAME="nodeagent"

# ---------------- 输出 ----------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_RST=''
fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_RST" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_RST" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_RST" "$*" >&2; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_RST" "$*"; }

die() { err "$*"; exit 1; }

# ---------------- 参数 ----------------

MODE="system"     # system | user
PORT="$DEFAULT_PORT"
NODE_ID="$DEFAULT_NODE_ID"
ALLOW_INPUT=0
UNINSTALL=0
PURGE=0
NO_SERVICE=0
BIND_HOST="0.0.0.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE="user"; shift ;;
    --system) MODE="system"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --node-id) NODE_ID="${2:-}"; shift 2 ;;
    --allow-input) ALLOW_INPUT=1; shift ;;
    --host) BIND_HOST="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) die "--port 必须是数字，收到：$PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port 需在 1-65535，收到：$PORT"

# ---------------- 路径规划 ----------------

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "不支持的架构：$ARCH_RAW（仅 x86_64 / aarch64）" ;;
esac

if [ "$MODE" = "user" ]; then
  INSTALL_DIR="${NODEAGENT_INSTALL_DIR:-$HOME/.local/share/nodeagent}"
  UNIT_DIR="$HOME/.config/systemd/user"
  DATA_DIR="${NODEAGENT_HOME:-$HOME/.nodeagent}"
  SUDO=""
else
  INSTALL_DIR="${NODEAGENT_INSTALL_DIR:-/opt/nodeagent}"
  UNIT_DIR="/etc/systemd/system"
  DATA_DIR="${NODEAGENT_HOME:-$HOME/.nodeagent}"   # 数据目录始终在「执行安装的用户」家目录下
  [ "$(id -u)" -eq 0 ] || die "系统级安装需要 root：请用 sudo，或改用 --user"
  SUDO=""
fi

AGENT_JS_SRC="$PROJECT_ROOT/release/nodeagent-linux/agent.mjs"
[ -f "$AGENT_JS_SRC" ] || AGENT_JS_SRC="$PROJECT_ROOT/release/agent.mjs"
[ -f "$AGENT_JS_SRC" ] || die "找不到 agent.mjs —— 请先执行：node scripts/pack-linux.mjs（或 pnpm pack:linux）"

# ---------------- 卸载 ----------------

if [ "$UNINSTALL" -eq 1 ]; then
  echo "=== 卸载 nodeagent ==="
  if [ "$MODE" = "user" ]; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  else
    systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$INSTALL_DIR"
  ok "已移除服务与程序目录：$INSTALL_DIR"
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$DATA_DIR"
    ok "已删除数据目录（含密钥与审计日志）：$DATA_DIR"
  else
    info "已保留数据目录：$DATA_DIR（含密钥与审计日志；加 --purge 可一并删除）"
  fi
  exit 0
fi

# ---------------- 环境检查 ----------------

echo "=== nodeagent 被控端安装（Linux · $MODE 模式）==="
echo ""

[ "$(uname -s)" = "Linux" ] || die "本脚本仅用于 Linux（当前：$(uname -s)）"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  ok "systemd 可用"
elif [ "$NO_SERVICE" -eq 1 ]; then
  warn "未检测到 systemd，但已指定 --no-service → 只装程序与配置，不注册服务"
  MODE_LABEL="no-service"
else
  die "未检测到 systemd（本脚本用 systemd 做开机自启）。
     可选项：
       a) 加 --no-service 只装程序与配置，自启由你另行安排（手动/nohup/supervisor/cron @reboot）
       b) 手工启动：NODEAGENT_HOME=$DATA_DIR $INSTALL_DIR/runtime/bin/node $INSTALL_DIR/agent.mjs"
fi

# 发行版信息（部分 NAS 系统基于 Debian 12，此处只作展示）
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "系统：${PRETTY_NAME:-unknown}（内核 $(uname -r)）"
fi
ok "架构：$ARCH_RAW → node-$NODE_ARCH"

# ---------------- Node 运行时 ----------------

RUNTIME_DIR="$INSTALL_DIR/runtime"
NODE_BIN=""

# ① 系统 node ≥ 22 就直接用（省一次下载；NAS 上通常没有，走 ②）
if command -v node >/dev/null 2>&1; then
  SYS_VER="$(node -v 2>/dev/null || echo '')"
  SYS_MAJOR="${SYS_VER#v}"; SYS_MAJOR="${SYS_MAJOR%%.*}"
  if [ -n "$SYS_MAJOR" ] && [ "$SYS_MAJOR" -ge 22 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
    ok "使用系统 Node：$SYS_VER（$NODE_BIN）"
  else
    info "系统 Node 版本过低（${SYS_VER:-无}），改用自带运行时"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  if [ -x "$RUNTIME_DIR/bin/node" ]; then
    NODE_BIN="$RUNTIME_DIR/bin/node"
    ok "复用已下载的运行时：$("$NODE_BIN" -v)"
  else
    TARBALL="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
    URL="$NODE_MIRROR/$NODE_VERSION/$TARBALL"
    TMPDIR_DL="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR_DL"' EXIT
    info "下载 Node 运行时：$URL"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 --connect-timeout 20 -o "$TMPDIR_DL/$TARBALL" "$URL" \
        || die "下载失败（可设 NODEAGENT_NODE_MIRROR 换源，或预先把 tar.xz 放到 $TMPDIR_DL）"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 20 -t 3 -O "$TMPDIR_DL/$TARBALL" "$URL" || die "下载失败：$URL"
    else
      die "需要 curl 或 wget 之一来下载 Node 运行时"
    fi
    mkdir -p "$INSTALL_DIR"
    info "解压到 $RUNTIME_DIR"
    mkdir -p "$RUNTIME_DIR"
    tar -xJf "$TMPDIR_DL/$TARBALL" -C "$RUNTIME_DIR" --strip-components=1 || die "解压失败：$TARBALL"
    NODE_BIN="$RUNTIME_DIR/bin/node"
    ok "运行时就绪：$("$NODE_BIN" -v)"
  fi
fi

"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "Node 版本需 ≥ 22（当前 $("$NODE_BIN" -v)）"

# ---------------- 安装程序文件 ----------------

mkdir -p "$INSTALL_DIR" "$DATA_DIR"
install -m 0644 "$AGENT_JS_SRC" "$INSTALL_DIR/agent.mjs"
ok "已安装：$INSTALL_DIR/agent.mjs（$(wc -c < "$INSTALL_DIR/agent.mjs" | tr -d ' ') 字节）"

# ---------------- 配置：复用既有密钥，否则生成 ----------------

CFG="$DATA_DIR/agent.json"
KEY=""
if [ -f "$CFG" ]; then
  # 备份一次（保留最近一次即可，避免堆积）
  cp -f "$CFG" "$CFG.bak" 2>/dev/null || true
  KEY="$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{16,\}\)".*/\1/p' "$CFG" | head -1)"
  if [ -n "$KEY" ]; then
    ok "复用既有配置：$CFG（已备份为 agent.json.bak）"
  else
    info "既有配置里没有可用密钥，将生成新密钥"
  fi
fi

if [ -z "$KEY" ]; then
  if command -v openssl >/dev/null 2>&1; then
    KEY="$(openssl rand -hex 32)"
  else
    KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  case "$KEY" in
    *[!0-9a-fA-F]*|'') die "密钥生成异常（非 hex）" ;;
  esac
  [ ${#KEY} -ge 32 ] || die "密钥长度不足（${#KEY}）"
fi

cat > "$CFG" <<JSON
{
  "node_id": "$NODE_ID",
  "host": "$BIND_HOST",
  "port": $PORT,
  "tls": true,
  "key": "$KEY",
  "log_level": "info",
  "allow_input": $([ "$ALLOW_INPUT" -eq 1 ] && echo true || echo false),
  "auth_mode": "psk"
}
JSON
chmod 600 "$CFG"
ok "配置已写入：$CFG（权限 600）"
[ "$ALLOW_INPUT" -eq 1 ] && warn "已开启 allow_input —— 但 **Linux 上并无输入类能力实现**，此项仅作配置留存"

# ---------------- systemd 服务 ----------------

if [ "$NO_SERVICE" -eq 1 ]; then
  info "跳过 systemd 注册（--no-service）"
else
if [ "$MODE" = "user" ]; then
  mkdir -p "$UNIT_DIR"
  UNIT_PATH="$UNIT_DIR/$UNIT_NAME.service"
else
  UNIT_PATH="$UNIT_DIR/$UNIT_NAME.service"
fi

cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=nodeagent 被控端（跨机 AI 接管）
Documentation=https://github.com/jkooe/nodeagent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 数据目录（含密钥与审计日志）—— 与 agent 侧 agentDir() 一致
Environment=NODEAGENT_HOME=$DATA_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/agent.mjs
WorkingDirectory=$INSTALL_DIR
# 崩溃自拉起（对齐 Windows 计划任务的重启语义）
Restart=always
RestartSec=3
# 优雅停止：先 SIGTERM（agent 会关掉监听与审计写入），超时再 SIGKILL
KillSignal=SIGTERM
TimeoutStopSec=15
# 日志进 journald：journalctl -u $UNIT_NAME -f
StandardOutput=journal
StandardError=journal
# 退出码 0 视为「非异常」（如 --uninstall 后的正常停止）
SuccessExitStatus=0 143

[Install]
WantedBy=$([ "$MODE" = "user" ] && echo default.target || echo multi-user.target)
UNIT

ok "已写入服务单元：$UNIT_PATH"

if [ "$MODE" = "user" ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME" || die "启动失败，查看：systemctl --user status $UNIT_NAME"
  # 让用户级服务在「未登录」时也能跑（NAS 重启后无需登录即自启）
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$USER" 2>/dev/null; then
      ok "已启用 linger（未登录也自启）"
    else
      warn "未能启用 linger（可能需要 root 执行一次：loginctl enable-linger $USER）"
      warn "  未启用 linger 时，用户级服务只在登录会话中运行"
    fi
  fi
else
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME" || die "启动失败，查看：systemctl status $UNIT_NAME -l"
fi

fi   # end: NO_SERVICE

# ---------------- 启动确认 ----------------

if [ "$NO_SERVICE" -eq 1 ]; then
  echo ""
  warn "未注册服务 —— 手工启动："
  printf '    NODEAGENT_HOME=%s %s %s/agent.mjs\n' "$DATA_DIR" "$NODE_BIN" "$INSTALL_DIR"
  MODE_LABEL="no-service"
else
sleep 2
STATE="$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
[ "$MODE" = "user" ] && STATE="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"

if [ "$STATE" = "active" ]; then
  ok "服务运行中（$UNIT_NAME）"
else
  warn "服务状态：${STATE:-unknown}"
  warn "查看日志：$([ "$MODE" = "user" ] && echo 'journalctl --user -u' || echo 'journalctl -u') $UNIT_NAME -n 50 --no-pager"
fi
fi   # end: NO_SERVICE 启动确认

# 端口监听检查（不强依赖 ss/netstat）
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  ok "端口 $PORT 已监听"
else
  info "端口 $PORT 监听状态未确认（可用 ss -ltnp | grep $PORT 自查）"
fi

# ---------------- 打印连接信息 ----------------

# ⚠️ 取本机 IP 要容错：`ip` 在精简系统（含部分 NAS 系统）上可能不存在，
#    而 `set -e` 下「命令替换失败」会**直接终止脚本**（且 2>/dev/null 把原因吞了，
#    表现为「脚本跑到这里就没了」——2026-10-13 在 Debian 容器里踩到）。
LAN_IP=""
if command -v ip >/dev/null 2>&1; then
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)" || true
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
fi
if [ -z "$LAN_IP" ] && command -v ifconfig >/dev/null 2>&1; then
  LAN_IP="$(ifconfig 2>/dev/null | sed -n 's/.*inet \(addr:\)\?\([0-9.]*\).*/\2/p' | grep -v '^127\.' | head -1)" || true
fi
[ -z "$LAN_IP" ] && LAN_IP="<本机IP>"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  nodeagent 被控端已就绪"
echo "──────────────────────────────────────────────────────"
printf '  节点 ID    : %s\n' "$NODE_ID"
printf '  监听       : %s:%s (wss / TLS)\n' "$BIND_HOST" "$PORT"
printf '  本机 IP    : %s\n' "$LAN_IP"
printf '  认证模式   : psk\n'
printf '  输入控制   : %s\n' "$([ "$ALLOW_INPUT" -eq 1 ] && echo 已开启 || echo 已禁用（Linux 无 GUI 能力）)"
printf '  安装目录   : %s\n' "$INSTALL_DIR"
printf '  数据目录   : %s\n' "$DATA_DIR"
if [ "$NO_SERVICE" -eq 1 ]; then
  printf '  服务       : 未注册（--no-service，需自行安排自启）\n'
else
  printf '  服务名     : %s（%s systemd）\n' "$UNIT_NAME" "$MODE"
fi
echo ""
echo "  密钥（请妥善保存，控制端连接需要）:"
echo ""
printf '    %s\n' "$KEY"
echo ""
echo "  控制端连接命令:"
printf '    nodeagent connect %s --port %s --key %s --insecure\n' "$LAN_IP" "$PORT" "$KEY"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  常用管理命令（$MODE 级）:"
if [ "$MODE" = "user" ]; then
  echo "    systemctl --user status  $UNIT_NAME"
  echo "    journalctl  --user -u $UNIT_NAME -f      # 实时日志"
  echo "    systemctl --user restart $UNIT_NAME"
  echo "    bash $0 --user --uninstall               # 卸载（保留配置）"
else
  echo "    systemctl status  $UNIT_NAME"
  echo "    journalctl -u $UNIT_NAME -f              # 实时日志"
  echo "    systemctl restart $UNIT_NAME"
  echo "    sudo bash $0 --uninstall                 # 卸载（保留配置）"
fi
echo ""
echo "  注意：审计链外部锚定建议尽快启用（把链头存到链外）——"
echo "       node scripts/anchor-audit.mjs collect --node $NODE_ID"
echo ""
