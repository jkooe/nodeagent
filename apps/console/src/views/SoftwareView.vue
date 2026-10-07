<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  NCard,
  NInput,
  NButton,
  NSpace,
  NText,
  NEmpty,
  NDataTable,
  NAlert,
  useMessage,
  useDialog,
  type DataTableColumns,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import type { AppEntry } from "../types";

const conn = useConnStore();
const msg = useMessage();
const dialog = useDialog();

const apps = ref<AppEntry[]>([]);
const filter = ref("");
const pkg = ref("");
const loading = ref(false);
const installing = ref(false);
const installResult = ref("");
const error = ref("");

/** `app.list` / `app.install` 仅 Windows 被控端可用——事前门控。 */
const available = computed(() => conn.platformReady);

const cols: DataTableColumns<AppEntry> = [
  { title: "名称", key: "name", ellipsis: { tooltip: true } },
  { title: "版本", key: "version", width: 150 },
  { title: "发布者", key: "publisher", ellipsis: { tooltip: true } },
  { title: "来源", key: "source", width: 110 },
];

function pickApps(raw: unknown): AppEntry[] {
  if (Array.isArray(raw)) return raw as AppEntry[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.apps)) return o.apps as AppEntry[];
  }
  return [];
}

const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return apps.value;
  return apps.value.filter(
    (a) =>
      a.name?.toLowerCase().includes(f) ||
      a.publisher?.toLowerCase().includes(f) ||
      a.source?.toLowerCase().includes(f),
  );
});

async function load() {
  if (!available.value) return;
  loading.value = true;
  error.value = "";
  try {
    apps.value = pickApps(await conn.ok("app.list", {}, 120000));
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    loading.value = false;
  }
}

function doInstall() {
  const p = pkg.value.trim();
  if (!p) return;
  dialog.warning({
    title: "确认安装",
    content: `将在被控端静默安装：${p}`,
    positiveText: "安装",
    negativeText: "取消",
    onPositiveClick: () => install(p),
  });
}

async function install(p: string) {
  installing.value = true;
  installResult.value = "";
  try {
    // winget 安装可能耗时数分钟，控制端 RPC 超时放大到 10 分钟。
    const r = await conn.ok<Record<string, unknown>>(
      "app.install",
      { package: p, silent: true },
      600_000,
    );
    installResult.value = JSON.stringify(r, null, 2);
    msg.success("安装完成");
    load();
  } catch (e) {
    installResult.value = String(e);
    msg.error(`安装失败：${e}`);
  } finally {
    installing.value = false;
  }
}

onMounted(() => {
  if (conn.connected) load();
});
</script>

<template>
  <div v-if="!conn.connected">
    <n-empty description="请先在「设备管理」页连接被控端" style="margin-top: 80px" />
  </div>

  <div v-else class="wrap">
    <n-alert v-if="!available" type="warning" :show-icon="true" style="margin-bottom: 14px">
      软件能力（<code>app.list</code> / <code>app.install</code>）依赖被控端 <code>winget</code>，
      <b>仅在被控端为 Windows 时可用</b>；当前被控端为 <b>{{ conn.nodeOs ?? "未知" }}</b>，
      本页已禁用。
    </n-alert>
    <n-alert v-else type="info" :show-icon="true" style="margin-bottom: 14px">
      软件安装依赖被控端 <code>winget</code>。安装可能耗时数分钟，已把调用超时放大到 10 分钟。
    </n-alert>

    <n-alert v-if="error" type="error" :show-icon="true" style="margin-bottom: 14px">
      {{ error }}
    </n-alert>

    <n-card size="small" title="静默安装（app.install）">
      <n-space align="center">
        <n-input
          v-model:value="pkg"
          :disabled="!available"
          placeholder="winget 包名或 ID，例如 Git.Git / 7zip.7zip"
          style="width: 420px"
        />
        <n-button type="primary" :loading="installing" :disabled="!available" @click="doInstall">
          安装
        </n-button>
      </n-space>
      <pre v-if="installResult" class="result">{{ installResult }}</pre>
    </n-card>

    <n-card size="small" title="已装软件（app.list）" style="margin-top: 16px">
      <template #header-extra>
        <n-space align="center">
          <n-input
            v-model:value="filter"
            :disabled="!available"
            placeholder="筛选"
            size="small"
            style="width: 180px"
          />
          <n-button size="small" :loading="loading" :disabled="!available" @click="load">刷新</n-button>
          <n-text depth="3" style="font-size: 12px">{{ filtered.length }}</n-text>
        </n-space>
      </template>
      <n-empty
        v-if="!apps.length && !loading"
        :description="available ? '暂无数据（点刷新）' : '当前被控端非 Windows，不支持'"
        size="small"
      />
      <n-data-table v-else :columns="cols" :data="filtered" :bordered="false" size="small" :max-height="480" />
    </n-card>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1100px;
}
.result {
  margin: 12px 0 0;
  padding: 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
}
</style>
