/** 连接状态 store：连接/断开、能力清单、元信息、日志与被控端事件。 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import * as api from "../api";
import type { ConnectInfo, InvokeResult, SystemInfo } from "../types";

export interface AgentEvent {
  ts: number;
  payload: unknown;
}

/**
 * 仅在被控端为 Windows 时可用（其余平台返回 E_UNSUPPORTED_PLATFORM）。
 * 前端据此**事前门控**，而不是发出注定失败的请求再解释错误。
 */
export const WINDOWS_ONLY_CAPS = ["app.list", "app.install", "system.service.list"] as const;

export const useConnStore = defineStore("conn", () => {
  const state = ref<string>("closed");
  const url = ref(localStorage.getItem("na.url") || "ws://127.0.0.1:8765");
  const key = ref(localStorage.getItem("na.key") || "");
  const info = ref<ConnectInfo | null>(null);
  const logs = ref<string[]>([]);
  const events = ref<AgentEvent[]>([]);
  const connecting = ref(false);
  const bound = ref(false);
  /** 被控端平台：'Windows' | 'macOS' | 'Linux' | ... （连接后自动探测） */
  const nodeOs = ref<string | null>(null);

  const connected = computed(() => state.value === "connected" && !!info.value);
  const capabilities = computed(() => info.value?.capabilities ?? []);
  /** 被控端能力名集合，便于按名判存在性。 */
  const capabilityNames = computed(() => new Set(capabilities.value.map((c) => c.name)));
  const isWindows = computed(() => nodeOs.value === "Windows");
  /** 平台门控能力当前是否可用（未探测到平台时按「乐观可用」处理）。 */
  const platformReady = computed(() => nodeOs.value === null || isWindows.value);

  function pushLog(msg: string) {
    logs.value.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (logs.value.length > 500) logs.value.shift();
  }

  /** 绑定后端事件（应用启动时调用一次）。 */
  async function bind() {
    if (bound.value) return;
    bound.value = true;
    await listen<string>("na-log", (e) => pushLog(e.payload));
    await listen<string>("na-state", (e) => {
      state.value = e.payload;
      pushLog(`状态 → ${e.payload}`);
    });
    await listen<unknown>("na-event", (e) => {
      events.value.unshift({ ts: Date.now(), payload: e.payload });
      if (events.value.length > 200) events.value.pop();
      pushLog(`被控端事件：${JSON.stringify(e.payload)}`);
    });
    state.value = await api.getState();
  }

  /** 探测被控端平台（`system.info.os`）——决定 Windows 专属能力是否可用。 */
  async function loadPlatform() {
    try {
      const i = await api.ok<SystemInfo>("system.info", { fields: ["os"] });
      nodeOs.value = i.os ?? null;
      pushLog(`被控端平台：${nodeOs.value ?? "未知"}`);
      return nodeOs.value;
    } catch (e) {
      pushLog(`平台探测失败：${e}`);
      return null;
    }
  }

  async function connect(u = url.value, k = key.value) {
    connecting.value = true;
    url.value = u;
    key.value = k;
    pushLog(`正在连接 ${u} ...`);
    try {
      const i = await api.connect(u, k, "console");
      info.value = i;
      localStorage.setItem("na.url", u);
      localStorage.setItem("na.key", k);
      pushLog(`握手成功：${i.capabilities.length} 项能力，agent ${i.agent_version ?? "?"}`);
      // 握手后立刻探测平台，供各页面事前门控。
      await loadPlatform();
      return i;
    } catch (e) {
      pushLog(`连接失败：${e}`);
      throw e;
    } finally {
      connecting.value = false;
    }
  }

  async function disconnect() {
    await api.disconnect();
    info.value = null;
    nodeOs.value = null;
    pushLog("已断开");
  }

  /** 泛型调用；连接断开时抛错。 */
  async function call<T = unknown>(
    capability: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<InvokeResult<T>> {
    if (!connected.value) throw new api.CapabilityFailure(capability, "E_NODE_OFFLINE", "未连接");
    const t0 = performance.now();
    const res = await api.call<T>(capability, args, timeoutMs);
    const ms = Math.round(performance.now() - t0);
    if (res.status === "ok") {
      pushLog(`${capability} → ok (${ms}ms)`);
    } else {
      pushLog(`${capability} → 失败：[${res.error?.name}] ${res.error?.message ?? "未知错误"}`);
    }
    return res;
  }

  /**
   * 调用并要求成功，直接返回 data。
   * 失败抛 `CapabilityFailure`（携带 `errorName`），便于页面按错误名分支
   * ——如 `isUnsupportedPlatform(e)` 判平台不支持。
   */
  async function ok<T = unknown>(
    capability: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const res = await call<T>(capability, args, timeoutMs);
    if (res.status !== "ok") {
      throw new api.CapabilityFailure(
        capability,
        res.error?.name ?? "E_UNKNOWN",
        res.error?.message ?? `${capability} 执行失败`,
        res.error?.data,
      );
    }
    return res.data as T;
  }

  function clearLogs() {
    logs.value = [];
  }

  return {
    state,
    url,
    key,
    info,
    logs,
    events,
    connecting,
    connected,
    capabilities,
    capabilityNames,
    nodeOs,
    isWindows,
    platformReady,
    bind,
    loadPlatform,
    connect,
    disconnect,
    call,
    ok,
    pushLog,
    clearLogs,
  };
});
