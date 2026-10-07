//! 端到端：起一个 mock 被控端（WebSocket），验证 Rust client 的
//! psk 握手（hello → challenge → auth → auth_ok）+ invoke 全链路。

use nodeagent_client::{Client, ClientOptions};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// 从 mock 被控端读取下一条文本消息并解析为 JSON。
async fn read_json(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Value {
    use futures_util::StreamExt;
    while let Some(msg) = ws.next().await {
        if let Ok(Message::Text(t)) = msg {
            return serde_json::from_str(&t).expect("消息应为合法 JSON");
        }
    }
    panic!("mock 被控端连接提前关闭");
}

#[tokio::test]
async fn psk_handshake_and_invoke_roundtrip() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // mock 被控端：应答 hello / auth / invoke。
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        use futures_util::SinkExt;

        // hello → challenge
        let hello = read_json(&mut ws).await;
        assert_eq!(hello["method"], "hello");
        let hello_id = hello["id"].as_str().unwrap();
        let nonce = "nonce-abc123";
        ws.send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": hello_id,
                "result": { "nonce": nonce, "expires_at": 4_102_444_800_000_i64 }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        // auth → auth_ok
        let auth = read_json(&mut ws).await;
        assert_eq!(auth["method"], "auth");
        assert_eq!(auth["params"]["nonce"], nonce);
        assert!(auth["params"]["hmac"].is_string(), "psk 模式应携带 hmac");
        let auth_id = auth["id"].as_str().unwrap();
        ws.send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": auth_id,
                "result": {
                    "capabilities": [{
                        "name": "system.ping",
                        "version": "1.0",
                        "description": "探活",
                        "risk": "low",
                        "params_schema": { "type": "object" }
                    }],
                    "authorized": null,
                    "auth_mode": "psk",
                    "agent_version": "1.0.0"
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

        // invoke → result
        let invoke = read_json(&mut ws).await;
        assert_eq!(invoke["method"], "invoke");
        assert_eq!(invoke["params"]["capability"], "system.ping");
        let invoke_id = invoke["id"].as_str().unwrap();
        ws.send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": invoke_id,
                "result": { "status": "ok", "data": { "pong": true, "ts": 42 } }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    });

    // 控制端：连接 → 握手 → 校验元信息 → 调用。
    let client = Client::new(ClientOptions {
        url: format!("ws://{addr}"),
        key: "secret".to_string(),
        client_id: "control-1".to_string(),
        ..Default::default()
    });

    let caps = client.connect().await.unwrap();
    assert_eq!(caps.len(), 1);
    assert_eq!(caps[0].name, "system.ping");
    assert_eq!(client.agent_version().as_deref(), Some("1.0.0"));
    assert_eq!(client.state(), nodeagent_client::ConnState::Connected);

    let res = client.invoke("system.ping", json!({})).await.unwrap();
    assert_eq!(res.status, "ok");
    assert_eq!(res.data.unwrap()["pong"], true);

    client.close();
    server.await.unwrap();
}

#[tokio::test]
async fn connect_to_closed_port_fails() {
    // 连接到一个必然拒绝的端口，应返回离线错误而非 panic。
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener); // 立即关闭，确保端口无监听。

    let client = Client::new(ClientOptions {
        url: format!("ws://{addr}"),
        key: "secret".to_string(),
        client_id: "control-1".to_string(),
        handshake_timeout_ms: 1_000,
        ..Default::default()
    });

    let err = client.connect().await.unwrap_err();
    assert_eq!(err.code, nodeagent_client::ErrorCodes::NODE_OFFLINE);
}
