/**
 * 本机服务 store —— 托管**本机**被控端（启动 / 停止 / 重启 / 自启 / 更新 / 设置）。
 *
 * 与 `conn` store 的分工：`conn` 管「连到某台被控端」（远程控制），
 * 本 store 管「本机这台被控端本身的进程与配置」。二者都连本机时是同一个实例，
 * 但关注点不同 —— 本 store 不依赖连接是否成功（进程没起也能启动它）。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import { useConnStore } from "./conn";
import type {
  AgentLogLine,
  AgentState,
  AgentStatus,
  ApplyUpdateResult,
  ConsoleSettings,
  ConsoleSystemInfo,
  UpdateInfo,
} from "../types";

/** 状态 → 展示文案与配色。 */
export const STATE_META: Record<AgentState, { label: string; type: "success" | "warning" | "error" | "default" }> = {
  running: { label: "运行中", type: "success" },
  starting: { label: "启动中", type: "warning" },
  stopping: { label: "停止中", type: "warning" },
  stopped: { label: "已停止", type: "default" },
  crashed: { label: "已异常退出", type: "error" },
};

export const useAgentStore = defineStore("agent", () => {
  const status = ref<AgentStatus | null>(null);
  const sysInfo = ref<ConsoleSystemInfo | null>(null);
  const update = ref<UpdateInfo | null>(null);
  /** 启停/设置等毫秒级操作的全局忙标志（**不要**给网络类操作复用，见 checkUpdate 注释） */
  const busy = ref(false);
  /** 更新检查/下载专用忙标志 —— 与 `busy` 隔离，避免慢操作锁死整页按钮 */
  const updateBusy = ref(false);
  const error = ref<string | null>(null);
  const bound = ref(false);

  const process = computed(() => status.value?.manager ?? null);
  const state = computed<AgentState>(() => process.value?.state ?? "stopped");
  const meta = computed(() => STATE_META[state.value] ?? STATE_META.stopped);
  const settings = computed<ConsoleSettings>(
    () => status.value?.settings ?? { auto_start_agent: true, auto_restart: true, close_to_tray: true, insecure: true },
  );
  const running = computed(() => state.value === "running");
  /** 端口被占但本管理器没在跑 → 已有「非托管」的实例 */
  const externalInstance = computed(
    () => !running.value && (status.value?.config.port_in_use ?? false),
  );

  /** 包一层：统一置 busy / 收集错误，避免每个动作都写一遍 try-finally。 */
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    busy.value = true;
    error.value = null;
    try {
      const r = await fn();
      return r;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      // ⚠️ 刷新必须放在 finally（2026-10-17 真机缺陷）：
      // 原来 `await refresh()` 写在 try 里，一旦动作**抛错**就被跳过，
      // 界面状态会永远停在动作发生前的旧值。
      //
      // 真机症状：点「启动」→ 后端答「被控端已在运行」（说明它其实是 running）
      // → 界面却一直显示「启动中」，「停止 / 重启」永久灰着，用户无从操作。
      // 根因就是那次 start 抛了错，refresh 被跳过；而 `na-agent-state` 推送
      // 在 WebView 就绪前发出，前端没收到 —— 两条更新通道同时失效。
      // refresh() 自身已 try/catch，放这里不会掩盖原始错误。
      await refresh();
      busy.value = false;
    }
  }

  /** 刷新总览（状态 + 配置 + 自启 + 设置）。 */
  async function refresh() {
    try {
      status.value = await api.agentStatus();
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
    return status.value;
  }

  async function loadSystemInfo() {
    sysInfo.value = await api.systemInfo();
    return sysInfo.value;
  }

  /** 绑定后端事件（应用启动时调用一次）：进程状态变化由推送驱动，不轮询。 */
  async function bind() {
    if (bound.value) return;
    bound.value = true;
    await listen<string>("na-agent-state", () => {
      void refresh();
    });
    // v2.0.3 单实例：用户再次双击图标时，由**已存在实例**接管（把窗口唤出来）。
    // 顺手刷新一次 —— 触发它的场景往往正是「点了没反应，想看看怎么回事」。
    await listen<{ argv?: string[] }>("na-second-instance", () => {
      void refresh();
    });
    await refresh();
    void loadSystemInfo();
  }

  const start = () => run(() => api.agentStart());
  const stop = () => run(() => api.agentStop());
  const restart = () => run(() => api.agentRestart());
  const clearLogs = () => api.agentLogsClear();

  async function setAutostart(enabled: boolean) {
    return run(() => api.autostartSet(enabled));
  }

  async function patchSettings(patch: Partial<ConsoleSettings>) {
    return run(() => api.settingsSet(patch));
  }

  /**
   * 检查更新。
   *
   * ⚠️ **刻意不用全局 `busy`**（2026-10-17 真机缺陷）：
   * `check_update` 要访问网络，境内可能一路等到超时（原 120s / RPC 150s）。
   * 而 `busy` 是**全页共享**的（所有按钮 `:loading="busy"`），于是用户点一下
   * 「检查更新」，整页按钮跟着转两分半 —— 看起来像「点什么都卡死」。
   *
   * 更新检查是**只读、可等待、与启停无关**的操作，本就不该锁住其他按钮。
   * 故它自成一套 `updateBusy`；全局 `busy` 只服务毫秒级的启停与设置。
   */
  async function checkUpdate() {
    updateBusy.value = true;
    error.value = null;
    try {
      update.value = await api.checkUpdate();
      return update.value;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      updateBusy.value = false;
    }
  }

  /**
   * 应用更新（仅更新本机被控端；控制台自身需重新下载安装包）。
   *
   * 同样走 `updateBusy` 而非全局 `busy`：下载更新的 RPC 超时是 330s，
   * 若占用全局 busy，用户会看到「下载更新时整页按钮全部转圈五分钟」。
   */
  async function applyUpdate(): Promise<ApplyUpdateResult | null> {
    const u = update.value;
    const url = u?.agent?.url;
    const sha = u?.agent?.sha256;
    if (!u || !url || !sha) {
      error.value = "最新版本信息不完整（缺少下载地址或哈希），无法更新";
      return null;
    }
    updateBusy.value = true;
    error.value = null;
    try {
      const r = await api.applyUpdate(url, sha, u.latest_version);
      await refresh();
      if (r) await checkUpdate();
      return r;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      updateBusy.value = false;
    }
  }

  /** 一键连接本机被控端（用配置里的地址与密钥）。 */
  async function connectLocal() {
    const cfg = status.value?.config;
    if (!cfg) return null;
    const conn = useConnStore();
    return conn.connect(cfg.url, cfg.key);
  }

  return {
    status,
    sysInfo,
    update,
    busy,
    updateBusy,
    error,
    process,
    state,
    meta,
    settings,
    running,
    externalInstance,
    bind,
    refresh,
    loadSystemInfo,
    start,
    stop,
    restart,
    clearLogs,
    setAutostart,
    patchSettings,
    checkUpdate,
    applyUpdate,
    connectLocal,
  };
});

/**
 * 日志 store —— 本机服务日志的实时流 + 增量拉取。
 *
 * 设计要点：**事件推 + 序号去重**。若只靠事件，页面重新挂载后会丢掉历史；
 * 若只靠轮询，则看不到实时的那一行。故两条路并用，用 `seq` 去重。
 */
export const useLogsStore = defineStore("logs", () => {
  const lines = ref<AgentLogLine[]>([]);
  const maxSeq = ref(0);
  const paused = ref(false);
  const bound = ref(false);
  /** 内存里保留的最大行数（与 Rust 侧环形缓冲上限对齐，避免界面无限膨胀） */
  const CAP = 4000;

  function append(rows: AgentLogLine[]) {
    const fresh = rows.filter((r) => r.seq > maxSeq.value);
    if (fresh.length === 0) return;
    lines.value.push(...fresh);
    maxSeq.value = Math.max(maxSeq.value, ...fresh.map((r) => r.seq));
    if (lines.value.length > CAP) lines.value.splice(0, lines.value.length - CAP);
  }

  /** 拉取历史（首次进页面 / 清空后重建）。 */
  async function load() {
    const page = await api.agentLogs(0);
    lines.value = [];
    maxSeq.value = 0;
    append(page.lines);
    return page;
  }

  /** 绑定实时日志事件。 */
  async function bind() {
    if (bound.value) return;
    bound.value = true;
    await listen<AgentLogLine>("na-agent-log", (e) => {
      if (paused.value) return;
      append([e.payload]);
    });
    await load();
  }

  async function clear() {
    await api.agentLogsClear();
    lines.value = [];
    maxSeq.value = 0;
  }

  /** 导出为文本（在浏览器侧生成，不额外调后端）。 */
  function toText(filtered?: AgentLogLine[]): string {
    const src = filtered ?? lines.value;
    return src
      .map((l) => `${new Date(l.ts).toISOString()} [${l.stream}] ${l.line}`)
      .join("\n");
  }

  function downloadText(text: string, filename: string) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { lines, maxSeq, paused, bind, load, clear, append, toText, downloadText };
});
