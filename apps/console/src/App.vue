<script setup lang="ts">
import { watchEffect } from "vue";
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN } from "naive-ui";
import AppShell from "./components/AppShell.vue";
import QuitGuard from "./components/QuitGuard.vue";
import { cssVars } from "./theme";
import { useThemeStore } from "./stores/theme";

const theme = useThemeStore();

/**
 * 把调色板写成 `--na-*` CSS 变量挂到根元素。
 *
 * 色值只在 `theme/index.ts` 定义一份，此处在运行期注入给自定义样式用 ——
 * 免得「TS 调色板」与「CSS 硬编码」各写一份后静默漂移（换主题时一半新一半旧，
 * 不报错、类型也抓不到）。
 *
 * 同时设 `color-scheme`：不设的话滚动条、`<input>` 等原生控件会一直是浅色，
 * 在「高级灰」下白得刺眼。
 */
watchEffect(() => {
  const { palette, name } = theme.preset;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(palette))) {
    root.style.setProperty(k, v);
  }
  root.style.colorScheme = palette.scheme;
  root.dataset.theme = name;
});
</script>

<template>
  <n-config-provider
    :theme="theme.preset.base"
    :theme-overrides="theme.preset.overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <!-- 必须在 dialog-provider 内部：它要用 useDialog() 弹退出确认 -->
        <quit-guard />
        <app-shell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
