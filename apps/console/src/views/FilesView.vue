<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  NCard,
  NInput,
  NButton,
  NSpace,
  NText,
  NEmpty,
  NDataTable,
  NModal,
  NTag,
  useMessage,
  useDialog,
  type DataTableColumns,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import type { FsEntry, FsListResult, FsReadResult, SystemInfo } from "../types";
import { formatBytes, formatTime } from "../utils/format";

const conn = useConnStore();
const msg = useMessage();
const dialog = useDialog();

const cwd = ref("");
const entries = ref<FsEntry[]>([]);
const loading = ref(false);
const truncated = ref(false);

const previewOpen = ref(false);
const previewName = ref("");
const previewText = ref("");
const previewMeta = ref("");

const writeOpen = ref(false);
const wName = ref("");
const wContent = ref("");
const wAppend = ref(false);

const cols: DataTableColumns<FsEntry> = [
  {
    title: "名称",
    key: "name",
    render: (r) => r.name + (r.type === "dir" ? "/" : ""),
  },
  { title: "类型", key: "type", width: 80 },
  { title: "大小", key: "size", width: 110, render: (r) => (r.type === "file" ? formatBytes(r.size) : "-") },
  { title: "修改时间", key: "mtime", width: 180, render: (r) => formatTime(r.mtime) },
];

async function list(path: string) {
  if (!path) return;
  loading.value = true;
  try {
    const r = await conn.ok<FsListResult>("fs.list", { path });
    entries.value = (r.entries ?? []).slice().sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    truncated.value = !!r.truncated;
    cwd.value = path;
  } catch (e) {
    msg.error(`列目录失败：${e}`);
  } finally {
    loading.value = false;
  }
}

function parentOf(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (idx < 0) return s;
  if (idx === 0) return s.slice(0, 1); // POSIX 根
  const r = s.slice(0, idx);
  return /^[A-Za-z]:$/.test(r) ? r + "\\" : r; // Windows 盘符
}

function onRowClick(row: FsEntry) {
  if (row.type === "dir") list(row.path);
  else preview(row);
}

async function preview(row: FsEntry) {
  try {
    const r = await conn.ok<FsReadResult>("fs.read", {
      path: row.path,
      encoding: "utf8",
      max_bytes: 262144,
    });
    previewName.value = row.name;
    previewText.value = (r.data ?? "").replace(/\u0000/g, "");
    previewMeta.value = `${formatBytes(r.total_bytes)}${r.eof ? "" : " · 已截断预览"}${r.sha256 ? ` · sha256 ${r.sha256.slice(0, 12)}…` : ""}`;
    previewOpen.value = true;
  } catch (e) {
    msg.error(`读取失败：${e}`);
  }
}

function openWrite() {
  wName.value = "";
  wContent.value = "";
  wAppend.value = false;
  writeOpen.value = true;
}

function doWrite() {
  if (!wName.value) return;
  const sep = cwd.value.includes("\\") ? "\\" : "/";
  const path = cwd.value.replace(/[\\/]+$/, "") + sep + wName.value;
  dialog.warning({
    title: "确认写入被控端",
    content: `目标：${path}\n模式：${wAppend.value ? "追加" : "覆盖"}\n字节：${wContent.value.length}`,
    positiveText: "写入",
    negativeText: "取消",
    onPositiveClick: () => writeTo(path),
  });
}

async function writeTo(path: string) {
  try {
    await conn.ok("fs.write", { path, data: wContent.value, append: wAppend.value, create_dirs: true });
    msg.success(`已写入 ${path}`);
    writeOpen.value = false;
    list(cwd.value);
  } catch (e) {
    msg.error(`写入失败：${e}`);
  }
}

async function ensureStart() {
  try {
    const info = await conn.ok<SystemInfo>("system.info", { fields: ["agent_home", "os"] });
    let start = info.agent_home ?? "";
    if (!start) start = info.os === "Windows" ? "C:\\" : "/";
    list(start);
  } catch {
    list(conn.info ? "/" : "");
  }
}

onMounted(() => {
  if (conn.connected) ensureStart();
});
</script>

<template>
  <div v-if="!conn.connected">
    <n-empty description="请先在「设备管理」页连接被控端" style="margin-top: 80px" />
  </div>

  <div v-else class="wrap">
    <n-card size="small">
      <n-space align="center" :wrap="false">
        <n-input
          v-model:value="cwd"
          size="small"
          placeholder="输入路径，回车列目录（如 C:\ 或 /Users）"
          style="flex: 1"
          @keyup.enter="list(cwd)"
        />
        <n-button size="small" @click="list(parentOf(cwd))">上级</n-button>
        <n-button size="small" :loading="loading" @click="list(cwd)">刷新</n-button>
        <n-button size="small" type="primary" @click="openWrite">新建文件</n-button>
      </n-space>
      <div class="path">
        <n-text depth="3" style="font-size: 12px">
          当前：{{ cwd || "-" }} · {{ entries.length }} 项
          <n-tag v-if="truncated" size="tiny" type="warning" style="margin-left: 6px">结果被截断</n-tag>
        </n-text>
      </div>
    </n-card>

    <n-card size="small" style="margin-top: 16px">
      <n-empty v-if="!entries.length" description="目录为空或未加载" size="small" />
      <n-data-table
        v-else
        :columns="cols"
        :data="entries"
        :bordered="false"
        size="small"
        :max-height="520"
        :row-props="(row: FsEntry) => ({ style: 'cursor:pointer', onClick: () => onRowClick(row) })"
      />
    </n-card>
  </div>

  <!-- 预览 -->
  <n-modal v-model:show="previewOpen" preset="card" :title="previewName" style="width: 820px; max-width: 90vw">
    <n-text depth="3" style="font-size: 12px">{{ previewMeta }}</n-text>
    <pre class="preview">{{ previewText || "(空文件)" }}</pre>
  </n-modal>

  <!-- 新建/写入 -->
  <n-modal v-model:show="writeOpen" preset="card" title="写入文件" style="width: 640px; max-width: 90vw">
    <n-space vertical>
      <n-input v-model:value="wName" placeholder="文件名（写入当前目录）" size="small" />
      <n-input
        v-model:value="wContent"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 16 }"
        placeholder="文件内容（utf8）"
      />
      <n-space align="center">
        <n-tag
          size="small"
          :type="wAppend ? 'warning' : 'default'"
          checkable
          :checked="wAppend"
          @update:checked="(v: boolean) => (wAppend = v)"
        >
          追加模式
        </n-tag>
        <n-button size="small" type="primary" @click="doWrite">写入</n-button>
      </n-space>
    </n-space>
  </n-modal>
</template>

<style scoped>
.wrap {
  max-width: 1100px;
}
.path {
  margin-top: 10px;
}
.preview {
  margin: 12px 0 0;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  overflow: auto;
}
</style>
