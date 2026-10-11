//! 控制台自身的偏好设置（持久化到磁盘）。
//!
//! ## 为什么设置要在 Rust 侧存一份
//! 前端有 `localStorage`，本来够用。但**「仅服务模式」（`--agent-only`，开机自启用）下
//! 窗口是隐藏的** —— 此时仍需要知道「要不要拉起被控端」「崩了要不要自动重启」。
//! 若只存 localStorage，就得靠隐藏的 webview 跑 JS 来驱动，既不直观也不可靠。
//! 故由 Rust 侧持有唯一真相，前端只做读写。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 应用启动时自动拉起本机被控端（默认开 —— 这正是「打开就有服务」的期望）
    pub auto_start_agent: bool,
    /// 被控端意外退出时自动重启（默认开 —— 「后台运行」的应有之义）
    pub auto_restart: bool,
    /// 点窗口关闭按钮时最小化到托盘而非退出（默认开 —— 「后台运行」）
    pub close_to_tray: bool,
    /// 连接本机被控端时是否自动接受自签证书（默认开；关掉就得手工钉指纹）
    pub insecure: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_start_agent: true,
            auto_restart: true,
            close_to_tray: true,
            insecure: true,
        }
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("console.json")
}

pub fn load(config_dir: &Path) -> Settings {
    let p = settings_path(config_dir);
    match std::fs::read_to_string(&p) {
        Ok(text) => {
            // 剥离 BOM（Windows 上由 PowerShell 写出的 JSON 可能带 BOM）
            serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or_default()
        }
        Err(_) => Settings::default(),
    }
}

pub fn save(config_dir: &Path, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let text = serde_json::to_string_pretty(s).map_err(|e| format!("序列化设置失败：{e}"))?;
    std::fs::write(settings_path(config_dir), format!("{text}\n"))
        .map_err(|e| format!("写入设置失败：{e}"))
}

/// 把前端传来的「部分字段」合并进当前设置（未提供的字段保持原值）。
pub fn merge(config_dir: &Path, patch: &Value) -> Result<Settings, String> {
    let mut cur = load(config_dir);
    let mut raw = serde_json::to_value(&cur).map_err(|e| e.to_string())?;
    if let (Some(obj), Some(p)) = (raw.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            // 类型不匹配的键直接忽略（前端传 `undefined` 序列化成 null 是常见情形）
            if obj.get(k).map(|old| std::mem::discriminant(old) == std::mem::discriminant(v)).unwrap_or(false) {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    cur = serde_json::from_value(raw).map_err(|e| format!("设置字段类型不合法：{e}"))?;
    save(config_dir, &cur)?;
    Ok(cur)
}

pub fn to_json(s: &Settings) -> Value {
    serde_json::to_value(s).unwrap_or_else(|_| json!({}))
}
