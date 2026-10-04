// 能力清单的对外门面（实现已按组拆分到 ./capabilities/ 下，公共 API 保持不变）
export { CapabilityNames } from './capabilities/names.js';
export type { CapabilityName } from './capabilities/names.js';
export { filterSchema } from './capabilities/schemas.js';
export { CAPABILITY_MANIFEST } from './capabilities/manifest/index.js';

import { CAPABILITY_MANIFEST as MANIFEST } from './capabilities/manifest/index.js';
import type { CapabilityDescriptor } from './messages.js';

export function findCapability(name: string): CapabilityDescriptor | undefined {
  return MANIFEST.find((c) => c.name === name);
}

/**
 * 比对「本地声明的能力」与「远端实际提供的能力」（v20）。
 *
 * 用途：新旧版本混用时给出**可执行的提示**，而不是等到调用时抛
 * `E_CAPABILITY_NOT_FOUND` 让人摸不着头脑。
 * - `missingOnRemote`：本地有、远端没有 → **远端较旧**，需要更新被控端
 * - `unknownLocally`：远端有、本地没有 → **本控制端较旧**，可正常用（远端是加法演进）
 */
export function capabilityDiff(
  localNames: string[],
  remoteNames: string[],
): { missingOnRemote: string[]; unknownLocally: string[] } {
  const local = new Set(localNames);
  const remote = new Set(remoteNames);
  return {
    missingOnRemote: localNames.filter((n) => !remote.has(n)),
    unknownLocally: remoteNames.filter((n) => !local.has(n)),
  };
}

