//! M3 能力探针：对真实被控端逐项调用「文件 / 审计 / 软件 / 进程服务」能力，核对契约。
//!
//! 输出**字段契约**而非数据预览——顶层键 + 数组首元素的键，
//! 便于与前端 `apps/console/src/types/index.ts` 的类型声明逐项比对。
//!
//! 用法：`cargo run --example probe -- <url> <key> [base_dir] [--full]`
//!   --full  额外打印完整 JSON（长字段截断到 400 字符）

use nodeagent_client::{Client, ClientOptions};
use serde_json::{json, Value};

/// 一行对象 → `a, b, c` 形式的键清单。
fn keys_of(v: &Value) -> String {
    match v {
        Value::Object(m) => m.keys().cloned().collect::<Vec<_>>().join(", "),
        other => format!("<{}>", type_name(other)),
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// 打印「字段契约」：顶层键 + 各数组字段的首元素键。
fn contract(v: &Value, indent: &str) {
    if let Value::Object(map) = v {
        for (k, val) in map {
            match val {
                Value::Array(items) if !items.is_empty() => {
                    println!("{indent}{k}: array[{}] → {{ {} }}", items.len(), keys_of(&items[0]));
                }
                other if other.is_object() => {
                    println!("{indent}{k}: object → {{ {} }}", keys_of(other));
                }
                other => {
                    let shown = match other {
                        Value::String(s) if s.chars().count() > 60 => {
                            format!("string(\"{}…\")", s.chars().take(60).collect::<String>())
                        }
                        Value::Array(a) => format!("array[{}]", a.len()),
                        _ => format!("{}({other})", type_name(other)),
                    };
                    println!("{indent}{k}: {shown}");
                }
            }
        }
    } else {
        println!("{indent}{}", type_name(v));
    }
}

async fn call(client: &Client, cap: &str, args: Value, full: bool) -> bool {
    match client.invoke(cap, args).await {
        Ok(r) if r.status == "ok" => {
            println!("  ✓ {cap}");
            if let Some(d) = &r.data {
                contract(d, "      ");
                if full {
                    let s = serde_json::to_string_pretty(d).unwrap_or_default();
                    let s: String = s.chars().take(400).collect();
                    println!("      ── full ── {s}");
                }
            }
            true
        }
        Ok(r) => {
            let e = r.error.unwrap_or_default();
            println!("  ✗ {cap}: [{}] {}", e.name, e.message);
            false
        }
        Err(e) => {
            println!("  ✗ {cap}: {e}");
            false
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let full = argv.iter().any(|a| a == "--full");
    let pos: Vec<String> = argv.into_iter().filter(|a| !a.starts_with("--")).collect();

    let url = pos.first().cloned().unwrap_or_else(|| "ws://127.0.0.1:8765".to_string());
    let key = pos.get(1).cloned().unwrap_or_default();
    let base = pos.get(2).cloned().unwrap_or_else(|| "/tmp/nodeagent-e2e".to_string());

    let client = Client::new(ClientOptions {
        url,
        key,
        client_id: "probe".to_string(),
        insecure: true,
        ..Default::default()
    });

    let caps = client.connect().await?;
    println!("连接成功，{} 项能力", caps.len());

    // 平台探测——决定 platform-only 能力是否预期可用。
    let info = client.invoke("system.info", json!({})).await?;
    let os = info
        .data
        .as_ref()
        .and_then(|d| d.get("os"))
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let is_windows = os == "Windows";
    println!("被控端平台：{os}（platform-only 能力{}预期可用）\n", if is_windows { "" } else { "不" });

    let mut pass = 0usize;
    let mut fail = 0usize;

    println!("【文件 fs.*】");
    for (cap, args) in [
        ("fs.list", json!({ "path": base })),
        ("fs.stat", json!({ "path": format!("{base}/agent.json") })),
        ("fs.read", json!({ "path": format!("{base}/agent.json"), "max_bytes": 2048 })),
        (
            "fs.write",
            json!({ "path": format!("{base}/probe.txt"), "data": "hello from rust probe", "append": false, "create_dirs": true }),
        ),
    ] {
        if call(&client, cap, args, full).await {
            pass += 1
        } else {
            fail += 1
        }
    }

    println!("\n【审计 system.audit.*】");
    for (cap, args) in [
        ("system.audit.list", json!({ "limit": 5 })),
        ("system.audit.verify", json!({})),
    ] {
        if call(&client, cap, args, full).await {
            pass += 1
        } else {
            fail += 1
        }
    }

    println!("\n【软件 / 进程 / 服务】");
    let platform_only = ["app.list", "app.install", "system.service.list"];
    for (cap, args) in [
        ("app.list", json!({})),
        ("app.install", json!({ "package": "__nonexistent_probe__", "silent": true })),
        ("system.process.list", json!({ "limit": 5 })),
        ("system.service.list", json!({ "limit": 5 })),
    ] {
        let ok = call(&client, cap, args, full).await;
        // platform-only 能力在非 Windows 被控端上失败属**预期**，不计入失败。
        if ok {
            pass += 1;
        } else if !is_windows && platform_only.contains(&cap) {
            println!("      ↑ 非 Windows 被控端，属预期");
        } else {
            fail += 1;
        }
    }

    println!("\n【其他页面依赖】");
    for (cap, args) in [
        ("system.info", json!({})),
        ("system.status", json!({})),
        ("system.shell.exec", json!({ "command": "echo probe-ok" })),
    ] {
        if call(&client, cap, args, full).await {
            pass += 1
        } else {
            fail += 1
        }
    }

    println!("\n═══ 通过 {pass} · 失败 {fail} ═══");
    client.close();
    if fail > 0 {
        std::process::exit(1);
    }
    Ok(())
}
