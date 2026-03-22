'use strict';

// Test the socket rate limiter logic in isolation

function createSocketRateLimiter(maxEvents, windowMs) {
  const buckets = new Map();
  return {
    check(socketId) {
      const now = Date.now();
      let timestamps = buckets.get(socketId);
      if (!timestamps) { timestamps = []; buckets.set(socketId, timestamps); }
      while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
      if (timestamps.length >= maxEvents) return false;
      timestamps.push(now);
      return true;
    },
    cleanup(socketId) { buckets.delete(socketId); },
  };
}

describe('createSocketRateLimiter', () => {
  test('allows events up to the limit', () => {
    const limiter = createSocketRateLimiter(3, 10000);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(true);
  });

  test('blocks events beyond the limit', () => {
    const limiter = createSocketRateLimiter(2, 10000);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(false);
    expect(limiter.check('s1')).toBe(false);
  });

  test('different sockets are tracked independently', () => {
    const limiter = createSocketRateLimiter(1, 10000);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(false);
    expect(limiter.check('s2')).toBe(true);
    expect(limiter.check('s2')).toBe(false);
  });

  test('cleanup removes socket tracking', () => {
    const limiter = createSocketRateLimiter(1, 10000);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(false);
    limiter.cleanup('s1');
    expect(limiter.check('s1')).toBe(true);
  });

  test('events are allowed again after window expires', () => {
    const limiter = createSocketRateLimiter(1, 50); // 50ms window
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(false);
    return new Promise(resolve => {
      setTimeout(() => {
        expect(limiter.check('s1')).toBe(true);
        resolve();
      }, 60);
    });
  });

  test('mixed traffic across multiple sockets', () => {
    const limiter = createSocketRateLimiter(3, 10000);
    // Fill s1
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(true);
    expect(limiter.check('s1')).toBe(false);
    // s2 unaffected
    expect(limiter.check('s2')).toBe(true);
    expect(limiter.check('s2')).toBe(true);
  });
});
