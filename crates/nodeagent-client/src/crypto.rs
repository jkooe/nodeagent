//! 密码学工具：HMAC / ed25519 签名 / 证书指纹 / nonce。
//! 逐一对齐 `packages/protocol/src/{hmac,ed25519}.ts` 与 `net.ts`。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// 计算 HMAC-SHA256，返回 Base64（对齐 hmac.ts 的 `computeHmac`）。
/// 密钥为预共享密钥字符串，nonce 以 UTF-8 编码。
pub fn compute_hmac(key: &str, nonce: &str) -> String {
    // HMAC 接受任意长度 key，此处不可能失败，unwrap 仅为类型收敛。
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC 接受任意长度 key");
    mac.update(nonce.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

/// 生成随机 nonce（32 字节，Base64），对齐 `generateNonce`。
pub fn generate_nonce() -> String {
    let mut bytes = [0u8; 32];
    for b in bytes.iter_mut() {
        *b = rand::random::<u8>();
    }
    STANDARD.encode(bytes)
}

/// 证书指纹：sha256(DER) 的十六进制小写 64 位（对齐 net.ts 的 `certFingerprint`）。
pub fn cert_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 对 nonce 原文做 ed25519 签名，返回 Base64（对齐 ed25519.ts 的 `signNonce`）。
/// 私钥为 Base64(PKCS8 DER)。
pub fn sign_nonce(private_key_b64: &str, nonce: &str) -> Result<String, String> {
    use ed25519_dalek::pkcs8::DecodePrivateKey;
    use ed25519_dalek::Signer;

    let der = STANDARD
        .decode(private_key_b64)
        .map_err(|e| format!("私钥 Base64 解码失败: {e}"))?;
    let signing_key = ed25519_dalek::SigningKey::from_pkcs8_der(&der)
        .map_err(|e| format!("PKCS8 私钥解析失败: {e}"))?;
    let sig = signing_key.sign(nonce.as_bytes());
    Ok(STANDARD.encode(sig.to_bytes()))
}

/// 验签（对齐 `verifyNonce`）；任何异常均视为失败（不抛出）。
pub fn verify_nonce(public_key_b64: &str, nonce: &str, signature_b64: &str) -> bool {
    use ed25519_dalek::pkcs8::DecodePublicKey;
    use ed25519_dalek::Verifier;

    let Ok(pk_der) = STANDARD.decode(public_key_b64) else {
        return false;
    };
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_public_key_der(&pk_der) else {
        return false;
    };
    let Ok(sig_bytes) = STANDARD.decode(signature_b64) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig_bytes) else {
        return false;
    };
    vk.verify(nonce.as_bytes(), &sig).is_ok()
}

/// 公钥指纹（SHA-256 前 16 位 hex），对齐 `keyId`。
pub fn key_id(public_key_b64: &str) -> String {
    let der = STANDARD.decode(public_key_b64).unwrap_or_default();
    let digest = Sha256::digest(&der);
    // 前 16 个 hex 字符 = 前 8 字节。
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};

    fn gen_keypair() -> (String, String) {
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::generate(&mut rand::rng());
        let pk = sk.verifying_key();
        (
            STANDARD.encode(pk.to_public_key_der().expect("编码公钥")),
            STANDARD.encode(sk.to_pkcs8_der().expect("编码私钥")),
        )
    }

    #[test]
    fn hmac_matches_known_vector() {
        // 与 Node 版对拍的固定向量：HMAC-SHA256("key", "nonce")。
        let out = compute_hmac("secret", "hello");
        // 用独立的 hmac 重算并比对，避免自证。
        let mut mac = HmacSha256::new_from_slice(b"secret").unwrap();
        mac.update(b"hello");
        let expect = STANDARD.encode(mac.finalize().into_bytes());
        assert_eq!(out, expect);
        // Base64(HMAC-SHA256("secret","hello")) 的已知值（由 RFC 测试向量推得，供跨端核对）。
        assert_eq!(out, "iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs=");
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let (pk, sk) = gen_keypair();
        let nonce = generate_nonce();
        let sig = sign_nonce(&sk, &nonce).unwrap();
        assert!(verify_nonce(&pk, &nonce, &sig));
        assert!(!verify_nonce(&pk, "tampered", &sig));
    }

    #[test]
    fn key_id_is_16_hex() {
        let (pk, _sk) = gen_keypair();
        let id = key_id(&pk);
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cert_fingerprint_sha256_der() {
        // 空 DER 的 sha256 是已知常量。
        assert_eq!(
            cert_fingerprint(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
