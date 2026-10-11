//! 开机自启管理 —— 「随系统启动」开关的落地实现。
//!
//! ## 设计：自启的是**控制台的仅服务模式**，不是裸 node
//!
//! 两个候选方案，各有硬伤：
//! - **直接自启 `node agent.mjs`**：Windows 上会弹一个黑色控制台窗口（schtasks 无法指定
//!   `CREATE_NO_WINDOW`），且进程无人托管 —— 崩了不会拉起、也无法从界面停止。
//! - **自启本控制台（`--agent-only`）**：本应用是 GUI 子系统程序，**不会有控制台窗口**；
//!   且它本来就负责「托管被控端」（启动/停止/自动重启/日志），语义完全对齐。
//!
//! 故选后者。`--agent-only` 模式下应用不显示主窗口，直接进托盘并拉起被控端。
//!
//! ## 平台差异
//! | 平台 | 机制 | 位置 |
//! |---|---|---|
//! | macOS | LaunchAgent（用户级，无需提权） | `~/Library/LaunchAgents/<label>.plist` |
//! | Windows | 计划任务（登录时触发，Interactive 登录类型） | 任务名 `<label>` |
//!
//! Windows 用**登录用户 + Interactive** 而非 SYSTEM：被控端的图形能力（截图 / 键鼠 / 窗口）
//! 必须跑在交互式会话里，SYSTEM（会话 0）没有桌面 —— 这一点在真机验证时已实证。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 自启项标识（macOS 的 launchd label / Windows 的计划任务名）。
const LABEL: &str = "cn.jkooe.nodeagent-console";

/// 仅服务模式命令行参数（无窗口、直接进托盘并拉起被控端）。
pub const AGENT_ONLY_FLAG: &str = "--agent-only";

/// 当前可执行文件路径。
fn app_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("取当前程序路径失败：{e}"))
}

/// macOS 上 LaunchAgent plist 的位置。
fn macos_plist_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("拿不到 HOME")?;
    Ok(home.join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")))
}

/// 生成 macOS LaunchAgent plist。
///
/// `RunAtLoad` 保证登录即拉起；**不用** `KeepAlive` —— 让「退出」按钮能真正退出，
/// 用户想恢复就重新登录或再开应用。进程级别的崩溃自愈由控制台的 `AgentManager` 负责，
/// 不该在这里再叠一层（两层自愈会互相打架）。
fn macos_plist(exe: &Path) -> String {
    let exe = xml_escape(&exe.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 nodeagent 控制台生成 —— 请勿手工编辑（界面上的「开机自启」开关会覆写本文件） -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{AGENT_ONLY_FLAG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
"#
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 当前用户的 uid（macOS 的 `launchctl bootstrap gui/<uid>` 需要它）。
///
/// 用 `id -u` 现取，**不硬编码 501** —— 501 只是首个本地用户的常见值，
/// 多用户机器上并不成立。
fn current_uid() -> Option<String> {
    let out = Command::new("id").arg("-u").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// macOS：加载 / 卸载 LaunchAgent。
///
/// 新版 macOS 推荐 `launchctl bootstrap gui/<uid>`，旧版用 `load -w`；两条都试，
/// 任一路径成功即算成功（不同 macOS 版本上可用的那条不一样）。
fn macos_launchctl(plist: &Path, enable: bool) -> Result<String, String> {
    let mut notes: Vec<String> = Vec::new();
    let uid = current_uid();
    let domain = uid.map(|u| format!("gui/{u}"));

    let attempts: Vec<Vec<String>> = if enable {
        let mut v = vec![vec!["load".into(), "-w".into(), plist.to_string_lossy().to_string()]];
        if let Some(d) = &domain {
            v.push(vec!["bootstrap".into(), d.clone(), plist.to_string_lossy().to_string()]);
        }
        v
    } else {
        let mut v = vec![vec!["unload".into(), "-w".into(), plist.to_string_lossy().to_string()]];
        if let Some(d) = &domain {
            v.push(vec!["bootout".into(), format!("{d}/{LABEL}")]);
        }
        v
    };

    for args in attempts {
        match Command::new("launchctl").args(&args).output() {
            Ok(o) if o.status.success() => return Ok(format!("launchctl {} 成功", args[0])),
            Ok(o) => notes.push(format!(
                "launchctl {} 失败：{}",
                args[0],
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => notes.push(format!("launchctl {} 无法执行：{e}", args[0])),
        }
    }
    if enable {
        Err(notes.join("；"))
    } else {
        // 卸载失败不致命：plist 已删，下次登录不会再起
        Ok(format!("（卸载命令未全部成功，但配置已移除）{}", notes.join("；")))
    }
}

/// Windows：注册 / 注销计划任务。
///
/// 用 PowerShell 的 `New-ScheduledTask*` + `Register-ScheduledTask` 而非 `schtasks /TR` ——
/// 后者要拼一层引号转义（路径含空格时尤其容易出错），前者用参数对象，无转义问题。
fn windows_schtasks(exe: &Path, enable: bool) -> Result<String, String> {
    if enable {
        let script = format!(
            r#"$ErrorActionPreference='Stop'
$exe = '{exe}'
$action = New-ScheduledTaskAction -Execute $exe -Argument '{AGENT_ONLY_FLAG}'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '{LABEL}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output ('OK ' + $user)"#,
            exe = exe.display().to_string().replace('\'', "''"),
        );
        run_powershell(&script)
    } else {
        let script = format!(
            r#"$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName '{LABEL}' -Confirm:$false
Write-Output 'OK removed'"#
        );
        run_powershell(&script)
    }
}

fn run_powershell(script: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("无法执行 PowerShell：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// 自启是否已启用。
pub fn is_enabled() -> bool {
    if cfg!(target_os = "macos") {
        macos_plist_path().map(|p| p.exists()).unwrap_or(false)
    } else if cfg!(windows) {
        Command::new("schtasks")
            .args(["/Query", "/TN", LABEL])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    }
}

/// 读取自启状态的完整快照（供界面展示）。
pub fn status() -> Value {
    let exe = app_exe();
    let supported = cfg!(any(target_os = "macos", windows));
    let where_ = if cfg!(target_os = "macos") {
        macos_plist_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    } else if cfg!(windows) {
        format!("计划任务 {LABEL}")
    } else {
        String::new()
    };
    json!({
        "enabled": is_enabled(),
        "supported": supported,
        "location": where_,
        "app_exe": exe.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "mode": AGENT_ONLY_FLAG,
        "note": if supported {
            "开机自启将以「仅服务模式」拉起本控制台：不显示窗口、直接进托盘并托管本机被控端。"
        } else {
            "当前平台暂不支持——请在系统设置里自行添加登录项。"
        },
    })
}

/// 开启 / 关闭开机自启。
pub fn set(enabled: bool) -> Result<Value, String> {
    if !cfg!(any(target_os = "macos", windows)) {
        return Err("当前平台暂不支持自动配置开机自启".to_string());
    }
    let exe = app_exe()?;

    let detail = if cfg!(target_os = "macos") {
        let plist = macos_plist_path()?;
        if enabled {
            if let Some(dir) = plist.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("创建 LaunchAgents 目录失败：{e}"))?;
            }
            std::fs::write(&plist, macos_plist(&exe)).map_err(|e| format!("写入 plist 失败：{e}"))?;
            macos_launchctl(&plist, true)?
        } else {
            if plist.exists() {
                std::fs::remove_file(&plist).map_err(|e| format!("删除 plist 失败：{e}"))?;
            }
            macos_launchctl(&plist, false)?
        }
    } else {
        windows_schtasks(&exe, enabled)?
    };

    let mut snap = status();
    snap["detail"] = json!(detail);
    Ok(snap)
}
