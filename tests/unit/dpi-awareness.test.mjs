import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { WIN_HELPER_PRELUDE } from '../../apps/agent/dist/capabilities/window.js';
import { buildListDisplaysScript, buildCaptureScript } from '../../apps/agent/dist/capabilities/screen.js';
import { buildInputPsScript } from '../../apps/agent/dist/capabilities/input.js';
import { PS_DPI_AWARE } from '../../apps/agent/dist/util/dpi.js';

/**
 * 回归守卫：**屏幕坐标口径必须统一为物理像素**。
 *
 * ## 背景（2026-10-12 真机实证，虚拟化平台的 Win11 ARM / 宿主 200% 缩放 / 物理 2560×1440）
 *
 * PowerShell 默认 DPI 不感知，于是**同一个进程里并存两套坐标系**：
 *   - `Screen.Bounds` / `SystemInformation.VirtualScreen` → **逻辑**（1280×720）
 *   - `CopyFromScreen` / `SetCursorPos`                   → **物理**
 *     （缺省整屏只截到左上 1/4；(100,100) 实际落到 (200,200)）
 * 而 UIA（`screen.find`）返回的**一直是物理坐标**。结果：
 *   ① 缺省 `screen.capture` 只截到屏幕左上 1/4，`screen.info` 报错尺寸；
 *   ② `screen.find` 的坐标直接喂 `input.mouse.click` → **点到两倍远**（「找得到、点不准」）。
 * 两者都**不报任何错**，只是结果不对 —— 属于最难发现的一类缺陷。
 *
 * 修法：所有坐标路径统一执行 `PS_DPI_AWARE`（见 apps/agent/src/util/dpi.ts）。
 *
 * ## 为什么断言「下发的脚本串」而不是「源码里出现过常量」
 * 首版守卫用源码扫描（文件里是否出现 `PS_DPI_AWARE`），**注入故障实测不会变红** ——
 * 因为同一个文件里别处也引用了该常量。现改为直接断言各能力**真正发给 PowerShell 的脚本文本**，
 * 以及调用的先后顺序（顺序错了同样不生效）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 把任意平台的路径归一到 posix 形态。
 *
 * ⚠️ 必须显式归一：`path.relative()` 在 Windows 返回 `apps\agent\…`，
 * 而在 macOS/Linux 返回 `apps/agent/…`。任何用 `/` 硬编码的 `includes()` 判断
 * 在 Windows 上恒为 false —— 本地永远绿，CI 才红（2026-10-12 真例）。
 */
export const toPosix = (p) => p.replaceAll('\\', '/');

/**
 * `capabilities/win-ps/` 下的片段文件是否应被兜底扫描排除。
 *
 * 这些片段（`prelude-*` / `body-*`）不自带 DPI 感知，而是由 `WIN_HELPER_PRELUDE`
 * 在拼接时于**最前面**统一注入 —— 其序位已由「助手前置段：DPI 感知必须最先执行」断言。
 * 因此排除它们是正确的，**但判断本身不得依赖平台分隔符**（函数内自行归一）。
 */
export const isWinPsFragment = (relPath, name) =>
  toPosix(relPath).includes('capabilities/win-ps/') && /^(prelude|body)-/.test(name);

/** 断言：脚本里注入了 DPI 感知，且**早于**第一个依赖它的调用。 */
function assertDpiInjectedFirst(script, { before, label }) {
  assert.ok(script.includes(PS_DPI_AWARE), `${label}：未注入 PS_DPI_AWARE`);
  const iDpi = script.indexOf('::SetProcessDPIAware()');
  const iUse = script.indexOf(before);
  assert.ok(iDpi >= 0, `${label}：脚本里找不到 SetProcessDPIAware() 调用`);
  assert.ok(iUse > 0, `${label}：脚本里找不到锚点 "${before}"（测试本身需要更新）`);
  assert.ok(
    iDpi < iUse,
    `${label}：DPI 感知必须早于 "${before}" —— 晚于它执行等于没设，坐标仍按逻辑空间处理`,
  );
}

test('PS_DPI_AWARE：确实调用 SetProcessDPIAware（先声明 P/Invoke 再调用）', () => {
  assert.match(PS_DPI_AWARE, /DllImport\("user32\.dll"\)/, '缺少 user32 P/Invoke 声明');
  assert.match(PS_DPI_AWARE, /\[void\]\[NADpiAware\]::SetProcessDPIAware\(\)/, '缺少 SetProcessDPIAware 调用');
  assert.ok(
    PS_DPI_AWARE.indexOf('Add-Type') < PS_DPI_AWARE.indexOf('[void][NADpiAware]'),
    '必须先 Add-Type 声明类型，再调用',
  );
});

test('screen.info：display 列表脚本必须 DPI 感知（否则报逻辑尺寸）', () => {
  assertDpiInjectedFirst(buildListDisplaysScript(), { before: 'Screen]::AllScreens', label: 'screen.info' });
});

test('screen.capture：截图脚本必须 DPI 感知（否则缺省整屏只截到 1/4）', () => {
  const script = buildCaptureScript({ x: 0, y: 0, width: 10, height: 10 }, { scale: 1, format: 'jpeg', quality: 85 });
  assertDpiInjectedFirst(script, { before: 'CopyFromScreen', label: 'screen.capture' });
});

test('input.mouse/keyboard：输入脚本必须 DPI 感知（否则与 screen.find 的物理坐标对不上）', () => {
  const script = buildInputPsScript(['[NAInput]::MoveTo(1, 1)']);
  assertDpiInjectedFirst(script, { before: 'Add-Type -TypeDefinition $code', label: 'input.*' });
  assert.match(script, /SetCursorPos/, '输入脚本应含 SetCursorPos（锚点自检）');
});

test('助手前置段：DPI 感知必须最先执行', () => {
  assert.ok(
    WIN_HELPER_PRELUDE.startsWith(PS_DPI_AWARE),
    'WIN_HELPER_PRELUDE 必须以 PS_DPI_AWARE 开头 —— DPI 感知必须在任何 System.Windows.Forms / ' +
      '截屏 / 光标调用之前生效，否则整段白设',
  );
});

test('助手前置段：DPI 感知只有一份，且不得退回到 OCR 的 try/catch 里', () => {
  // 只数**调用**形态（P/Invoke 声明是 `bool SetProcessDPIAware();`，不带 `::`）
  const hits = WIN_HELPER_PRELUDE.match(/::SetProcessDPIAware\(\)/g) ?? [];
  assert.equal(
    hits.length,
    1,
    `::SetProcessDPIAware() 调用出现 ${hits.length} 次 —— 应恰好 1 次（唯一位于前置段开头的 ` +
      'PS_DPI_AWARE）。OCR 段的 try/catch 会吞掉放进去的调用，造成「有时感知、有时不感知」的漂移',
  );

  const idxDpi = WIN_HELPER_PRELUDE.indexOf('::SetProcessDPIAware()');
  const idxForms = WIN_HELPER_PRELUDE.indexOf('Add-Type -AssemblyName System.Windows.Forms');
  const idxRect = WIN_HELPER_PRELUDE.indexOf('GetWindowRect');
  assert.ok(idxForms > 0 && idxRect > 0, '前置段应含 Forms 程序集与 GetWindowRect 声明');
  assert.ok(idxDpi < idxForms, 'DPI 感知必须早于 System.Windows.Forms 加载');
  assert.ok(idxDpi < idxRect, 'DPI 感知必须早于 GetWindowRect 的使用段');
});

test('screen.record：全屏探测必须 DPI 感知（否则录到左上 1/4）', () => {
  const src = read('apps/agent/src/capabilities/record.ts');
  assert.match(
    src,
    /\$\{PS_DPI_AWARE\};\s*Add-Type -AssemblyName System\.Windows\.Forms;\s*\$vs =/,
    'record.ts 的全屏探测里 PS_DPI_AWARE 必须紧贴在 VirtualScreen 读取之前',
  );
});

/**
 * 兜底（nudge，非红证）：任何**新**写进 capabilities 的坐标文件都会被点出来。
 * 它拦不住「文件里引用了常量但没接到实际脚本」这种退化 —— 那种由上面的脚本级断言负责。
 */
test('兜底：capabilities 下命中坐标信号的新文件必须引用 PS_DPI_AWARE', () => {
  const COORD_SIGNALS = [
    'CopyFromScreen',
    'SystemInformation]::VirtualScreen',
    'Cursor]::Position',
    'Screen]::AllScreens',
    'Screen]::PrimaryScreen',
  ];
  const dir = join(ROOT, 'apps/agent/src/capabilities');
  const offenders = [];

  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const rel = toPosix(relative(ROOT, full));
      // 片段文件由 WIN_HELPER_PRELUDE 统一提供 DPI 感知（上面已断言其序位）
      if (isWinPsFragment(rel, name)) continue;
      const src = readFileSync(full, 'utf8');
      const hit = COORD_SIGNALS.find((s) => src.includes(s));
      if (hit && !src.includes('PS_DPI_AWARE')) offenders.push(`${rel}（命中 "${hit}"）`);
    }
  };
  walk(dir);

  assert.deepEqual(
    offenders,
    [],
    '以下文件在用屏幕坐标却没引用 PS_DPI_AWARE —— 请 import 并在坐标调用前执行：\n' +
      offenders.map((o) => `  - ${o}`).join('\n'),
  );
});

/**
 * 跨平台回归：排除逻辑必须与路径分隔符无关。
 *
 * 首版写的是 `rel.includes('capabilities/win-ps/')` —— 在 Windows 上 `rel` 形如
 * `apps\agent\…`，该判断**恒为 false** → 片段文件被误报成违规，于是
 * **本地 macOS 全绿、CI 才红**（2026-10-12 真例：`prelude-image.ts` 命中
 * `CopyFromScreen` 被点名）。本测试直接喂 Windows 形态路径，把这类差异
 * 钉进「本地可验」的范围，不再依赖真的跑在 Windows 上才发现。
 */
test('兜底守卫：片段文件排除逻辑必须与路径分隔符无关', () => {
  const win = 'apps\\agent\\src\\capabilities\\win-ps\\prelude-image.ts';
  const posix = 'apps/agent/src/capabilities/win-ps/prelude-image.ts';

  assert.equal(toPosix(win), posix, 'toPosix 必须把反斜杠归一为斜杠');
  assert.equal(isWinPsFragment(win, 'prelude-image.ts'), true, 'Windows 反斜杠路径必须被识别为片段');
  assert.equal(isWinPsFragment(posix, 'prelude-image.ts'), true, 'posix 路径必须被识别为片段');
  assert.equal(isWinPsFragment('apps\\agent\\src\\capabilities\\win-ps\\body-list.ts', 'body-list.ts'), true);

  // 反向：非片段、或不在 win-ps 目录下的一律**不得**被排除（否则兜底形同虚设）
  assert.equal(
    isWinPsFragment('apps\\agent\\src\\capabilities\\screen.ts', 'screen.ts'),
    false,
    'capabilities 顶层文件不得被排除',
  );
  assert.equal(
    isWinPsFragment('apps\\agent\\src\\capabilities\\win-ps\\helper.ts', 'helper.ts'),
    false,
    'win-ps 下的非片段文件（无 prelude-/body- 前缀）不得被排除',
  );
});
