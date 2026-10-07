<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import {
  NCard,
  NGrid,
  NGridItem,
  NProgress,
  NStatistic,
  NButton,
  NSpace,
  NEmpty,
  NText,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import { useConnStore } from "../stores/conn";
import type { DiskInfo, SystemInfo, SystemStatus } from "../types";
import { formatBytes, formatDuration } from "../utils/format";

const conn = useConnStore();
const msg = useMessage();

const info = ref<SystemInfo | null>(null);
const status = ref<SystemStatus | null>(null);
const auto = ref(true);
let timer: number | undefined;

/** 契约只给 total/free，已用量需自算。 */
function usedOf(d: DiskInfo): number | undefined {
  if (d.total == null || d.free == null) return undefined;
  return Math.max(0, d.total - d.free);
}

async function refresh() {
  if (!conn.connected) return;
  try {
    const [i, s] = await Promise.all([
      conn.ok<SystemInfo>("system.info"),
      conn.ok<SystemStatus>("system.status"),
    ]);
    info.value = i;
    status.value = s;
  } catch (e) {
    msg.error(`刷新失败：${e}`);
  }
}

function toggleAuto(v: boolean) {
  auto.value = v;
  if (v) start(); else stop();
}

function start() {
  stop();
  timer = window.setInterval(refresh, 3000);
}
function stop() {
  if (timer) window.clearInterval(timer);
  timer = undefined;
}

onMounted(() => {
  if (conn.connected) refresh();
  if (auto.value) start();
});
onUnmounted(stop);
</script>

<template>
  <div v-if="!conn.connected">
    <n-empty description="请先在「设备管理」页连接被控端" style="margin-top: 80px" />
  </div>

  <div v-else class="wrap">
    <n-space justify="space-between" align="center" style="margin-bottom: 14px">
      <n-space align="center">
        <n-text depth="3">自动刷新（3s）</n-text>
        <n-switch :value="auto" size="small" @update:value="toggleAuto" />
      </n-space>
      <n-button size="small" @click="refresh">手动刷新</n-button>
    </n-space>

    <n-grid :cols="4" :x-gap="16" :y-gap="16" item-responsive responsive="screen">
      <n-grid-item span="4 s:2">
        <n-card size="small" title="主机">
          <n-statistic label="主机名" :value="info?.hostname ?? '-'" />
          <div class="kv"><span>系统</span><b>{{ info?.os }} {{ info?.os_version }}</b></div>
          <div class="kv"><span>架构</span><b>{{ info?.arch }}</b></div>
          <div class="kv"><span>CPU</span><b>{{ info?.cpu_model }}</b></div>
          <div class="kv"><span>核心</span><b>{{ info?.cpu_cores }}</b></div>
          <div class="kv"><span>管理员</span><b>{{ info?.is_admin ? "是" : "否" }}</b></div>
          <div class="kv"><span>开机</span><b>{{ formatDuration(info?.uptime_sec) }}</b></div>
        </n-card>
      </n-grid-item>

      <n-grid-item span="4 s:2">
        <n-card size="small" title="资源">
          <div class="gauge">
            <div class="gauge-label">CPU 使用率</div>
            <n-progress
              type="line"
              :percentage="Math.round(status?.cpu_pct ?? 0)"
              :height="10"
              :color="(status?.cpu_pct ?? 0) > 80 ? '#e88080' : '#63e2b7'"
            />
          </div>
          <div class="gauge">
            <div class="gauge-label">
              内存 {{ formatBytes(status?.memory_used) }} / {{ formatBytes(status?.memory_total) }}
            </div>
            <n-progress
              type="line"
              :percentage="Math.round(status?.memory_pct ?? 0)"
              :height="10"
              :color="(status?.memory_pct ?? 0) > 85 ? '#e88080' : '#63e2b7'"
            />
          </div>
          <n-statistic
            label="内存总量"
            :value="formatBytes(info?.memory_total ?? status?.memory_total)"
          />
        </n-card>
      </n-grid-item>

      <n-grid-item span="4">
        <n-card size="small" title="磁盘">
          <div v-if="status?.disks?.length" class="disks">
            <div v-for="(d, i) in status.disks" :key="i" class="disk">
              <div class="gauge-label">
                {{ d.drive ?? "-" }}
                <span class="dim">
                  {{ formatBytes(usedOf(d)) }} / {{ formatBytes(d.total) }} · 剩余
                  {{ formatBytes(d.free) }}
                </span>
              </div>
              <n-progress
                type="line"
                :percentage="Math.round(d.used_pct ?? 0)"
                :height="8"
                :color="(d.used_pct ?? 0) > 90 ? '#e88080' : '#63e2b7'"
              />
            </div>
          </div>
          <n-empty v-else description="无磁盘数据" size="small" />
        </n-card>
      </n-grid-item>

      <n-grid-item span="4">
        <n-card size="small" title="网络适配器">
          <div v-if="status?.net?.length" class="net">
            <div v-for="(a, i) in status.net" :key="i" class="kv">
              <span>{{ a.adapter ?? "-" }}</span>
              <b>
                {{ a.ip || "-" }}
                <n-tag :type="a.up ? 'success' : 'default'" size="tiny" style="margin-left: 6px">
                  {{ a.up ? "已连接" : "未连接" }}
                </n-tag>
              </b>
            </div>
          </div>
          <n-empty v-else description="无网络数据" size="small" />
        </n-card>
      </n-grid-item>
    </n-grid>
  </div>
</template>

<style scoped>
.wrap {
  max-width: 1100px;
}
.kv {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 3px 0;
}
.kv span {
  opacity: 0.6;
}
.gauge {
  margin-bottom: 14px;
}
.gauge-label {
  font-size: 13px;
  margin-bottom: 6px;
  opacity: 0.8;
}
.dim {
  opacity: 0.5;
  font-size: 12px;
  margin-left: 8px;
}
.disks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
