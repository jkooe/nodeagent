/** 通用格式化工具。 */

export function formatBytes(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec?: number | null): string {
  if (sec == null || Number.isNaN(sec)) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export function formatTime(ms?: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function formatPct(v?: number | null): string {
  if (v == null || Number.isNaN(v)) return "-";
  return `${v.toFixed(1)}%`;
}
