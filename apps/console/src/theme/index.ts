import {
  darkTheme,
  lightTheme,
  type GlobalTheme,
  type GlobalThemeOverrides,
} from "naive-ui";

/**
 * 控制台只有两套主题，且都**只用中性灰阶** —— 不含彩色品牌色。
 *
 * 「简约白」= 白底 + 浅灰分线，靠留白与层次而不是颜色区分区域。
 * 「高级灰」= 低饱和冷灰底 + 浅灰字，同样只用灰阶。
 *
 * 之所以真的把两套都做出来、而不是只留一套浅色：深色在长时间盯日志/终端时
 * 更省眼（运维场景常态），浅色在白天与投屏时更清楚。两套共用同一份灰阶逻辑
 * （只是明暗反转），故维护成本不翻倍。
 */
export type ThemeName = "white" | "gray";

export const THEME_STORAGE_KEY = "nodeagent.console.theme";

/**
 * 调色板。**这是全应用唯一一份色值定义**：
 * 既喂给 naive-ui 的 themeOverrides，也由 App.vue 注入成 `--na-*` CSS 变量
 * 供自定义样式使用。两处各写一份必然漂移（本项目吃过这类亏），故只此一处。
 */
export interface Palette {
  /** 页面底色 */
  bg: string;
  /** 侧栏底色（与 bg 拉开一档层次，而不是靠边框） */
  sider: string;
  /** 卡片 / 浮层底色 */
  card: string;
  /** 内嵌区：日志框、代码块、表头 */
  sunken: string;
  border: string;
  borderStrong: string;
  text1: string;
  text2: string;
  text3: string;
  hover: string;
  /** 主色位（naive-ui 的 primary）—— 刻意用中性色，不用彩色 */
  accent: string;
  accentHover: string;
  accentPressed: string;
  /** 主色底之上的文字色 */
  accentText: string;
  /** 品牌字（侧栏站点标题），不再用青绿 */
  brand: string;
  /** 语义色：统一降饱和，保证「白 + 灰」的底色观感 */
  ok: string;
  warn: string;
  err: string;
  info: string;
  /** 语义色的浅底（用于 Tag / 告警块） */
  okSoft: string;
  warnSoft: string;
  errSoft: string;
  infoSoft: string;
  tooltipBg: string;
  tooltipText: string;
  scrollbar: string;
  scrollbarHover: string;
  shadow: string;
  /** 原生控件（滚动条、表单控件）的明暗 */
  scheme: "light" | "dark";
}

/** 简约白：白为主，灰为辅。层次靠灰阶（页底 < 侧栏 < 卡片），不靠颜色。 */
const WHITE: Palette = {
  // 页底刻意不是 #ffffff：卡片也是白的，两者同色就只能靠 1px 分线撑层次，
  // 整页会发"糊"。压一档浅灰后卡片自然浮起来，且仍是「白」为主。
  bg: "#f4f4f5",
  sider: "#fafafa",
  card: "#ffffff",
  sunken: "#f5f5f6",
  border: "#e8e8ea",
  borderStrong: "#d6d6da",
  text1: "#1a1a1c",
  text2: "#55555c",
  text3: "#8e8e97",
  hover: "#eeeeef",
  accent: "#1f1f23",
  accentHover: "#33333a",
  accentPressed: "#0d0d10",
  accentText: "#ffffff",
  brand: "#1a1a1c",
  ok: "#4f8768",
  warn: "#9c7c39",
  err: "#b4635c",
  info: "#5b789a",
  okSoft: "#eef4f0",
  warnSoft: "#f7f3e9",
  errSoft: "#f8efee",
  infoSoft: "#eef2f7",
  tooltipBg: "#2b2b30",
  tooltipText: "#f2f2f3",
  scrollbar: "#d6d6da",
  scrollbarHover: "#bcbcc2",
  shadow: "0 1px 2px rgba(16, 16, 20, 0.05)",
  scheme: "light",
};

/** 高级灰：雾霾冷灰调。低饱和、低对比，但保证正文可读。 */
const GRAY: Palette = {
  bg: "#1d1f22",
  sider: "#181a1d",
  card: "#24262a",
  sunken: "#1a1c1f",
  border: "#32353a",
  borderStrong: "#41454c",
  text1: "#dcdee2",
  text2: "#a2a6ae",
  text3: "#71757c",
  hover: "#2b2e33",
  accent: "#dcdee2",
  accentHover: "#eef0f2",
  accentPressed: "#c6c9ce",
  accentText: "#1d1f22",
  brand: "#e6e8eb",
  ok: "#83a891",
  warn: "#b99a5c",
  err: "#cc8b82",
  info: "#8098b5",
  okSoft: "#262f2a",
  warnSoft: "#2f2c22",
  errSoft: "#312625",
  infoSoft: "#252b33",
  tooltipBg: "#3a3e44",
  tooltipText: "#e8eaed",
  scrollbar: "#3a3e44",
  scrollbarHover: "#4a4f56",
  shadow: "0 1px 2px rgba(0, 0, 0, 0.35)",
  scheme: "dark",
};

/**
 * 调色板 → `--na-*` CSS 变量。
 *
 * 名字写死而不是自动 kebab 化：自动转换一旦改字段名，CSS 侧会**静默**失配
 * （变量没人定义 → 颜色落回继承值，不报错、类型也抓不到）。写死则改字段时
 * 至少能在这里一眼看到。
 */
export function cssVars(p: Palette): Record<string, string> {
  return {
    "--na-bg": p.bg,
    "--na-sider": p.sider,
    "--na-card": p.card,
    "--na-sunken": p.sunken,
    "--na-border": p.border,
    "--na-border-strong": p.borderStrong,
    "--na-text-1": p.text1,
    "--na-text-2": p.text2,
    "--na-text-3": p.text3,
    "--na-hover": p.hover,
    "--na-accent": p.accent,
    "--na-accent-text": p.accentText,
    "--na-brand": p.brand,
    "--na-ok": p.ok,
    "--na-warn": p.warn,
    "--na-err": p.err,
    "--na-info": p.info,
    "--na-tooltip-bg": p.tooltipBg,
    "--na-tooltip-text": p.tooltipText,
    "--na-scrollbar": p.scrollbar,
    "--na-scrollbar-hover": p.scrollbarHover,
    "--na-shadow": p.shadow,
  };
}

function overridesOf(p: Palette): GlobalThemeOverrides {
  return {
    common: {
      // —— 主色：中性灰。naive-ui 默认主色是绿色，留着它整套配色立刻"不简单"。
      // 主按钮、开关激活态、进度条、勾选框都吃这一个值。
      primaryColor: p.accent,
      primaryColorHover: p.accentHover,
      primaryColorPressed: p.accentPressed,
      primaryColorSuppl: p.accentHover,

      // —— 语义色降饱和（仍保留：运维工具里"运行中/出错"必须一眼可辨，
      // 全部灰化会导致误读；故只在徽章与告警这类小面积上出现）
      successColor: p.ok,
      successColorHover: p.ok,
      successColorPressed: p.ok,
      successColorSuppl: p.ok,
      warningColor: p.warn,
      warningColorHover: p.warn,
      warningColorPressed: p.warn,
      warningColorSuppl: p.warn,
      errorColor: p.err,
      errorColorHover: p.err,
      errorColorPressed: p.err,
      errorColorSuppl: p.err,
      infoColor: p.info,
      infoColorHover: p.info,
      infoColorPressed: p.info,
      infoColorSuppl: p.info,

      textColorBase: p.text1,
      textColor1: p.text1,
      textColor2: p.text2,
      textColor3: p.text3,
      placeholderColor: p.text3,
      placeholderColorDisabled: p.text3,
      iconColor: p.text3,
      iconColorHover: p.text2,

      dividerColor: p.border,
      borderColor: p.border,
      closeIconColor: p.text3,

      bodyColor: p.bg,
      cardColor: p.card,
      modalColor: p.card,
      popoverColor: p.card,
      tableColor: p.card,
      inputColor: p.sunken,
      inputColorDisabled: p.sunken,
      tagColor: p.sunken,
      actionColor: p.sunken,
      avatarColor: p.sunken,
      codeColor: p.sunken,
      tabColor: p.sunken,
      tableHeaderColor: p.sunken,
      hoverColor: p.hover,
      tableColorHover: p.hover,
      tableColorStriped: p.sunken,
      pressedColor: p.hover,
      progressRailColor: p.sunken,
      railColor: p.sunken,
      scrollbarColor: p.scrollbar,
      scrollbarColorHover: p.scrollbarHover,

      borderRadius: "6px",
      borderRadiusSmall: "4px",
    },

    Layout: {
      color: p.bg,
      siderColor: p.sider,
      headerColor: p.bg,
      siderBorderColor: p.border,
      headerBorderColor: p.border,
      textColor: p.text1,
    },

    Menu: {
      color: p.sider,
      itemTextColor: p.text2,
      itemTextColorHover: p.text1,
      itemTextColorActive: p.text1,
      itemTextColorActiveHover: p.text1,
      itemTextColorChildActive: p.text1,
      itemColorHover: p.hover,
      itemColorActive: p.hover,
      itemColorActiveHover: p.hover,
      itemColorActiveCollapsed: p.hover,
      itemIconColor: p.text3,
      itemIconColorHover: p.text2,
      itemIconColorActive: p.text1,
      groupTextColor: p.text3,
      arrowColor: p.text3,
      borderColorHorizontal: p.border,
      borderRadius: "6px",
    },

    Card: {
      color: p.card,
      colorModal: p.card,
      colorPopover: p.card,
      colorEmbedded: p.sunken,
      textColor: p.text1,
      titleTextColor: p.text1,
      borderColor: p.border,
      actionColor: p.sunken,
      titleFontWeight: "600",
      boxShadow: p.shadow,
    },

    DataTable: {
      thColor: p.sunken,
      thColorHover: p.hover,
      tdColor: p.card,
      tdColorHover: p.hover,
      tdColorStriped: p.sunken,
      borderColor: p.border,
      thTextColor: p.text2,
      tdTextColor: p.text2,
      thFontWeight: "600",
      loadingColor: p.accent,
    },

    Input: {
      color: p.card,
      colorFocus: p.card,
      colorDisabled: p.sunken,
      textColor: p.text1,
      textColorDisabled: p.text3,
      placeholderColor: p.text3,
      border: `1px solid ${p.border}`,
      borderHover: `1px solid ${p.borderStrong}`,
      borderFocus: `1px solid ${p.accent}`,
      borderDisabled: `1px solid ${p.border}`,
      boxShadowFocus: `0 0 0 2px ${p.hover}`,
      caretColor: p.accent,
      iconColor: p.text3,
      clearColor: p.text3,
      clearColorHover: p.text2,
    },

    Alert: {
      color: p.sunken,
      border: `1px solid ${p.border}`,
      titleTextColor: p.text1,
      contentTextColor: p.text2,
      iconColor: p.text3,
      borderInfo: `1px solid ${p.info}`,
      colorInfo: p.infoSoft,
      titleTextColorInfo: p.text1,
      contentTextColorInfo: p.text2,
      iconColorInfo: p.info,
      borderSuccess: `1px solid ${p.ok}`,
      colorSuccess: p.okSoft,
      titleTextColorSuccess: p.text1,
      contentTextColorSuccess: p.text2,
      iconColorSuccess: p.ok,
      borderWarning: `1px solid ${p.warn}`,
      colorWarning: p.warnSoft,
      titleTextColorWarning: p.text1,
      contentTextColorWarning: p.text2,
      iconColorWarning: p.warn,
      borderError: `1px solid ${p.err}`,
      colorError: p.errSoft,
      titleTextColorError: p.text1,
      contentTextColorError: p.text2,
      iconColorError: p.err,
    },

    Tag: {
      color: p.sunken,
      textColor: p.text2,
      border: "1px solid transparent",
      colorBordered: p.sunken,
      borderRadius: "5px",
      colorPrimary: p.accent,
      textColorPrimary: p.accentText,
      borderPrimary: "1px solid transparent",
      colorInfo: p.infoSoft,
      textColorInfo: p.info,
      borderInfo: `1px solid ${p.info}`,
      colorSuccess: p.okSoft,
      textColorSuccess: p.ok,
      borderSuccess: `1px solid ${p.ok}`,
      colorWarning: p.warnSoft,
      textColorWarning: p.warn,
      borderWarning: `1px solid ${p.warn}`,
      colorError: p.errSoft,
      textColorError: p.err,
      borderError: `1px solid ${p.err}`,
    },

    Divider: {
      color: p.border,
      textColor: p.text3,
    },

    Progress: {
      railColor: p.sunken,
      fillColor: p.accent,
      fillColorSuccess: p.ok,
      fillColorWarning: p.warn,
      fillColorError: p.err,
      fillColorInfo: p.info,
      textColorLineInner: p.accentText,
      textColorLineOuter: p.text2,
    },

    Switch: {
      railColor: p.borderStrong,
      railColorActive: p.accent,
      buttonColor: p.card,
      iconColor: p.text3,
      loadingColor: p.text3,
    },

    Statistic: {
      labelTextColor: p.text3,
      valueTextColor: p.text1,
      valuePrefixTextColor: p.text2,
      valueSuffixTextColor: p.text2,
    },

    Empty: {
      textColor: p.text3,
      iconColor: p.text3,
      extraTextColor: p.text3,
    },

    Spin: {
      color: p.accent,
      textColor: p.text2,
    },

    Popover: {
      color: p.card,
      textColor: p.text1,
      dividerColor: p.border,
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
    },

    Tooltip: {
      color: p.tooltipBg,
      textColor: p.tooltipText,
    },

    Modal: {
      color: p.card,
      textColor: p.text1,
    },

    List: {
      color: p.card,
      textColor: p.text1,
      borderColor: p.border,
    },

    Collapse: {
      titleTextColor: p.text1,
      textColor: p.text2,
      dividerColor: p.border,
    },

    Checkbox: {
      labelTextColor: p.text1,
      color: p.card,
      border: `1px solid ${p.borderStrong}`,
      borderChecked: `1px solid ${p.accent}`,
      colorChecked: p.accent,
      checkMarkColor: p.accentText,
    },
  };
}

export interface ThemePreset {
  name: ThemeName;
  label: string;
  desc: string;
  base: GlobalTheme;
  palette: Palette;
  overrides: GlobalThemeOverrides;
}

export const THEMES: Record<ThemeName, ThemePreset> = {
  white: {
    name: "white",
    label: "简约白",
    desc: "白底浅灰分线",
    base: lightTheme,
    palette: WHITE,
    overrides: overridesOf(WHITE),
  },
  gray: {
    name: "gray",
    label: "高级灰",
    desc: "雾霾冷灰低对比",
    base: darkTheme,
    palette: GRAY,
    overrides: overridesOf(GRAY),
  },
};

export const THEME_LIST: ThemePreset[] = [THEMES.white, THEMES.gray];

/** 越界 / 脏数据一律落回默认主题，避免启动即白屏。 */
export function normalizeThemeName(v: unknown): ThemeName {
  return v === "gray" ? "gray" : "white";
}
