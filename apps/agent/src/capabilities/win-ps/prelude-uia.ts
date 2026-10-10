/**
 * UIA 控件树预加载段（含 Where 谓词与属性读取）
 *
 * 2026-10 从 window.ts 抽出（结构拆分，**内容逐字节不变**）。
 * ⚠️ WIN_HELPER_PRELUDE 是本段与另外几段的拼接 —— 改动会直接影响常驻 PS 助手。
 * 拆分以 tests/unit/win-prelude.test.mjs + prelude sha256 比对双重把关。
 */

/**
 * v14：常驻助手预加载段 —— 这些内容**只在助手启动时执行一次**。
 * 过去每次调用都重新编译 C# / 加载程序集，真机实测占单次耗时的绝大部分
 * （window.list 1267ms / window.focus 1631ms，其中「起进程+编译」是固定成本）。
 */
export const UIA_ASSEMBLY_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
function Get-WinByTitle([string]$re) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    try {
      $t = $w.Current.Name
      if ($t -and $t -match $re) { return $w }
    } catch {}
  }
  return $null
}

# v14：按子串在给定 scope 内遍历查找（FindAll + 子串过滤）。
# UIA 的 PropertyCondition 只能精确匹配，故必须遍历后过滤；遍历规模设上限防超大 UI 树卡死。
# v2.0.0：读取元素的 UIA 属性（v2.0.0 语义属性化）。
# 为什么逐个 try：ValuePattern / SelectionItemPattern / TogglePattern 并非所有控件
# 都支持（不支持时 GetSupportedPattern 返回 false 或抛异常），而且**部分应用
# （Electron / 游戏 UI）根本给不出值** —— 拿不到就留空，由上层判"未知"而非"false"。
function Get-UiaProps($e) {
  $enabled = $true
  try { $enabled = [bool]$e.Current.IsEnabled } catch {}
  $value = $null
  try {
    $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -ne $null) { $value = $vp.Current.Value }
  } catch {}
  $selected = $null
  try {
    $sp = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($sp -ne $null) { $selected = [bool]$sp.Current.IsSelected }
  } catch {}
  $toggle = $null
  try {
    $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($tp -ne $null) { $toggle = "$($tp.Current.ToggleState)" }
  } catch {}
  return @{ enabled = $enabled; value = $value; selected = $selected; toggle = $toggle }
}

function Test-UiaWhere($props, $where) {
  if ($where -eq $null) { return $true }
  foreach ($k in $where.Keys) {
    $want = $where[$k]
    switch ($k) {
      'enabled'  { if ($props.enabled -ne [bool]$want) { return $false } }
      'selected' { if ($null -eq $props.selected -or $props.selected -ne [bool]$want) { return $false } }
      'value'    { if ($props.value -eq $null -or $props.value -notlike [string]$want) { return $false } }
      default    { }   # 未知键忽略（Node 侧已白名单校验）
      'toggle'   { if ($props.toggle -eq $null -or $props.toggle -notlike [string]$want) { return $false } }
    }
  }
  return $true
}

function Find-UiaByText($scope, [string]$text, [int]$limit, [string]$ct, $where) {
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  if ($ct -ne '') {
    $ctObj = $null
    try { $ctObj = [System.Windows.Automation.ControlType]::$ct } catch {}
    if ($ctObj -ne $null) {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomitionElement]::ControlTypeProperty, $ctObj)
    }
  }
  $found = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = New-Object System.Collections.ArrayList
  $scanned = 0
  foreach ($e in $found) {
    if ($out.Count -ge $limit) { break }
    $scanned++
    if ($scanned -gt 20000) { break }
    try {
      $nm = $e.Current.Name
      if ([string]::IsNullOrEmpty($nm)) { continue }
      if ($text -ne '' -and $nm.IndexOf($text, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      $r = $e.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      $props = Get-UiaProps $e
      if (-not (Test-UiaWhere $props $where)) { continue }
      [void]$out.Add([pscustomobject]@{
        name = $nm
        control_type = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\\.','')
        automation_id = $e.Current.AutomationId
        x = [int]($r.Left + $r.Width / 2)
        y = [int]($r.Top + $r.Height / 2)
        left = [int]$r.Left; top = [int]$r.Top
        width = [int]$r.Width; height = [int]$r.Height
        enabled = $props.enabled
        value = $props.value
        selected = $props.selected
        toggle = $props.toggle
      })
    } catch {}
  }
  return ,$out
}
`;
