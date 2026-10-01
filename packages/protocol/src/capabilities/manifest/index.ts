// 能力清单聚合（按组拆分后在此汇总，对外仍是单一 CAPABILITY_MANIFEST）
import type { CapabilityDescriptor } from '../../messages.js';
import { AUTOMATION_CAPABILITIES } from './automation.js';
import { FILES_CAPABILITIES } from './files.js';
import { GRAPHICS_CAPABILITIES } from './graphics.js';
import { SOFTWARE_CAPABILITIES } from './software.js';
import { SYSTEM_CAPABILITIES } from './system.js';

/**
 * v1 标准能力清单（39 项）。
 * 被控端按此声明并在 auth_ok 中返回；控制端据此展示与校验。
 * 顺序即 CLI/MCP 的展示顺序（系统面 → 软件 → 图形 → 文件 → 自动化）。
 */
export const CAPABILITY_MANIFEST: CapabilityDescriptor[] = [
  ...SYSTEM_CAPABILITIES,
  ...SOFTWARE_CAPABILITIES,
  ...GRAPHICS_CAPABILITIES,
  ...FILES_CAPABILITIES,
  ...AUTOMATION_CAPABILITIES,
];
