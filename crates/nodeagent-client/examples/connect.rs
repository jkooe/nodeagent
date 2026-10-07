//! 连接一个真实 nodeagent 被控端的最小示例。
//!
//! 用法：`cargo run --example connect -- <url> <key> [client_id]`
//! 例如：`cargo run --example connect -- ws://127.0.0.1:8765 test-psk-key`

use nodeagent_client::{Client, ClientEvent, ClientOptions};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let url = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "ws://127.0.0.1:8765".to_string());
    let key = args.get(2).cloned().unwrap_or_default();
    let client_id = args
        .get(3)
        .cloned()
        .unwrap_or_else(|| "rust-example".to_string());

    let client = Client::new(ClientOptions {
        url: url.clone(),
        key,
        client_id,
        insecure: true,
        auto_reconnect: false,
        ..Default::default()
    });

    client.set_handler(std::sync::Arc::new(|evt| {
        if let ClientEvent::Log(msg) = evt {
            println!("[log] {msg}");
        }
    }));

    let caps = client.connect().await?;
    println!("握手成功，{} 项能力", caps.len());
    println!("agent 版本: {:?}", client.agent_version());
    println!("证书指纹: {:?}", client.peer_cert_fingerprint());
    for c in caps.iter().take(12) {
        println!("  - {}  (risk={}, v{})", c.name, c.risk, c.version);
    }

    let res = client.invoke("system.info", json!({})).await?;
    println!("\nsystem.info → status={}", res.status);
    if let Some(data) = &res.data {
        println!("{}", serde_json::to_string_pretty(data)?);
    }

    client.close();
    Ok(())
}
