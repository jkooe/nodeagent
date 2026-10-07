//! 局域网发现（对齐 `packages/client/src/discovery.ts`）。
//!
//! 只监听被控端 UDP 广播、不发送任何数据，因此不引入额外暴露面。
//! M1 实现基础解析；v22 最小化广播的 HMAC 验签留待后续（需对齐 JSON 序列化顺序）。

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;

/// 发现到的被控端。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredNode {
    pub node_id: String,
    /// 可达地址：取报文来源 IP（一定可达）。
    pub host: String,
    /// 被控端自报地址（多网卡时可能与来源不同，仅供参考）。
    pub advertised_host: String,
    pub port: u16,
    pub tls: bool,
    pub auth_mode: String,
    pub input_enabled: bool,
    pub platform: String,
    /// v22：详情是否通过 HMAC 验签。false = 明文广播，仅作展示、不可当凭据。
    pub authenticated: bool,
    /// 最近一次收到广播的时间（Unix 毫秒）。
    pub last_seen: u64,
}

#[derive(Debug, Deserialize)]
struct RawBeacon {
    service: Option<String>,
    node_id: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    tls: Option<bool>,
    auth_mode: Option<String>,
    input_enabled: Option<bool>,
    platform: Option<String>,
    minimal: Option<bool>,
    #[serde(default)]
    detail: Option<BeaconDetail>,
}

#[derive(Debug, Deserialize)]
struct BeaconDetail {
    host: Option<String>,
    port: Option<u16>,
    tls: Option<bool>,
    auth_mode: Option<String>,
    input_enabled: Option<bool>,
    platform: Option<String>,
}

/// 默认发现端口（对齐 methods.ts 的 `DEFAULT_DISCOVERY_PORT`）。
pub const DEFAULT_DISCOVERY_PORT: u16 = 8766;

/// 默认被控端端口。
const DEFAULT_AGENT_PORT: u16 = 8765;

/// 监听一段时间后返回发现的设备（对齐 `discoverOnce`）。
pub async fn discover_once(wait_ms: u64, port: u16) -> Result<Vec<DiscoveredNode>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("发现监听失败（UDP {port}）: {e}"))?;

    let mut nodes: HashMap<String, DiscoveredNode> = HashMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
    let mut buf = [0u8; 2048];

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, socket.recv_from(&mut buf)).await {
            Ok(Ok((len, src))) => {
                if let Some(node) = parse_beacon(&buf[..len], src) {
                    nodes.insert(node.node_id.clone(), node);
                }
            }
            _ => break,
        }
    }

    let now = now_ms();
    let mut list: Vec<DiscoveredNode> = nodes.into_values().collect();
    // 过滤 TTL 过期项（30s），按最近出现排序。
    list.retain(|n| now - n.last_seen <= 30_000);
    list.sort_by_key(|n| std::cmp::Reverse(n.last_seen));
    Ok(list)
}

fn parse_beacon(data: &[u8], src: std::net::SocketAddr) -> Option<DiscoveredNode> {
    let raw: RawBeacon = serde_json::from_slice(data).ok()?;
    if raw.service.as_deref() != Some("nodeagent") {
        return None;
    }
    let node_id = raw.node_id?;

    // v22 最小化广播：顶层只剩存在性，真实信息在 detail 里。
    let detail = raw.minimal.unwrap_or(false).then_some(raw.detail).flatten();

    Some(DiscoveredNode {
        node_id,
        // 地址永远取「报文来源 IP」—— 一定可达。
        host: src.ip().to_string(),
        advertised_host: detail
            .as_ref()
            .and_then(|d| d.host.clone())
            .or(raw.host)
            .unwrap_or_else(|| src.ip().to_string()),
        port: detail
            .as_ref()
            .and_then(|d| d.port)
            .or(raw.port)
            .unwrap_or(DEFAULT_AGENT_PORT),
        tls: detail.as_ref().and_then(|d| d.tls).or(raw.tls).unwrap_or(true),
        auth_mode: detail
            .as_ref()
            .and_then(|d| d.auth_mode.clone())
            .or(raw.auth_mode)
            .unwrap_or_else(|| "psk".to_string()),
        input_enabled: detail
            .as_ref()
            .and_then(|d| d.input_enabled)
            .or(raw.input_enabled)
            .unwrap_or(false),
        platform: detail
            .as_ref()
            .and_then(|d| d.platform.clone())
            .or(raw.platform)
            .unwrap_or_else(|| "unknown".to_string()),
        authenticated: false,
        last_seen: now_ms(),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
