/**
 * 控制台「命令 / 事件 / 资源」三组契约守卫。
 *
 * ⚠️ 为什么必须钉死（本项目反复吃过「两份真相」的亏）
 * -------------------------------------------------
 * 前端调 `invoke("agent_start")`，若 Rust 侧忘了在 `generate_handler!` 里注册，
 * **编译不报错、类型检查也不报错** —— 只在用户点下按钮时得到一个
 * "command agent_start not found"。事件名同理：Rust `emit("na-agent-state")`
 * 与前端 `listen("na-agent-state")` 拼错一个字母，界面就**永远不刷新**且毫无提示。
 * 资源映射同理：`resolve_*` 在 Rust 里找 `agent.mjs`，而打包映射写成别的名字，
 * 结果是「开发期全绿、装完包找不到文件」。
 *
 * 三类都属于**静默失效**，故用本用例把三份契约对齐：
 *   ① Rust `generate_handler![...]`  ⇄  前端 `invoke("...")`
 *   ② Rust `emit("na-...")`          ⇄  前端 `listen("na-...")`
 *   ③ `tauri.bundle.gen.json` 的 resource 目标名  ⇄  Rust `resolve_*` 查找的字面量
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const CONSOLE = join(repoRoot, 'apps', 'console');
const LIB_RS = join(CONSOLE, 'src-tauri', 'src', 'lib.rs');
const AGENT_RS = join(CONSOLE, 'src-tauri', 'src', 'agent.rs');
const SIDECAR_RS = join(CONSOLE, 'src-tauri', 'src', 'sidecar.rs');
const API_TS = join(CONSOLE, 'src', 'api', 'index.ts');
const STORE_TS = join(CONSOLE, 'src', 'stores', 'agent.ts');
const GEN_JSON = join(CONSOLE, 'src-tauri', 'tauri.bundle.gen.json');

const libRs = readFileSync(LIB_RS, 'utf8');
const apiTs = readFileSync(API_TS, 'utf8');

/** 取 Rust `generate_handler![...]` 里注册的命令名。 */
function rustCommands() {
  const m = /generate_handler!\s*\[([\s\S]*?)\]\s*\)/.exec(libRs);
  assert.ok(m, '未在 lib.rs 找到 generate_handler! 列表');
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.replace(/\/\/.*$/gm, '').trim())
      .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s)),
  );
}

/** 取前端 `invoke<T>("name", ...)` 调用到的命令名。 */
function tsCommands() {
  const out = new Set();
  // 形如：invoke<AgentStatus>("agent_status") / invoke<void>("disconnect")
  //     /  invoke<InvokeResult<T>>("invoke_capability")  ← 泛型可嵌套（`InvokeResult<T>`），
  //       故字符集要排除 `(` `)` `;`，否则会在第一个 `>` 处提前截断而漏掉这一条。
  for (const m of apiTs.matchAll(/invoke\s*(?:<[^;()]{0,200}>)?\s*\(\s*"([a-z_][a-z0-9_]*)"/g)) {
    out.add(m[1]);
  }
  return out;
}

test('前端调用的每个 Tauri 命令都已在 Rust 注册', () => {
  const rust = rustCommands();
  const ts = tsCommands();
  assert.ok(rust.size >= 15, `Rust 命令解析异常，只取到 ${rust.size} 个`);
  assert.ok(ts.size >= 15, `前端命令解析异常，只取到 ${ts.size} 个`);

  const missing = [...ts].filter((c) => !rust.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `前端调用了未注册的命令（运行时会报 "command not found"）：${missing.join(', ')}`,
  );
});

test('Rust 注册的每个命令都被前端使用（无死命令）', () => {
  const rust = rustCommands();
  const ts = tsCommands();
  const unused = [...rust].filter((c) => !ts.has(c)).sort();
  assert.deepEqual(
    unused,
    [],
    `Rust 注册了但前端从未调用的命令（要么删掉、要么补上前端调用）：${unused.join(', ')}`,
  );
});

test('Rust 发出的事件名与前端监听的一致', () => {
  const emitted = new Set([...libRs.matchAll(/emit\(\s*"(na-[a-z0-9-]+)"/g)].map((m) => m[1]));
  const stores = readFileSync(STORE_TS, 'utf8')
    + readFileSync(join(CONSOLE, 'src', 'stores', 'conn.ts'), 'utf8');
  const listened = new Set([...stores.matchAll(/listen<[^>]*>\(\s*"(na-[a-z0-9-]+)"/g)].map((m) => m[1]));

  assert.ok(emitted.size >= 5, `Rust 事件名解析异常，只取到 ${emitted.size} 个：${[...emitted]}`);
  assert.ok(listened.size >= 5, `前端事件名解析异常，只取到 ${listened.size} 个：${[...listened]}`);

  const notListened = [...emitted].filter((e) => !listened.has(e)).sort();
  assert.deepEqual(notListened, [], `Rust 发出但前端无监听的事件：${notListened.join(', ')}`);

  const notEmitted = [...listened].filter((e) => !emitted.has(e)).sort();
  assert.deepEqual(notEmitted, [], `前端监听了但 Rust 从不发出的事件：${notEmitted.join(', ')}`);
});

test('打包资源映射的目标名与 Rust 查找的字面量一致', () => {
  // gen 片段是 prepare-console.mjs 的产物；测它的**目标名**（value）与 Rust 侧一致。
  // 若未生成（例如只跑单测、没跑打包准备），则跳过而不是误报。
  if (!existsSync(GEN_JSON)) return;
  const gen = JSON.parse(readFileSync(GEN_JSON, 'utf8'));
  const values = new Set(Object.values(gen.bundle.resources));

  // Rust 侧实际查找的文件名（必须在 resource 目标名里出现，否则装完包找不到）
  // node 在 Windows 上叫 node.exe —— 两者任一即可
  const hasNode = values.has('node') || values.has('node.exe');
  assert.ok(hasNode, `资源映射里没有 node 运行时：${[...values].join(', ')}`);
  for (const name of ['sidecar.mjs', 'agent.mjs']) {
    assert.ok(values.has(name), `资源映射里缺少 ${name}：${[...values].join(', ')}`);
  }

  // 反向：Rust 源码里确实在找这几个名字（防止「映射改了、Rust 没跟上」）
  const agentRs = readFileSync(AGENT_RS, 'utf8');
  const sidecarRs = readFileSync(SIDECAR_RS, 'utf8');
  assert.match(agentRs, /"agent\.mjs"/, 'agent.rs 未在查找 agent.mjs');
  assert.match(sidecarRs, /"sidecar\.mjs"/, 'sidecar.rs 未在查找 sidecar.mjs');
});

test('sidecar 与 Rust 的方法名对齐（check_update / download）', () => {
  const sidecarSrc = readFileSync(join(CONSOLE, 'sidecar', 'main.mjs'), 'utf8');
  for (const method of ['check_update', 'download', 'connect', 'disconnect', 'invoke', 'state']) {
    assert.match(
      sidecarSrc,
      new RegExp(`\\b${method}\\s*\\(|\\b${method}\\s*:`),
      `sidecar 未实现方法 ${method}`,
    );
  }
  // Rust 侧调用的方法名必须都在 sidecar 里存在
  const called = new Set(
    [...libRs.matchAll(/\.request\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  for (const m of called) {
    assert.match(
      sidecarSrc,
      new RegExp(`\\b${m}\\s*\\(|\\b${m}\\s*:`),
      `Rust 调用了 sidecar 的 "${m}"，但 sidecar 未实现`,
    );
  }
});

test('新页面已在路由表中注册', () => {
  const router = readFileSync(join(CONSOLE, 'src', 'router', 'index.ts'), 'utf8');
  for (const name of ['local', 'logs']) {
    assert.match(router, new RegExp(`name:\\s*"${name}"`), `路由缺少 ${name}`);
  }
  // 首页必须是「本机服务」—— 否则用户打开应用先看到一个要填地址的页面，
  // 与「打开就能启动/停止/重启」的目标相悖
  assert.match(router, /path:\s*"\/",\s*redirect:\s*"\/local"/, '默认路由应指向 /local');
  // 每个 view 文件都必须真实存在（懒加载是字符串，写错文件名编译期不报错）
  const views = readdirSync(join(CONSOLE, 'src', 'views'));
  for (const m of router.matchAll(/import\(\s*"\.\.\/views\/([\w]+)\.vue"\s*\)/g)) {
    assert.ok(views.includes(`${m[1]}.vue`), `路由引用了不存在的视图：${m[1]}.vue`);
  }
});

test('自定义样式用到的 --na-* 变量都由调色板定义', () => {
  const themeTsPath = join(CONSOLE, 'src', 'theme', 'index.ts');
  const themeTs = readFileSync(themeTsPath, 'utf8');

  // `cssVars()` 返回的键就是可用变量全集
  const defined = new Set(
    [...themeTs.matchAll(/"(--na-[^"]+)"\s*:/g)].map((m) => m[1]),
  );
  assert.ok(
    defined.size >= 10,
    `调色板变量只解析到 ${defined.size} 个 —— 守卫自身失效，先查正则`,
  );

  // 扫全 src 的使用点（定义文件自身豁免）
  //
  // 字符集刻意放宽到 `[^)\s,;]+` 而不是 `[a-z0-9-]+`：后者遇到
  // `var(--na-sunkenTypo)` 这种含大写的拼错，会在 `T` 处停下导致整个模式**不匹配**，
  // 于是「写错的变量名」反而逃过检查 —— 守卫静默漏报，比没有守卫更危险。
  const used = new Map(); // 变量 → 首个出现位置
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.(vue|ts|css)$/.test(e.name) && p !== themeTsPath) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/var\(\s*(--na-[^)\s,;]+)\s*\)/g)) {
          if (!used.has(m[1])) used.set(m[1], p);
        }
      }
    }
  };
  walk(join(CONSOLE, 'src'));

  assert.ok(used.size > 0, '未扫到任何 --na-* 使用点 —— 守卫自身失效');

  // 关键：`var(--na-typo)` 这种拼错的变量**不会报错**，颜色只是静默落回继承值，
  // 类型检查、构建、运行都不吭声。只能靠这条断言。
  for (const [v, where] of used) {
    assert.ok(
      defined.has(v),
      `${v}（${where}）被使用但 cssVars() 未定义 —— 颜色会静默落回继承值`,
    );
  }
});

test('index.html 的首帧兜底色与调色板一致', () => {
  const themeTs = readFileSync(join(CONSOLE, 'src', 'theme', 'index.ts'), 'utf8');
  const blockOf = (name) => {
    const i = themeTs.indexOf(`const ${name}: Palette = {`);
    assert.ok(i > 0, `未找到 ${name} 调色板`);
    return themeTs.slice(i, themeTs.indexOf('\n};', i));
  };
  const bgOf = (name) => {
    const m = /bg:\s*"(#[0-9a-fA-F]{6})"/.exec(blockOf(name));
    assert.ok(m, `未从 ${name} 调色板解析出 bg`);
    return m[1];
  };

  // index.html 在 Vue 接管前先刷底色，是**唯一**允许的色值重复处（见文件内注释）。
  // 允许重复就必须有守卫：改调色板忘了改它 → 深色用户每次启动闪一帧白。
  const html = readFileSync(join(CONSOLE, 'index.html'), 'utf8');
  for (const name of ['WHITE', 'GRAY']) {
    const bg = bgOf(name);
    assert.ok(
      html.includes(bg),
      `index.html 的首帧兜底色缺少 ${name}.bg = ${bg} —— 换主题时会闪一帧错色`,
    );
  }
});
