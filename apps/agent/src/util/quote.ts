/**
 * 跨平台「安全字面量」工具 —— 把不可信字符串安全地嵌进 shell / PowerShell 脚本。
 *
 * ## 为什么必须有这个文件
 *
 * 本项目真机踩到过 **P0 级静默 RCE**：把 `JSON.stringify(title)` 直接插进 PowerShell
 * 双引号串，payload `x"; New-Item …; #` 就执行了任意命令 —— 而接口还返回「正常的业务错误」，
 * 调用方完全看不出异常（见 `window.ts` 的历史注释与 bug 报告 W-01）。
 *
 * 两条铁律（违反任一条都会重新引入漏洞）：
 *
 * 1. **PowerShell 里 `\` 不是转义符**（那是 C/JS 的规则）。JSON 产出的 `\"` 会被 PS 解析成
 *    「字面反斜杠 + 字符串结束引号」，后面的内容就成了新语句。
 * 2. **PS 双引号串会做变量插值与子表达式展开**（`$x`、`$(...)`、反引号），
 *    而**单引号串什么都不展开** —— 这是唯一正确的选择。
 *
 * 因此：**任何**嵌入 PowerShell 的不可信值都必须走 `psLit()`；
 * 嵌入 bash/sh 的走 `shLit()`；嵌进命令行参数数组的（`spawn(file, args)`）根本不需要引用，
 * 那是首选方案，不要拼字符串。
 */

/** PowerShell 单引号字面量：内部单引号翻倍，其余字符（含 `$`、反引号、反斜杠）全部原样。 */
export function psLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** PowerShell 数组字面量：`@('a','b')`。空数组产出 `@()`。 */
export function psLitArray(values: readonly string[]): string {
  return `@(${values.map(psLit).join(',')})`;
}

/**
 * POSIX shell 单引号字面量：把 `'` 拆成 `'\''`（闭合 → 转义单引号 → 重开）。
 * 单引号内不会有变量展开、命令替换或反斜杠转义。
 */
export function shLit(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * 校验单引号字面量的形状（供调用侧自检）：首尾是 `'`，且内部**没有落单的单引号**。
 *
 * 原理：正确转义后内部每个 `'` 都成对（`''`），把 `''` 全部消去后不应再残留任何 `'`。
 * 只做形状检查，不替代真机验证。
 */
export function assertSingleQuotedLiteral(lit: string): boolean {
  if (!lit.startsWith("'") || !lit.endsWith("'")) return false;
  return !lit.slice(1, -1).replace(/''/g, '').includes("'");
}

/**
 * Windows 原生命令行参数的「裸传」前提校验。
 *
 * 有些位置**不能用** `psLit()`：例如 `powershell.exe -File <path>` —— 这一段的引号由
 * `powershell.exe` 自己的命令行解析器处理，塞 PS 单引号字面量进去不保证被剥掉。
 * 这种位置只能把路径**裸着**拼进命令行，于是必须保证它**本身含不了任何会改变语义的字符**。
 *
 * 真例（v2.0.3 审查发现，与 W-01 同类）：`util/ps-helper.ts` 把 `mkdtempSync` 产出的临时脚本
 * 路径直接拼进 `-File`。那条路径由本进程生成、正常含不了引号，但**这是隐含前提**——
 * 一旦 `TMP`/`TEMP` 被设成怪路径（或用户目录名含特殊字符），前提就破了，而且是静默的。
 * 故把前提**显式化**：不满足就当场报错，而不是把可疑字符串拼进命令行。
 */
export function isSafeBareWindowsPathArg(v: string): boolean {
  if (v === '' || v.includes('\0')) return false;
  // 引号/反引号/$/&/|/</>/(/)/%/^/!/换行：任何一个都能改变 cmd.exe 或 PS 的解析
  if (/["'`$&|<>()%^!\r\n\t]/.test(v)) return false;
  // 结尾是单个反斜杠会在双引号包裹时吃掉闭引号（cmd 的经典怪癖）
  return !/\\$/.test(v);
}
