<script setup lang="ts">
import { computed, h, onMounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import {
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NTag,
  NButton,
  NSpace,
  NText,
  NTooltip,
  type MenuOption,
} from "naive-ui";
import { navRoutes } from "../router";
import { useConnStore } from "../stores/conn";
import { useAgentStore } from "../stores/agent";

const route = useRoute();
const router = useRouter();
const conn = useConnStore();
const agent = useAgentStore();

onMounted(() => {
  conn.bind();
  agent.bind();
});

const menuOptions: MenuOption[] = navRoutes.map((r) => ({
  key: r.name as string,
  label: () => h("span", `${(r.meta as { icon: string }).icon}  ${(r.meta as { title: string }).title}`),
}));

const activeKey = computed(() => (route.name as string) ?? "local");

function onMenu(key: string) {
  router.push({ name: key });
}

const stateType = computed(() => {
  if (conn.state === "connected") return "success" as const;
  if (conn.state === "reconnecting") return "warning" as const;
  return "error" as const;
});

const stateLabel = computed(() => {
  if (conn.state === "connected") return "已连接";
  if (conn.state === "reconnecting") return "重连中";
  return "未连接";
});

/** 从侧栏快速启停本机服务（不必切页面）。 */
async function quickToggle() {
  if (agent.running) await agent.stop();
  else await agent.start();
}
</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider bordered :width="200" :native-scrollbar="false">
      <div class="brand">
        <div class="brand-title">nodeagent</div>
        <div class="brand-sub">桌面控制台</div>
      </div>
      <n-menu :options="menuOptions" :value="activeKey" @update:value="onMenu" />
      <div class="sider-foot">
        <div class="foot-row">
          <n-text depth="3" style="font-size: 12px">本机被控端</n-text>
          <n-tag :type="agent.meta.type" size="tiny" round>{{ agent.meta.label }}</n-tag>
        </div>
        <n-button
          size="tiny"
          block
          :loading="agent.busy"
          :disabled="agent.busy || agent.externalInstance"
          @click="quickToggle"
        >
          {{ agent.running ? "停止服务" : "启动服务" }}
        </n-button>
      </div>
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered class="topbar">
        <n-space align="center">
          <n-tag :type="stateType" size="small" round>{{ stateLabel }}</n-tag>
          <n-text depth="3" style="font-size: 12px">{{ conn.url }}</n-text>
          <n-text v-if="conn.info" depth="3" style="font-size: 12px">
            · agent {{ conn.info.agent_version ?? "?" }} · {{ conn.info.capabilities.length }} 项能力
          </n-text>
        </n-space>
        <n-space align="center">
          <n-tooltip v-if="agent.sysInfo?.agent_only" trigger="hover">
            <template #trigger>
              <n-tag size="small" type="info" round>仅服务模式</n-tag>
            </template>
            本控制台以「仅服务模式」启动（无窗口，常驻托盘）—— 通常来自开机自启
          </n-tooltip>
          <n-button size="small" :disabled="!conn.info" @click="conn.disconnect()">断开</n-button>
        </n-space>
      </n-layout-header>

      <n-layout-content :native-scrollbar="false" content-style="padding: 20px;">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<style>
:root {
  color-scheme: dark;
}
body {
  margin: 0;
}
.brand {
  padding: 18px 20px 10px;
}
.brand-title {
  font-size: 18px;
  font-weight: 600;
  color: #63e2b7;
  letter-spacing: 0.5px;
}
.brand-sub {
  font-size: 12px;
  opacity: 0.6;
  margin-top: 2px;
}
.topbar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}
/* 侧栏做成纵向弹性布局，才能把「本机服务」快捷块压到底部 */
:deep(.n-layout-sider-scroll-container) {
  display: flex;
  flex-direction: column;
}
.sider-foot {
  margin-top: auto;
  padding: 12px 14px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
}
.foot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
</style>
