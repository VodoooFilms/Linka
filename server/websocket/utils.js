export const WS_OPEN_STATE = 1;
export const WS_MAX_MSG_PER_SEC = 200;

export function normalizeNumber(value, fallback = 0, min = -500, max = 500) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function isLocalhostAddress(remoteAddress) {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

export function createRateLimiter() {
  return {
    messageTimestamps: [],
    rateLimited: false,
  };
}

export function shouldRateLimit(rateLimiter, now = Date.now()) {
  const windowStart = now - 1000;
  rateLimiter.messageTimestamps = rateLimiter.messageTimestamps.filter((t) => t > windowStart);

  if (rateLimiter.messageTimestamps.length >= WS_MAX_MSG_PER_SEC) {
    rateLimiter.rateLimited = true;
    return true;
  }

  rateLimiter.rateLimited = false;
  rateLimiter.messageTimestamps.push(now);
  return false;
}
