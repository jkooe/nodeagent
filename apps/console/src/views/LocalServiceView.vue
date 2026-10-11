<script setup lang="ts">
/**
 * 本机服务 —— 控制台托管的**本机被控端**（默认首页）。
 *
 * 目标：用户**完全不碰命令行** —— 打开应用即可启动 / 停止 / 重启被控端、
 * 开关开机自启、查日志、检查更新。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  NAlert,
  NButton,
  NCard,
  NDivider,
  NGrid,
  NGridItem,
  NPopconfirm,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  NText,
  NTooltip,
  useMessage,
} from "naive-ui";
import { useAgentStore, useLogsStore } from "../stores/agent";
import { formatDuration } from "../utils/format";

const agent = useAgentStore();
const logs = useLogsStore();
const msg = useMessage();
const router = useRouter();

const revealKey = ref(false);
const copied = ref<string | null>(null);

const cfg = computed(() => agent.status?.config ?? null);
const proc = computed(() => agent.process);
const busy = computed(() => agent.busy);

/** 最近 6 行日志（完整日志在「服务日志」页）。 */
const recent = computed(() => logs.lines.slice(-6));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = what;
    msg.success(`已复制${what}`);
    setTimeout(() => (copied.value = null), 1500);
  } catch {
    msg.error("复制失败（系统剪贴板不可用，可手工选中复制）");
  }
}

async function doAction(fn: () => Promise<unknown>, name: string) {
  const r = await fn();
  if (agent.error) msg.error(`${name}失败：${agent.error}`);
  else if (r) msg.success(`${name}完成`);
}

async function doAutostart(v: boolean) {
  const r = await agent.setAutostart(v);
  if (agent.error) msg.error(`设置开机自启失败：${agent.error}`);
  else msg.success(v ? `已开启开机自启（${agent.status?.autostart.location}）` : "已关闭开机自启");
  return r;
}

async function doSetting(key: "auto_restart" | "close_to_tray" | "auto_start_agent", v: boolean) {
  await agent.patchSettings({ [key]: v } as never);
  if (agent.error) msg.error(`保存设置失败：${agent.error}`);
}

async function doCheckUpdate() {
  const u = await agent.checkUpdate();
  if (agent.error) msg.error(`检查更新失败：${agent.error}`);
  else if (u) msg.success(u.has_update ? `有新版本 v${u.latest_version}` : "已是最新版本");
}

async function doApplyUpdate() {
  const r = await agent.applyUpdate();
  if (agent.error) msg.error(`更新失败：${agent.error}`);
  else if (r) msg.success(`已更新到 v${r.version}（${r.restarted ? "并已重启" : "未自动启动"}）`);
}

async function doConnectLocal() {
  try {
    await agent.connectLocal();
    msg.success("已连接本机被控端");
  } catch (e) {
    msg.error(`连接失败：${e}`);
  }
}

onMounted(async () => {
  await agent.bind();
  await logs.bind();
});

function fmtTime(ts?: number | null) {
  return ts ? new Date(ts).toLocaleString() : "-";
}

/** 打开 Release 页面（模板里不能直接用 `window`，故走 setup 作用域的函数）。 */
function openRelease() {
  const url = agent.update?.release_url;
  if (url) window.open(url, "_blank");
}
</script>

<template>
  <n-spin :show="busy && !agent.status">
    <div class="wrap">
      <n-alert v-if="agent.error" type="error" style="margin-bottom: 14px" :show-icon="true">
        {{ agent.error }}
      </n-alert>

      <!-- 非托管实例提示：端口被占但不是本控制台起的 -->
      <n-alert
        v-if="agent.externalInstance"
        type="warning"
        style="margin-bottom: 14px"
        title="检测到已有一个被控端在运行（非本控制台托管）"
      >
        端口 {{ cfg?.port }} 已被监听。它可能是手工安装的（`install.cmd` / 计划任务）。
        本控制台无法停止它；如要用本控制台管理，请先停掉它，或直接点「连接本机」复用它。
      </n-alert>

      <n-grid :cols="4" :x-gap="16" :y-gap="16" item-responsive responsive="screen">
        <!-- ① 服务状态与操作 -->
        <n-grid-item span="4 s:4 m:2">
          <n-card title="本机被控端" size="small">
            <n-space align="center" style="margin-bottom: 12px">
              <n-tag :type="agent.meta.type" size="medium" round>{{ agent.meta.label }}</n-tag>
              <n-text v-if="proc?.pid" depth="3" style="font-size: 12px">PID {{ proc.pid }}</n-text>
              <n-text v-if="proc?.uptime_ms" depth="3" style="font-size: 12px">
                · 已运行 {{ formatDuration(Math.round((proc.uptime_ms ?? 0) / 1000)) }}
              </n-text>
              <n-text v-if="proc?.restarts" depth="3" style="font-size: 12px">
                · 自动重启 {{ proc.restarts }} 次
              </n-text>
            </n-space>

            <n-space style="margin-bottom: 14px">
              <n-button
                type="primary"
                :loading="busy"
                :disabled="agent.running || agent.externalInstance"
                @click="doAction(() => agent.start(), '启动')"
              >
                启动
              </n-button>
              <n-button :loading="busy" :disabled="!agent.running" @click="doAction(() => agent.stop(), '停止')">
                停止
              </n-button>
              <n-button :loading="busy" :disabled="!agent.running" @click="doAction(() => agent.restart(), '重启')">
                重启
              </n-button>
              <n-button :disabled="!cfg" quaternary @click="doConnectLocal">连接本机</n-button>
            </n-space>

            <n-alert v-if="proc?.last_exit" type="default" :show-icon="false" style="margin-bottom: 12px">
              上次退出：{{ proc.last_exit }}
            </n-alert>

            <div class="kv"><span>节点 ID</span><b>{{ cfg?.node_id || "-" }}</b></div>
            <div class="kv"><span>监听地址</span><b>{{ cfg?.url || "-" }}</b></div>
            <div class="kv">
              <span>预共享密钥</span>
              <b class="mono">
                {{ revealKey ? cfg?.key || "-" : "•".repeat(Math.min(cfg?.key?.length ?? 0, 16)) || "-" }}
                <n-button text size="tiny" style="margin-left: 6px" @click="revealKey = !revealKey">
                  {{ revealKey ? "隐藏" : "显示" }}
                </n-button>
                <n-button
                  text
                  size="tiny"
                  style="margin-left: 6px"
                  :disabled="!cfg?.key"
                  @click="copy(cfg?.key ?? '', '密钥')"
                >
                  复制
                </n-button>
              </b>
            </div>
            <div class="kv"><span>认证模式</span><b>{{ cfg?.auth_mode || "-" }}</b></div>
            <div class="kv">
              <span>数据目录</span>
              <b class="mono ellipsis" :title="cfg?.data_dir">{{ cfg?.data_dir || "-" }}</b>
            </div>
            <div class="kv">
              <span>运行脚本</span>
              <b class="mono ellipsis" :title="proc?.script">{{ proc?.script || "-" }}</b>
            </div>
            <div class="kv">
              <span>被控端版本</span>
              <b>{{ agent.status?.installed_agent_version || "（未播种）" }}</b>
            </div>
          </n-card>
        </n-grid-item>

        <!-- ② 行为设置 -->
        <n-grid-item span="4 s:4 m:2">
          <n-card title="运行方式" size="small">
            <div class="switch-row">
              <div>
                <div>开机自启</div>
                <div class="hint">
                  {{ agent.status?.autostart.note }}
                </div>
              </div>
              <n-switch
                :value="agent.status?.autostart.enabled ?? false"
                :disabled="!agent.status?.autostart.supported || busy"
                :loading="busy"
                @update:value="doAutostart"
              />
            </div>
            <n-divider style="margin: 12px 0" />
            <div class="switch-row">
              <div>
                <div>后台运行（关闭窗口时最小化到托盘）</div>
                <div class="hint">关闭后，点窗口的关闭按钮将直接退出应用并停止被控端</div>
              </div>
              <n-switch
                :value="agent.settings.close_to_tray"
                :disabled="busy"
                @update:value="(v: boolean) => doSetting('close_to_tray', v)"
              />
            </div>
            <n-divider style="margin: 12px 0" />
            <div class="switch-row">
              <div>
                <div>启动应用时自动拉起被控端</div>
                <div class="hint">关闭后需手工点「启动」</div>
              </div>
              <n-switch
                :value="agent.settings.auto_start_agent"
                :disabled="busy"
                @update:value="(v: boolean) => doSetting('auto_start_agent', v)"
              />
            </div>
            <n-divider style="margin: 12px 0" />
            <div class="switch-row">
              <div>
                <div>被控端异常退出时自动重启</div>
                <div class="hint">连续失败 5 次后停止重试并保留现场日志</div>
              </div>
              <n-switch
                :value="agent.settings.auto_restart"
                :disabled="busy"
                @update:value="(v: boolean) => doSetting('auto_restart', v)"
              />
            </div>
            <n-divider style="margin: 12px 0" />
            <div class="kv"><span>自启落地位置</span><b class="mono ellipsis">{{ agent.status?.autostart.location || "-" }}</b></div>
            <div class="kv"><span>自启方式</span><b class="mono">仅服务模式（无窗口）</b></div>
          </n-card>
        </n-grid-item>

        <!-- ③ 更新 -->
        <n-grid-item span="4 s:4 m:2">
          <n-card title="更新" size="small">
            <div class="kv"><span>控制台版本</span><b>v{{ agent.status?.app_version || "-" }}</b></div>
            <div class="kv">
              <span>被控端版本</span>
              <b>{{ agent.status?.installed_agent_version || "（未播种）" }}</b>
            </div>
            <div class="kv">
              <span>最新版本</span>
              <b>
                {{ agent.update ? `v${agent.update.latest_version}` : "（未检查）" }}
                <n-tag
                  v-if="agent.update?.has_update"
                  type="warning"
                  size="tiny"
                  style="margin-left: 6px"
                >
                  有更新
                </n-tag>
                <n-tag
                  v-else-if="agent.update"
                  type="success"
                  size="tiny"
                  style="margin-left: 6px"
                >
                  已是最新
                </n-tag>
              </b>
            </div>
            <div v-if="agent.update?.published_at" class="kv">
              <span>发布时间</span><b>{{ fmtTime(Date.parse(agent.update.published_at)) }}</b>
            </div>

            <n-space style="margin-top: 12px">
              <n-button size="small" :loading="busy" @click="doCheckUpdate">检查更新</n-button>
              <n-popconfirm @positive-click="doApplyUpdate">
                <template #trigger>
                  <n-button
                    size="small"
                    type="primary"
                    :disabled="!agent.update?.agent_has_update || busy"
                  >
                    更新被控端
                  </n-button>
                </template>
                将下载最新被控端并替换本机正在使用的那份（自动备份旧文件），随后重启服务。确定？
              </n-popconfirm>
            </n-space>
            <div class="hint" style="margin-top: 10px">
              「更新被控端」只替换本机被控端脚本（架构无关的 JS）。控制台自身（桌面应用）请从
              <n-button
                text
                size="tiny"
                :disabled="!agent.update"
                @click="openRelease"
              >
                Release 页面
              </n-button>
              下载安装包。
            </div>
          </n-card>
        </n-grid-item>

        <!-- ④ 日志预览 -->
        <n-grid-item span="4 s:4 m:2">
          <n-card title="最近日志" size="small">
            <template #header-extra>
              <n-space>
                <n-button text size="tiny" @click="logs.load()">刷新</n-button>
                <n-button text size="tiny" @click="router.push({ name: 'logs' })">查看全部</n-button>
              </n-space>
            </template>
            <div v-if="recent.length" class="logs">
              <div v-for="l in recent" :key="l.seq" class="log-line" :class="l.stream">
                <span class="ts">{{ new Date(l.ts).toLocaleTimeString() }}</span>
                <span class="txt">{{ l.line }}</span>
              </div>
            </div>
            <n-text v-else depth="3" style="font-size: 13px">暂无日志</n-text>
          </n-card>
        </n-grid-item>
      </n-grid>

      <n-tooltip trigger="hover">
        <template #trigger>
          <n-text depth="3" style="font-size: 12px; display: block; margin-top: 18px">
            提示：关闭窗口后控制台会缩到托盘继续运行 —— 从托盘菜单可显示窗口或退出。
          </n-text>
        </template>
        若不想后台常驻，可在「运行方式」里关闭「后台运行」
      </n-tooltip>
    </div>
  </n-spin>
</template>

<style scoped>
.wrap {
  max-width: 1100px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  padding: 4px 0;
}
.kv > span {
  opacity: 0.6;
  flex: 0 0 auto;
}
.kv > b {
  font-weight: 500;
  text-align: right;
  min-width: 0;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  max-width: 100%;
}
.switch-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  font-size: 13px;
}
.hint {
  font-size: 12px;
  opacity: 0.55;
  margin-top: 3px;
  line-height: 1.5;
}
.logs {
  max-height: 190px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.log-line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line .ts {
  opacity: 0.45;
  flex: 0 0 auto;
}
.log-line.stderr .txt {
  color: #e88080;
}
.log-line.system .txt {
  color: #63e2b7;
}
</style>
