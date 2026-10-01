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
