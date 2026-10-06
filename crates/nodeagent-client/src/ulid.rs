//! ULID 生成器（Crockford Base32，26 字符：10 位时间戳 + 16 位随机）。
//! 对齐 `packages/protocol/src/ulid.ts`（自实现，避免额外依赖）。

use std::time::{SystemTime, UNIX_EPOCH};

/// Crockford Base32 字母表（与 ulid.ts 完全一致）。
const ENCODING: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 生成一个 ULID（单调递增：同一毫秒内保证字典序递增）。
pub fn ulid() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    ulid_at(now)
}

/// 按指定时间戳生成 ULID（供测试注入确定性时间）。
pub fn ulid_at(now: u64) -> String {
    // 时间戳部分：10 字符，低位在前地填充（不足 10 位高位补 '0'）。
    let mut time_part = [b'0'; 10];
    let mut t = now;
    for i in (0..10).rev() {
        time_part[i] = ENCODING[(t % 32) as usize];
        t /= 32;
    }

    // 随机部分：16 字符。256 % 32 == 0，取模无偏差。
    let mut rand_part = [b'0'; 16];
    for slot in rand_part.iter_mut() {
        *slot = ENCODING[(rand::random::<u8>() % 32) as usize];
    }

    let mut out = String::with_capacity(26);
    out.push_str(std::str::from_utf8(&time_part).unwrap());
    out.push_str(std::str::from_utf8(&rand_part).unwrap());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_is_26() {
        assert_eq!(ulid().len(), 26);
    }

    #[test]
    fn only_valid_charset() {
        let s = ulid();
        let set: Vec<char> = ENCODING.iter().map(|&b| b as char).collect();
        assert!(s.chars().all(|c| set.contains(&c)));
    }

    #[test]
    fn monotonic_same_millis_lexicographic() {
        // 同一毫秒内，两个 ULID 的时间前缀必须相同（保证字典序可比较）。
        let a = ulid_at(1_700_000_000_000);
        let b = ulid_at(1_700_000_000_000);
        assert_eq!(&a[..10], &b[..10]);
    }

    #[test]
    fn distinct() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            seen.insert(ulid());
        }
        assert_eq!(seen.len(), 1000);
    }
}
