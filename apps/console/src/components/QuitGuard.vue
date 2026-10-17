<script setup lang="ts">
/**
 * 退出确认（2026-10-17 皇上需求）。
 *
 * ## 它解决的误解
 * 旧行为：点托盘「退出」→ 控制台立刻消失，但被控端因 `kill_on_drop(false)`
 * **成为孤儿继续监听端口**。用户以为「关了窗口就干净了」，实际还有个看不见的
 * 进程在跑 —— 下次启动还会撞上「端口已被占用」。
 *
 * ## 为什么做成三选一
 * 「留不留一个正在监听端口的后台进程」是有副作用的决定，必须由用户明确选择：
 *   - 保留被控端 → 远程仍可接管（下次启动控制台会自动复用它）
 *   - 停止被控端 → 彻底清净，但本机不再可被远程接管
 *   - 关闭弹窗     → 取消退出
 *
 * ## 为什么不在 Rust 里弹系统对话框
 * 前端已有 `n-dialog-provider`，复用它就不必新增 `tauri-plugin-dialog` 依赖，
 * 视觉也与全应用一致。Rust 侧只负责「发一个事件 + 提供 quit_app 命令」。
 */
import { onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDialog } from "naive-ui";
import { h } from "vue";
import { quitApp } from "../api";

const dialog = useDialog();
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  try {
    unlisten = await listen("na-quit-requested", () => {
      const d = dialog.warning({
        title: "退出控制台",
        closable: true,
        maskClosable: true,
        content: () =>
          h("div", { style: "line-height:1.7" }, [
            h("div", "退出后本机被控端要怎么处理？"),
            h(
              "div",
              { style: "margin-top:6px;font-size:12px;opacity:.72" },
              "保留：仍然可以被远程接管（下次打开控制台会自动复用它）；停止：彻底结束，退出后不再有后台进程。",
            ),
          ]),
        positiveText: "保留被控端，退出",
        negativeText: "停止被控端，退出",
        onPositiveClick: () => {
          d.loading = true;
          void quitApp(true);
        },
        onNegativeClick: () => {
          d.loading = true;
          void quitApp(false);
        },
      });
    });
  } catch {
    /* 事件注册失败不应阻断应用启动 */
  }
});

onUnmounted(() => {
  unlisten?.();
  unlisten = null;
});
</script>

<template>
  <!-- 纯逻辑组件，不渲染任何可见内容 -->
  <span style="display: none" />
</template>
