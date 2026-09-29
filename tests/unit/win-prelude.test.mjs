import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIN_HELPER_PRELUDE } from '../../apps/agent/dist/capabilities/window.js';

/**
 * 回归测试：常驻助手的预加载段必须四段齐全。
 *
 * 为什么需要它：这些段是**多行模板字符串拼接**，一旦某次编辑没拼进去，
 * 表现是「常量未被引用 → 被 esbuild tree-shake 掉 → 运行时才报找不到类型」，
 * 而且不报编译错 —— 真机上就是这么静默坏掉的（OCR 与图像匹配同时失效）。
 * 断言关键标记，任何一段丢失都会立刻失败。
 */
test('预加载段：Win32 C# 类型齐全', () => {
  assert.match(WIN_HELPER_PRELUDE, /public class NAWin32/, '缺少 Win32 P/Invoke 类型');
  assert.match(WIN_HELPER_PRELUDE, /EnumWindows/, '缺 EnumWindows 声明');
});

test('预加载段：UIA 程序集与查找函数齐全', () => {
  assert.match(WIN_HELPER_PRELUDE, /Add-Type -AssemblyName UIAutomationClient/);
  assert.match(WIN_HELPER_PRELUDE, /function Get-WinByTitle/);
  assert.match(WIN_HELPER_PRELUDE, /function Find-UiaByText/, '缺子串查找函数（v14 起 body 依赖它）');
});

test('预加载段：OCR（含 WinRT 与 Await 辅助）齐全', () => {
  assert.match(WIN_HELPER_PRELUDE, /Add-Type -AssemblyName System\.Windows\.Forms/);
  assert.match(WIN_HELPER_PRELUDE, /OcrEngine, Windows\.Foundation, ContentType=WindowsRuntime/);
  assert.match(WIN_HELPER_PRELUDE, /function global:Await/);
  assert.match(WIN_HELPER_PRELUDE, /\$script:ocrReady/);
});

test('预加载段：图像模板匹配 C# 齐全且带 -ReferencedAssemblies', () => {
  assert.match(WIN_HELPER_PRELUDE, /public class NAImageMatch/);
  assert.match(WIN_HELPER_PRELUDE, /public static string Match\(/);
  assert.match(WIN_HELPER_PRELUDE, /public static string Capture\(/);
  // Add-Type 的坑：不显式引用程序集，编译期就找不到 System.Drawing.Imaging
  assert.match(
    WIN_HELPER_PRELUDE,
    /-ReferencedAssemblies System\.Drawing/,
    '缺 -ReferencedAssemblies：C# 编译会失败（真机踩过）',
  );
});

test('预加载段：C# 源码必须纯 ASCII（否则 Add-Type 在中文系统上乱码）', () => {
  // Add-Type 会把源码按**系统 ANSI 代码页**（中文 Windows = GBK）落盘再编译，
  // C# 里的中文注释必然乱码 → 编译失败（真机踩过：整个图像匹配引擎静默不可用）。
  const csharpBlocks = WIN_HELPER_PRELUDE.match(/Add-Type @"[\s\S]*?"@/g) ?? [];
  assert.ok(csharpBlocks.length > 0, '应至少有一个内嵌 C# 块');
  for (const [i, block] of csharpBlocks.entries()) {
    const bad = [...new Set(block.match(/[^\x00-\x7f]/g) ?? [])];
    assert.equal(
      bad.length,
      0,
      `第 ${i + 1} 个 C# 块含非 ASCII 字符 ${bad.join('')} —— 必须改为英文注释`,
    );
  }
});

test('预加载段：C# 内不得残留裸引号 JSON 字面量（TS 模板串会把 \\" 吃成 "）', () => {
  // 陷阱：在 TS 模板字符串里写 \\" 会得到裸 "，C# 收到未转义引号即编译失败。
  // 正确做法是用 C# 字符常量 '"' 拼 JSON。这里断言几种典型坏形态不存在。
  const csharpBlocks = WIN_HELPER_PRELUDE.match(/Add-Type @"[\s\S]*?"@/g) ?? [];
  for (const block of csharpBlocks) {
    assert.ok(!/\[\{"/.test(block), 'C# 中出现 "[" + "{" 的裸引号形态，应改用字符常量拼 JSON');
    assert.ok(!/"\{[^"]*"/.test(block.replace(/"[^"]*"/g, '')), 'C# 字符串中出现未转义引号');
  }
});

test('预加载段：C# 内局部常量不得重复声明（编辑残留会编译失败）', () => {
  const csharpBlocks = WIN_HELPER_PRELUDE.match(/Add-Type @"[\s\S]*?"@/g) ?? [];
  for (const block of csharpBlocks) {
    const decls = block.match(/\bQ\s*=\s*'";/g) ?? [];
    assert.ok(decls.length <= 1, `Q 被声明了 ${decls.length} 次 —— 重复定义会让 C# 编译失败`);
  }
});

test('预加载段：顺序与完整性（四段都在同一个字符串里）', () => {
  const idxWin32 = WIN_HELPER_PRELUDE.indexOf('public class NAWin32');
  const idxUia = WIN_HELPER_PRELUDE.indexOf('function Get-WinByTitle');
  const idxOcr = WIN_HELPER_PRELUDE.indexOf('OcrEngine, Windows.Foundation');
  const idxImg = WIN_HELPER_PRELUDE.indexOf('public class NAImageMatch');
  for (const [name, idx] of Object.entries({ idxWin32, idxUia, idxOcr, idxImg })) {
    assert.ok(idx > 0, `${name} 未包含在预加载段中`);
  }
  assert.ok(idxWin32 < idxUia && idxUia < idxOcr && idxOcr < idxImg, '四段顺序应为 Win32 → UIA → OCR → 图像');
});
