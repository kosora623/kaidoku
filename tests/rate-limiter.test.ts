import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireCloudRateLimitSlot,
  configureCloudRateLimiter,
  getRecentCloudRequestCount,
  resetCloudRateLimiter,
} from '../src/ai/rate-limiter';

afterEach(() => {
  resetCloudRateLimiter();
});

describe('rate-limiter.ts（1分あたり15回以内の共有レート制御）', () => {
  it('15 回目までは待ち時間 0 ms で通過し、16 回目で最古の呼び出しから 60 秒経過するまで待機する', async () => {
    let fakeNow = 100_000;
    const sleeps: number[] = [];

    configureCloudRateLimiter({
      maxRequests: 15,
      windowMs: 60_000,
      nowFn: () => fakeNow,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    });

    for (let i = 0; i < 15; i++) {
      const waited = await acquireCloudRateLimitSlot();
      expect(waited).toBe(0);
      fakeNow += 1000; // 1秒おきに15回呼ぶ（計15秒経過）
    }
    expect(getRecentCloudRequestCount()).toBe(15);

    // 16 回目：最古（100_000）から 15 秒しか経っていないので残り約 45 秒待機する
    const waited16 = await acquireCloudRateLimitSlot();
    expect(waited16).toBeGreaterThanOrEqual(45_000);
    expect(sleeps).toHaveLength(1);
    expect(getRecentCloudRequestCount()).toBe(15);
  });
});
