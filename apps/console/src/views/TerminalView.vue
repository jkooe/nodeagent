<script setup lang="ts">
import { computed, ref } from "vue";
import {
  NCard,
  NInput,
  NButton,
  NSpace,
  NInputNumber,
  NText,
  NTag,
  NEmpty,
  NList,
  NListItem,
  useMessage,
  useDialog,
} from "naive-ui";
import { useConnStore } from "../stores/conn";

interface ExecResult {
  exit_code: number;
  stdout?: string;
  stderr?: string;
  duration_ms?: number;
  truncated?: boolean;
  killed?: boolean;
}

const conn = useConnStore();
const msg = useMessage();
const dialog = useDialog();

const cmd = ref("");
const timeoutMs = ref(30000);
const running = ref(false);
const result = ref<ExecResult | null>(null);
const history = ref<string[]>([]);

const output = computed(() => {
  if (!result.value) return "";
  const r = result.value;
  let out = "";
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += (out ? "\n" : "") + r.stderr;
  return out || "(无输出)";
});

async function exec() {
  const command = cmd.value.trim();
  if (!command) return;
  if (!conn.connected) {
    msg.warning("请先连接被控端");
    return;
  }
  dialog.warning({
    title: "确认执行远程命令",
    content: `将在被控端执行：\n${command}`,
    positiveText: "执行",
    negativeText: "取消",
    onPositiveClick: () => doExec(command),
  });
}

async function doExec(command: string) {
  running.value = true;
  result.value = null;
  try {
    const r = await conn.ok<ExecResult>("system.shell.exec", {
      command,
      timeout_ms: timeoutMs.value,
    });
    result.value = r;
    history.value = [command, ...history.value.filter((c) => c !== command)].slice(0, 20);
    if (r.exit_code !== 0) msg.warning(`退出码 ${r.exit_code}`);
  } catch (e) {
    msg.error(`执行失败：${e}`);
  } finally {
    running.value = false;
  }
}

function reuse(c: string) {
  cmd.value = c;
}
</script>

<template>
  <div v-if="!conn.connected">
    <n-empty description="请先在「设备管理」页连接被控端" style="margin-top: 80px" />
  </div>

  <div v-else class="wrap">
    <n-card size="small" title="命令执行（system.shell.exec）">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px">⚠ 高权限操作，请谨慎</n-text>
      </template>
      <n-input
        v-model:value="cmd"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        placeholder="输入命令，例如：Get-Process | Select-Object -First 5"
      />
      <n-space align="center" style="margin-top: 12px">
        <span class="label">超时(ms)</span>
        <n-input-number v-model:value="timeoutMs" :min="1000" :step="1000" size="small" style="width: 140px" />
        <n-button type="primary" :loading="running" @click="exec">执行</n-button>
      </n-space>
    </n-card>

    <n-card v-if="result" size="small" title="输出">
      <template #header-extra>
        <n-space align="center">
          <n-tag :type="result.exit_code === 0 ? 'success' : 'error'" size="small">
            退出码 {{ result.exit_code }}
          </n-tag>
          <n-text depth="3" style="font-size: 12px">{{ result.duration_ms }}ms</n-text>
          <n-tag v-if="result.truncated" size="small" type="warning">已截断</n-tag>
          <n-tag v-if="result.killed" size="small" type="error">超时终止</n-tag>
        </n-space>
      </template>
      <pre class="out">{{ output }}</pre>
    </n-card>

    <n-card v-if="history.length" size="small" title="历史">
      <n-list>
        <n-list-item v-for="(h, i) in history" :key="i">
          <div class="hist" @click="reuse(h)">
            <code>{{ h }}</code>
          </div>
        </n-list-item>
      </n-list>
    </n-card>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1000px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.label {
  font-size: 13px;
  opacity: 0.7;
}
.out {
  margin: 0;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 460px;
  overflow: auto;
}
.hist {
  cursor: pointer;
}
.hist code {
  font-size: 12px;
  opacity: 0.85;
}
.hist:hover code {
  color: #63e2b7;
}
</style>
