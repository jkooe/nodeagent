<script setup lang="ts">
/**
 * 服务日志 —— 本机被控端（agent）的标准输出/错误与系统消息。
 *
 * 实时性靠后端事件推送（`na-agent-log`），历史靠 `agent_logs` 增量拉取；
 * 两条路用 `seq` 去重，故既不会丢历史、也不会重复。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  NButton,
  NCard,
  NCheckbox,
  NCheckboxGroup,
  NInput,
  NPopconfirm,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from "naive-ui";
import { useLogsStore } from "../stores/agent";

const logs = useLogsStore();
const msg = useMessage();

const keyword = ref("");
const streams = ref<string[]>(["stdout", "stderr", "system"]);
const autoScroll = ref(true);
const boxRef = ref<HTMLElement | null>(null);

const filtered = computed(() =>
  logs.lines.filter((l) => {
    if (!streams.value.includes(l.stream)) return false;
    if (!keyword.value) return true;
    return l.line.toLowerCase().includes(keyword.value.toLowerCase());
  }),
);

async function scrollToBottom() {
  if (!autoScroll.value) return;
  await nextTick();
  const el = boxRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// 新日志到达时自动滚到底（仅在未暂停且开启自动滚动时）
watch(() => logs.lines.length, scrollToBottom);

onMounted(async () => {
  await logs.bind();
  await scrollToBottom();
});

function clear() {
  void logs.clear();
  msg.success("已清空日志缓冲");
}

function exportLogs() {
  const text = logs.toText(filtered.value);
  logs.downloadText(text, `nodeagent-console-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  msg.success(`已导出 ${filtered.value.length} 行`);
}

function streamType(s: string) {
  if (s === "stderr") return "error" as const;
  if (s === "system") return "success" as const;
  return "default" as const;
}
</script>

<template>
  <div class="wrap">
    <n-card size="small" title="本机服务日志">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px">
          {{ filtered.length }} / {{ logs.lines.length }} 行（缓冲上限 4000）
        </n-text>
      </template>

      <n-space align="center" style="margin-bottom: 12px" :wrap="true">
        <n-input
          v-model:value="keyword"
          size="small"
          placeholder="过滤关键字…"
          clearable
          style="width: 220px"
        />
        <n-checkbox-group v-model:value="streams">
          <n-space align="center">
            <n-checkbox value="stdout" label="标准输出" />
            <n-checkbox value="stderr" label="标准错误" />
            <n-checkbox value="system" label="系统消息" />
          </n-space>
        </n-checkbox-group>
        <n-space align="center">
          <n-text depth="3" style="font-size: 12px">自动滚动</n-text>
          <n-switch v-model:value="autoScroll" size="small" />
        </n-space>
        <n-space align="center">
          <n-text depth="3" style="font-size: 12px">暂停接收</n-text>
          <n-switch v-model:value="logs.paused" size="small" />
        </n-space>
        <n-button size="small" @click="logs.load()">重新拉取</n-button>
        <n-button size="small" @click="scrollToBottom">滚到底部</n-button>
        <n-button size="small" @click="exportLogs">导出</n-button>
        <n-popconfirm @positive-click="clear">
          <template #trigger>
            <n-button size="small" type="error" quaternary>清空</n-button>
          </template>
          将清空内存中的日志缓冲（磁盘上的审计日志不受影响）。确定？
        </n-popconfirm>
      </n-space>

      <div ref="boxRef" class="log-box">
        <div v-if="!filtered.length" class="empty">
          暂无日志。被控端启动后，其输出会实时出现在这里。
        </div>
        <div v-for="l in filtered" :key="l.seq" class="row">
          <span class="ts">{{ new Date(l.ts).toLocaleTimeString() }}</span>
          <n-tag :type="streamType(l.stream)" size="tiny" :bordered="false" class="tag">
            {{ l.stream }}
          </n-tag>
          <span class="txt" :class="l.stream">{{ l.line }}</span>
        </div>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1100px;
}
.log-box {
  height: calc(100vh - 300px);
  min-height: 320px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.18);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  white-space: pre-wrap;
  word-break: break-all;
}
.ts {
  opacity: 0.4;
  flex: 0 0 auto;
}
.tag {
  flex: 0 0 auto;
  margin-top: 1px;
}
.txt.stderr {
  color: #e88080;
}
.txt.system {
  color: #63e2b7;
}
.empty {
  opacity: 0.5;
  padding: 20px 4px;
}
</style>
