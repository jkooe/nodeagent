/** 路由表。hash history 便于 Tauri 打包后稳定工作。 */
import { createRouter, createWebHashHistory } from "vue-router";

// 刻意不设 icon 字段：应用内一律不使用图标，导航以纯文字呈现。
// （原因见 CHANGELOG [未发布]：emoji 图标在非系统字体栈的渲染器里会退化成豆腐块，
//   而跨平台「哪套字体栈一定带 emoji」并不成立 —— 与其赌字形，不如不用。）
export interface NavMeta {
  title: string;
}

const routes = [
  // 默认落在「本机服务」—— 这是「打开应用就要能启动/停止/重启」的落点，
  // 而不是先让用户去填一个连接地址。
  { path: "/", redirect: "/local" },
  {
    path: "/local",
    name: "local",
    component: () => import("../views/LocalServiceView.vue"),
    meta: { title: "本机服务" } satisfies NavMeta,
  },
  {
    path: "/logs",
    name: "logs",
    component: () => import("../views/LogsView.vue"),
    meta: { title: "服务日志" } satisfies NavMeta,
  },
  {
    path: "/nodes",
    name: "nodes",
    component: () => import("../views/NodesView.vue"),
    meta: { title: "设备管理" } satisfies NavMeta,
  },
  {
    path: "/overview",
    name: "overview",
    component: () => import("../views/OverviewView.vue"),
    meta: { title: "状态总览" } satisfies NavMeta,
  },
  {
    path: "/terminal",
    name: "terminal",
    component: () => import("../views/TerminalView.vue"),
    meta: { title: "命令执行" } satisfies NavMeta,
  },
  {
    path: "/processes",
    name: "processes",
    component: () => import("../views/ProcessesView.vue"),
    meta: { title: "进程与服务" } satisfies NavMeta,
  },
  {
    path: "/software",
    name: "software",
    component: () => import("../views/SoftwareView.vue"),
    meta: { title: "软件管理" } satisfies NavMeta,
  },
  {
    path: "/files",
    name: "files",
    component: () => import("../views/FilesView.vue"),
    meta: { title: "文件管理" } satisfies NavMeta,
  },
  {
    path: "/audit",
    name: "audit",
    component: () => import("../views/AuditView.vue"),
    meta: { title: "审计日志" } satisfies NavMeta,
  },
];

export const navRoutes = routes.filter((r) => "name" in r);

export default createRouter({
  history: createWebHashHistory(),
  routes,
});
