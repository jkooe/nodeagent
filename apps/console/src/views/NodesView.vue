<script setup lang="ts">
import { computed, ref } from "vue";
import {
  NCard,
  NInput,
  NButton,
  NSpace,
  NTag,
  NEmpty,
  NText,
  NInputGroup,
  NCollapse,
  NCollapseItem,
  NPopconfirm,
  useMessage,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import { useNodeStore } from "../stores/node";

const conn = useConnStore();
const nodeStore = useNodeStore();
const msg = useMessage();

const newName = ref("");
const newUrl = ref("ws://127.0.0.1:8765");
const newKey = ref("");

async function doConnect() {
  try {
    await conn.connect();
    msg.success("连接成功");
  } catch (e) {
    msg.error(`连接失败：${e}`);
  }
}

async function connectTo(id: string) {
  const n = nodeStore.nodes.find((x) => x.id === id);
  if (!n) return;
  nodeStore.setCurrent(id);
  try {
    await conn.connect(n.url, n.key);
    msg.success(`已连接 ${n.name}`);
  } catch (e) {
    msg.error(`连接失败：${e}`);
  }
}

function addNode() {
  if (!newName.value || !newUrl.value) {
    msg.warning("请填写名称与地址");
    return;
  }
  nodeStore.add({ name: newName.value, url: newUrl.value, key: newKey.value });
  newName.value = "";
  newKey.value = "";
  msg.success("已保存设备");
}

/** 能力按前缀分组，便于核对。 */
const capGroups = computed(() => {
  const groups: Record<string, string[]> = {};
  for (const c of conn.capabilities) {
    const prefix = c.name.split(".")[0] ?? "other";
    (groups[prefix] ??= []).push(c.name);
  }
  return groups;
});
</script>

<template>
  <div class="grid">
    <n-card title="连接被控端" size="small">
      <n-space vertical>
        <n-input-group>
          <n-input v-model:value="conn.url" placeholder="ws://127.0.0.1:8765" style="flex: 3" />
          <n-input
            v-model:value="conn.key"
            type="password"
            show-password-on="click"
            placeholder="PSK 预共享密钥"
            style="flex: 2"
          />
          <n-button type="primary" :loading="conn.connecting" @click="doConnect">连接</n-button>
        </n-input-group>
        <div v-if="conn.info" class="meta">
          <n-tag type="success" size="small" round>已连接</n-tag>
          <n-text depth="3">agent {{ conn.info.agent_version ?? "?" }}</n-text>
          <n-text depth="3">
            授权 {{ conn.info.authorized ? `${conn.info.authorized.length} 项` : "全部" }}
          </n-text>
          <n-text depth="3" class="mono">
            指纹 {{ (conn.info.peer_cert_fp ?? "-").slice(0, 16) }}…
          </n-text>
        </div>
        <n-empty v-else description="尚未连接" size="small" />
      </n-space>
    </n-card>

    <n-card title="已保存设备" size="small">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px">{{ nodeStore.nodes.length }} 台</n-text>
      </template>
      <div v-if="nodeStore.nodes.length" class="nodes">
        <div
          v-for="n in nodeStore.nodes"
          :key="n.id"
          class="node"
          :class="{ active: nodeStore.currentId === n.id }"
        >
          <div class="node-main">
            <div class="node-name">{{ n.name }}</div>
            <n-text depth="3" class="mono" style="font-size: 12px">{{ n.url }}</n-text>
          </div>
          <n-space>
            <n-button size="tiny" type="primary" @click="connectTo(n.id)">连接</n-button>
            <n-popconfirm @positive-click="nodeStore.remove(n.id)">
              <template #trigger>
                <n-button size="tiny" quaternary>删除</n-button>
              </template>
              确认删除该设备？
            </n-popconfirm>
          </n-space>
        </div>
      </div>
      <n-empty v-else description="暂无保存的设备" size="small" />

      <div class="add-row">
        <n-input v-model:value="newName" placeholder="名称" size="small" style="flex: 1" />
        <n-input v-model:value="newUrl" placeholder="地址" size="small" style="flex: 2" />
        <n-input v-model:value="newKey" placeholder="PSK" size="small" style="flex: 1" />
        <n-button size="small" @click="addNode">保存</n-button>
      </div>
    </n-card>

    <n-card title="能力清单" size="small">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px">{{ conn.capabilities.length }} 项</n-text>
      </template>
      <n-collapse v-if="conn.capabilities.length" :default-expanded-names="Object.keys(capGroups)">
        <n-collapse-item
          v-for="(caps, prefix) in capGroups"
          :key="prefix"
          :name="prefix"
          :title="`${prefix}.*  (${caps.length})`"
        >
          <div class="cap-list">
            <code v-for="c in caps" :key="c">{{ c }}</code>
          </div>
        </n-collapse-item>
      </n-collapse>
      <n-empty v-else description="连接后展示" size="small" />
    </n-card>

    <n-card title="日志" size="small">
      <template #header-extra>
        <n-button size="tiny" quaternary @click="conn.clearLogs()">清空</n-button>
      </template>
      <div class="logs">
        <div v-for="(l, i) in conn.logs.slice().reverse()" :key="i">{{ l }}</div>
        <div v-if="conn.logs.length === 0" class="logs-empty">暂无日志</div>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.grid > :nth-child(3),
.grid > :nth-child(4) {
  grid-column: span 2;
}
.meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, Menlo, monospace;
}
.nodes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 8px;
}
.node.active {
  border-color: #63e2b7;
}
.node-name {
  font-size: 14px;
  margin-bottom: 2px;
}
.add-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.cap-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cap-list code {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
}
.logs {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.85;
  max-height: 220px;
  overflow: auto;
}
.logs-empty {
  opacity: 0.4;
}
</style>
