/**
 * ULID 生成器（Crockford Base32，26 字符：10 位时间戳 + 16 位随机）。
 * 自实现以避免运行时依赖。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRand: number[] = [];

/** 生成一个 ULID（单调递增：同一毫秒内保证字典序递增）。 */
export function ulid(now: number = Date.now()): string {
  let timePart = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timePart = ENCODING[t % 32]! + timePart;
    t = Math.floor(t / 32);
  }

  // 随机部分：同毫秒内递增，保证唯一且有序
  if (now === lastTime) {
    for (let i = 15; i >= 0; i--) {
      if (lastRand[i]! < 31) {
        lastRand[i]! += 1;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastTime = now;
    lastRand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }

  return timePart + lastRand.map((n) => ENCODING[n]!).join('');
}
