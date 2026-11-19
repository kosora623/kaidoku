/**
 * クラウド Gemini API の全呼び出し（難文マークバッチ・構造解析・単語の意味取得）を
 * 合算して 1 分あたり 15 回以内に制御する共有スライディングウィンドウ・レートリミッタ。
 */

export const MAX_CLOUD_REQUESTS_PER_MINUTE = 15;
export const CLOUD_RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  nowFn: () => number;
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** AbortSignal に対応した sleep */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('処理が中断されました。', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('処理が中断されました。', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let config: RateLimiterConfig = {
  maxRequests: MAX_CLOUD_REQUESTS_PER_MINUTE,
  windowMs: CLOUD_RATE_LIMIT_WINDOW_MS,
  nowFn: () => Date.now(),
  sleepFn: sleepWithAbort,
};

/** 過去 windowMs 以内に実行されたクラウド API 呼び出し時刻（ms） */
let requestTimestamps: number[] = [];

/** 同時呼び出し時にスロット確保を直列化するためのロックチェーン */
let queueTail: Promise<void> = Promise.resolve();

/** テスト用：レートリミッタの履歴をリセットする */
export function resetCloudRateLimiter(): void {
  requestTimestamps = [];
  queueTail = Promise.resolve();
  config = {
    maxRequests: MAX_CLOUD_REQUESTS_PER_MINUTE,
    windowMs: CLOUD_RATE_LIMIT_WINDOW_MS,
    nowFn: () => Date.now(),
    sleepFn: sleepWithAbort,
  };
}

/** テスト用：上限・ウィンドウ長・時刻関数を差し替える */
export function configureCloudRateLimiter(
  overrides: Partial<RateLimiterConfig>,
): void {
  config = { ...config, ...overrides };
}

/** 直近 1 分間の記録済みクラウド API 呼び出し回数を返す */
export function getRecentCloudRequestCount(): number {
  const cutoff = config.nowFn() - config.windowMs;
  requestTimestamps = requestTimestamps.filter((ts) => ts > cutoff);
  return requestTimestamps.length;
}

/**
 * 1 回分のクラウド Gemini API 呼び出しスロットを確保する。
 * 直近 60 秒間に 15 回に達している場合は、最古の呼び出しがウィンドウ外へ出るまで待機する。
 * 戻り値は実際に待機した時間（ミリ秒）。
 */
export function acquireCloudRateLimitSlot(
  signal?: AbortSignal,
): Promise<number> {
  const run = async (): Promise<number> => {
    let totalWaitedMs = 0;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException('処理が中断されました。', 'AbortError');
      }

      const now = config.nowFn();
      const cutoff = now - config.windowMs;
      requestTimestamps = requestTimestamps.filter((ts) => ts > cutoff);

      if (requestTimestamps.length < config.maxRequests) {
        requestTimestamps.push(now);
        return Math.round(totalWaitedMs);
      }

      const oldest = requestTimestamps[0];
      const waitMs = Math.max(50, oldest + config.windowMs - now + 20);
      await config.sleepFn(waitMs, signal);
      totalWaitedMs += waitMs;
    }
  };

  const resultPromise = queueTail.then(run, run);
  // 後続の待機者が前のエラーに巻き込まれないよう尾端は常に resolved に保つ
  queueTail = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}

/** HTTP 429 / 503 のエラーメッセージからリトライ待機時間（ms）を算出する */
export function extractTransientRetryWaitMs(
  status: number,
  detailMessage: string,
): number {
  const match = detailMessage.match(/retry in\s+([0-9.]+)s/i);
  if (match) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(60_000, Math.ceil((sec + 0.5) * 1000));
    }
  }
  return status === 503 ? 4000 : 8000;
}
