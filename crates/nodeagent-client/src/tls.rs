//! TLS 配置：自签证书 + 证书指纹钉住（对齐 client.ts 的 TLS 处理，v21）。
//!
//! nodeagent 的安全模型：TLS 只负责**传输加密**，身份认证由应用层
//! HMAC / ed25519 握手兜底。因此 `insecure` 跳过的是「证书链是否由可信 CA
//! 签发」，TLS 层的签名仍真正验签（委托 rustls）。

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error, SignatureScheme};

use crate::crypto::cert_fingerprint;
use crate::error::{ClientError, ErrorCodes};

/// 构建 rustls `ClientConfig`。
///
/// - `insecure = false`：webpki 严格链验证（自签证书会被拒，与 Node `rejectUnauthorized=true` 一致）。
/// - `insecure = true`：接受任意证书，但抓取对端证书 DER 的 sha256 指纹。
/// - `expect_fp`：钉住的指纹（64 位小写 hex）；给了就严格比对，不一致拒绝（`E_CERT_MISMATCH`）。
/// - `captured`：回填本次握手实际抓到的指纹（对齐 `getPeerCertFingerprint`）。
pub fn build_client_config(
    insecure: bool,
    expect_fp: Option<String>,
    captured: Arc<Mutex<Option<String>>>,
) -> Result<ClientConfig, ClientError> {
    let expect_fp = expect_fp.map(|s| s.trim().to_ascii_lowercase());

    if !insecure {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        return Ok(ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth());
    }

    let supported = default_supported_algorithms()?;
    let verifier = Arc::new(InsecureVerifier {
        expect_fp,
        captured,
        supported,
    });

    Ok(ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

fn default_supported_algorithms() -> Result<WebPkiSupportedAlgorithms, ClientError> {
    let provider = CryptoProvider::get_default()
        .ok_or_else(|| ClientError::new(ErrorCodes::CERT_MISMATCH, "无默认 CryptoProvider"))?;
    Ok(provider.signature_verification_algorithms)
}

/// 接受任意证书、但抓指纹的验证器。
/// `verify_server_cert` 跳过链校验（只做指纹钉住），签名仍由 rustls 真正验签。
#[derive(Debug)]
struct InsecureVerifier {
    expect_fp: Option<String>,
    captured: Arc<Mutex<Option<String>>>,
    supported: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for InsecureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let fp = cert_fingerprint(end_entity.as_ref());

        // 回填实际指纹（TOFU 钉住）。
        if let Ok(mut guard) = self.captured.lock() {
            *guard = Some(fp.clone());
        }

        // 钉住比对：不一致 → 拒绝（对齐 client.ts 的 E_CERT_MISMATCH）。
        if let Some(expected) = &self.expect_fp {
            if expected != &fp {
                let expect_head = &expected[..expected.len().min(16)];
                let actual_head = &fp[..fp.len().min(16)];
                return Err(Error::General(format!(
                    "证书指纹不匹配，拒绝连接：期望 {expect_head}… 实际 {actual_head}…（被控端可能重装、或中间人冒充）"
                )));
            }
        }

        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}
