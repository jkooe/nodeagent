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
  type MenuOption,
} from "naive-ui";
import { navRoutes } from "../router";
import { useConnStore } from "../stores/conn";

const route = useRoute();
const router = useRouter();
const conn = useConnStore();

onMounted(() => {
  conn.bind();
});

const menuOptions: MenuOption[] = navRoutes.map((r) => ({
  key: r.name as string,
  label: () => h("span", `${(r.meta as { icon: string }).icon}  ${(r.meta as { title: string }).title}`),
}));

const activeKey = computed(() => (route.name as string) ?? "nodes");

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
</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider bordered :width="200" :native-scrollbar="false">
      <div class="brand">
        <div class="brand-title">nodeagent</div>
        <div class="brand-sub">桌面控制台</div>
      </div>
      <n-menu :options="menuOptions" :value="activeKey" @update:value="onMenu" />
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
        <n-button size="small" :disabled="!conn.info" @click="conn.disconnect()">断开</n-button>
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
</style>
