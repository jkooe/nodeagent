<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import {
  NCard,
  NTabs,
  NTabPane,
  NDataTable,
  NButton,
  NSpace,
  NInput,
  NEmpty,
  NTag,
  NAlert,
  type DataTableColumns,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import type { ProcessEntry, ServiceEntry } from "../types";
import { formatBytes, formatDuration } from "../utils/format";

const conn = useConnStore();

const procs = ref<ProcessEntry[]>([]);
const services = ref<ServiceEntry[]>([]);
const procFilter = ref("");
const svcFilter = ref("");
const loading = ref(false);
const listError = ref("");

/** `system.service.list` 仅 Windows 被控端可用——事前门控。 */
const servicesAvailable = computed(() => conn.platformReady);

const procCols: DataTableColumns<ProcessEntry> = [
  { title: "PID", key: "pid", width: 90, sorter: (a, b) => (a.pid ?? 0) - (b.pid ?? 0) },
  { title: "名称", key: "name", ellipsis: { tooltip: true } },
  {
    title: "CPU",
    key: "cpu_pct",
    width: 100,
    sorter: (a, b) => (a.cpu_pct ?? 0) - (b.cpu_pct ?? 0),
    render: (r) => (r.cpu_pct != null ? `${r.cpu_pct.toFixed(1)}%` : "-"),
  },
  {
    title: "内存",
    key: "memory_bytes",
    width: 110,
    sorter: (a, b) => (a.memory_bytes ?? 0) - (b.memory_bytes ?? 0),
    render: (r) => (r.memory_bytes ? formatBytes(r.memory_bytes) : "-"),
  },
  {
    title: "已运行",
    key: "started_at",
    width: 120,
    render: (r) =>
      r.started_at ? formatDuration(Math.floor((Date.now() - r.started_at) / 1000)) : "-",
  },
];

const svcCols: DataTableColumns<ServiceEntry> = [
  { title: "名称", key: "name", ellipsis: { tooltip: true } },
  { title: "显示名", key: "display_name", ellipsis: { tooltip: true } },
  {
    title: "状态",
    key: "state",
    width: 130,
    render: (r) =>
      h(
        NTag,
        { size: "small", type: /run/i.test(r.state ?? "") ? "success" : "default" },
        { default: () => r.state ?? "-" },
      ),
  },
  { title: "启动类型", key: "start_type", width: 130 },
];

function pick<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)[key])) {
    return (raw as Record<string, T[]>)[key];
  }
  return [];
}

async function loadProcs() {
  loading.value = true;
  listError.value = "";
  try {
    const raw = await conn.ok("system.process.list", { limit: 200, sort_by: "cpu" });
    procs.value = pick<ProcessEntry>(raw, "processes");
  } catch (e) {
    listError.value = String((e as Error).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function loadServices() {
  if (!servicesAvailable.value) return;
  loading.value = true;
  listError.value = "";
  try {
    const raw = await conn.ok("system.service.list", {
      limit: 200,
      filter: svcFilter.value ? { name_pattern: svcFilter.value } : undefined,
    });
    services.value = pick<ServiceEntry>(raw, "services");
  } catch (e) {
    listError.value = String((e as Error).message ?? e);
  } finally {
    loading.value = false;
  }
}

const filteredProcs = ref<ProcessEntry[]>([]);
function applyProcFilter() {
  const f = procFilter.value.trim().toLowerCase();
  filteredProcs.value = f
    ? procs.value.filter((p) => p.name?.toLowerCase().includes(f))
    : procs.value;
}

onMounted(() => {
  if (conn.connected) {
    loadProcs().then(applyProcFilter);
    loadServices();
  }
});
</script>

<template>
  <div v-if="!conn.connected">
    <n-empty description="请先在「设备管理」页连接被控端" style="margin-top: 80px" />
  </div>

  <n-card v-else size="small">
    <n-alert v-if="listError" type="error" :show-icon="true" style="margin-bottom: 12px">
      {{ listError }}
    </n-alert>

    <n-tabs type="line" animated>
      <n-tab-pane name="proc" tab="进程">
        <n-space align="center" style="margin-bottom: 12px">
          <n-input
            v-model:value="procFilter"
            placeholder="按名称筛选"
            size="small"
            style="width: 220px"
            @input="applyProcFilter"
          />
          <n-button size="small" :loading="loading" @click="loadProcs().then(applyProcFilter)">
            刷新
          </n-button>
          <n-text depth="3" style="font-size: 12px">{{ filteredProcs.length }} / {{ procs.length }}</n-text>
        </n-space>
        <n-empty v-if="!filteredProcs.length" description="暂无进程数据" size="small" />
        <n-data-table
          v-else
          :columns="procCols"
          :data="filteredProcs"
          :bordered="false"
          :max-height="520"
          size="small"
        />
      </n-tab-pane>

      <n-tab-pane name="svc" tab="服务">
        <n-alert v-if="!servicesAvailable" type="warning" :show-icon="true">
          `system.service.list` 仅在被控端为 <b>Windows</b> 时可用；当前被控端为
          <b>{{ conn.nodeOs ?? "未知" }}</b>。
        </n-alert>
        <template v-else>
          <n-space align="center" style="margin-bottom: 12px">
            <n-input v-model:value="svcFilter" placeholder="筛选服务名" size="small" style="width: 220px" />
            <n-button size="small" :loading="loading" @click="loadServices">刷新</n-button>
            <n-text depth="3" style="font-size: 12px">{{ services.length }} 项</n-text>
          </n-space>
          <n-empty v-if="!services.length" description="暂无服务数据" size="small" />
          <n-data-table
            v-else
            :columns="svcCols"
            :data="services"
            :bordered="false"
            :max-height="520"
            size="small"
          />
        </template>
      </n-tab-pane>
    </n-tabs>
  </n-card>
</template>
