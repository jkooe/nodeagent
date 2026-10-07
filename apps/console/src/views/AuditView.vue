<script setup lang="ts">
import { h, onMounted, ref } from "vue";
import {
  NCard,
  NDataTable,
  NButton,
  NSpace,
  NInputNumber,
  NSelect,
  NText,
  NTag,
  NEmpty,
  NAlert,
  useMessage,
  type DataTableColumns,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import type { AuditEntry, AuditListResult, AuditVerifyResult } from "../types";
import { formatTime } from "../utils/format";

const conn = useConnStore();
const msg = useMessage();

const entries = ref<AuditEntry[]>([]);
const total = ref(0);
const limit = ref(100);
const typeFilter = ref<string | null>(null);
const loading = ref(false);
const verify = ref<AuditVerifyResult | null>(null);

const typeOptions = [
  { label: "全部", value: "" },
  { label: "invoke", value: "invoke" },
  { label: "auth.success", value: "auth.success" },
  { label: "auth.failure", value: "auth.failure" },
  { label: "acl.denied", value: "acl.denied" },
  { label: "capability.disabled", value: "capability.disabled" },
  { label: "rate.limited", value: "rate.limited" },
  { label: "net.deny", value: "net.deny" },
  { label: "net.change", value: "net.change" },
  { label: "agent.update", value: "agent.update" },
  { label: "agent.start", value: "agent.start" },
  { label: "agent.stop", value: "agent.stop" },
];

const cols: DataTableColumns<AuditEntry> = [
  { title: "时间", key: "ts", width: 180, render: (r) => formatTime(r.ts) },
  {
    title: "类型",
    key: "type",
    width: 150,
    render: (r) => {
      const t = r.type ?? "-";
      const kind = t.includes("denied") || t.includes("failure") || t.includes("deny") ? "error" : "default";
      return h(NTag, { size: "small", type: kind }, { default: () => t });
    },
  },
  { title: "调用方", key: "client_id", width: 110 },
  { title: "来源", key: "remote", width: 120 },
  { title: "能力", key: "capability", ellipsis: { tooltip: true } },
  {
    title: "状态",
    key: "status",
    width: 90,
    render: (r) => {
      if (!r.status) return "-";
      const kind = r.status === "ok" ? "success" : "error";
      return h(NTag, { size: "small", type: kind }, { default: () => r.status });
    },
  },
  { title: "耗时", key: "duration_ms", width: 90, render: (r) => (r.duration_ms != null ? `${r.duration_ms}ms` : "-") },
  {
    title: "参数摘要",
    key: "args_digest",
    width: 170,
    ellipsis: { tooltip: true },
    render: (r) => r.args_digest ?? "-",
  },
  {
    title: "说明",
    key: "reason",
    ellipsis: { tooltip: true },
    render: (r) => r.reason || r.error || "-",
  },
];

async function load() {
  loading.value = true;
  try {
    const args: Record<string, unknown> = { limit: limit.value };
    if (typeFilter.value) args.type = typeFilter.value;
    const r = await conn.ok<AuditListResult>("system.audit.list", args);
    entries.value = r.entries ?? [];
    total.value = r.total ?? entries.value.length;
  } catch (e) {
    msg.error(`加载审计失败：${e}`);
  } finally {
    loading.value = false;
  }
}

async function runVerify() {
  try {
    verify.value = await conn.ok<AuditVerifyResult>("system.audit.verify", {});
  } catch (e) {
    msg.error(`校验失败：${e}`);
  }
}

async function exportJsonl() {
  const text = entries.value.map((e) => JSON.stringify(e)).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    msg.success(`已复制 ${entries.value.length} 条到剪贴板`);
  } catch {
    msg.warning("剪贴板不可用");
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
    <n-card size="small">
      <template #header>
        <n-space align="center">
          <span>审计日志</span>
          <n-text depth="3" style="font-size: 12px">共 {{ total }} 条</n-text>
        </n-space>
      </template>
      <template #header-extra>
        <n-space align="center">
          <n-select
            v-model:value="typeFilter"
            :options="typeOptions"
            size="small"
            style="width: 140px"
            @update:value="load"
          />
          <n-input-number v-model:value="limit" :min="10" :max="2000" :step="50" size="small" style="width: 110px" />
          <n-button size="small" :loading="loading" @click="load">刷新</n-button>
          <n-button size="small" @click="runVerify">完整性校验</n-button>
          <n-button size="small" @click="exportJsonl">导出</n-button>
        </n-space>
      </template>

      <n-alert
        v-if="verify"
        :type="verify.ok ? 'success' : 'error'"
        :show-icon="true"
        style="margin-bottom: 12px"
      >
        完整性校验：{{ verify.ok ? "通过" : "发现问题" }} · 已校验 {{ verify.checked }} 条
        <template v-if="verify.legacy"> · 跳过 {{ verify.legacy }} 条历史条目</template>
        <template v-if="verify.broken_at">
          · 首个断点：{{ verify.broken_at.file }} 第 {{ verify.broken_at.line }} 行
          <template v-if="verify.broken_at.reason">（{{ verify.broken_at.reason }}）</template>
        </template>
      </n-alert>

      <n-empty v-if="!entries.length" description="暂无审计记录" size="small" />
      <n-data-table v-else :columns="cols" :data="entries" :bordered="false" size="small" :max-height="560" />
    </n-card>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1200px;
}
</style>
