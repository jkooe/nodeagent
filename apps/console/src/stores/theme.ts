import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import {
  THEMES,
  THEME_STORAGE_KEY,
  normalizeThemeName,
  type ThemeName,
} from "../theme";

/**
 * 主题选择。
 *
 * 只存 **localStorage**，不落 Rust 侧 settings：那是「仅服务模式」（无窗口、
 * 常驻托盘）也要生效的偏好，而主题是纯图形偏好 —— 没有窗口时毫无意义。
 * 放 localStorage 可避免为一件纯前端的事去动 Rust 命令面与契约守卫。
 */
export const useThemeStore = defineStore("theme", () => {
  const name = ref<ThemeName>(read());

  const preset = computed(() => THEMES[name.value]);
  const isWhite = computed(() => name.value === "white");

  function read(): ThemeName {
    try {
      return normalizeThemeName(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      // 隐私模式等场景下 localStorage 可能不可用 —— 不该因此启动失败
      return "white";
    }
  }

  function set(next: ThemeName) {
    name.value = normalizeThemeName(next);
  }

  function toggle() {
    set(name.value === "white" ? "gray" : "white");
  }

  watch(
    name,
    (v) => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, v);
      } catch {
        /* 忽略：存不下只影响下次启动的默认值 */
      }
    },
    { immediate: true },
  );

  return { name, preset, isWhite, set, toggle };
});
