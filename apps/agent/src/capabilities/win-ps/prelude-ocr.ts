/**
 * OCR 引擎预加载段：截图 / DPI / WinRT 类型与 Await 辅助函数
 *
 * 2026-10 从 window.ts 抽出（结构拆分，**内容逐字节不变**）。
 * ⚠️ WIN_HELPER_PRELUDE 是本段与另外几段的拼接 —— 改动会直接影响常驻 PS 助手。
 * 拆分以 tests/unit/win-prelude.test.mjs + prelude sha256 比对双重把关。
 */

/**
 * OCR 引擎预加载段（v14）：截图 / WinRT 类型与 Await 辅助函数。
 * 注意：WinRT 类型加载用 try/catch 包住 —— 个别环境缺组件时只应让 OCR 退化，
 * 不该让整个助手（连带 window.list/focus/UIA）起不来。
 *
 * ⚠️ DPI 感知（`SetProcessDPIAware`）**已从本段移出**，改由 WIN_HELPER_PRELUDE 最前面的
 * `PS_DPI_AWARE` 无条件执行：放在这个 try 里会被 catch 顺带吞掉，一旦吞掉
 * 助手就退回 DPI 不感知，`GetWindowRect` 与 UIA / 截图坐标口径不一致（真机 2026-10-12 排查）。
 */
export const OCR_PRELUDE = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function global:Await($WinRtTask, $ResultType) {
    $asTask = $script:asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  $script:ocrReady = $true
} catch {
  $script:ocrReady = $false
}
`;
