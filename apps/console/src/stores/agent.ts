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
  const busy = ref(false);
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
      await refresh();
      return r;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
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

  /** 检查更新。 */
  async function checkUpdate() {
    busy.value = true;
    error.value = null;
    try {
      update.value = await api.checkUpdate();
      return update.value;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      busy.value = false;
    }
  }

  /** 应用更新（仅更新本机被控端；控制台自身需重新下载安装包）。 */
  async function applyUpdate(): Promise<ApplyUpdateResult | null> {
    const u = update.value;
    const url = u?.agent?.url;
    const sha = u?.agent?.sha256;
    if (!u || !url || !sha) {
      error.value = "最新版本信息不完整（缺少下载地址或哈希），无法更新";
      return null;
    }
    const r = await run(() => api.applyUpdate(url, sha, u.latest_version));
    if (r) await checkUpdate();
    return r;
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
