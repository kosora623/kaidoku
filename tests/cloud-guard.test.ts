import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCloudConsentForCloudCall,
  shouldUseCachedPageMarks,
} from '../src/cloud-guard';
import { CLOUD_CONSENT_VERSION, loadSettings } from '../src/settings';
import type { PageMarkCache } from '../src/types';

function createMockCache(provider: 'cloud' | 'rule'): PageMarkCache {
  return {
    url: 'https://example.com/article',
    pageTitle: 'Example',
    contentHash: 'abc123',
    provider,
    modelName: provider === 'cloud' ? 'gemini-3.1-flash-lite' : 'rule-only',
    batchCallCount: provider === 'cloud' ? 1 : 0,
    marks: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    expiresAt: '2026-11-27T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('cloud-guard.ts & settings.ts（同意ガード・バージョン再同意・ルールキャッシュ昇格・開発者モード）', () => {
  it('未同意または撤回済みの状態でクラウド送信しようとするとエラーで阻止する', () => {
    const unconsented = {
      cloudConsent: {
        granted: false,
        version: CLOUD_CONSENT_VERSION,
        grantedAt: null,
      },
    };
    expect(() => assertCloudConsentForCloudCall(unconsented, true)).toThrow(
      /同意/,
    );
    // クラウドを使わない処理（Nano フォールバック等）は通過する
    expect(() =>
      assertCloudConsentForCloudCall(unconsented, false),
    ).not.toThrow();

    const consented = {
      cloudConsent: {
        granted: true,
        version: CLOUD_CONSENT_VERSION,
        grantedAt: '2026-11-20T00:00:00.000Z',
      },
    };
    expect(() => assertCloudConsentForCloudCall(consented, true)).not.toThrow();
  });

  it('API キー登録後に古いルール簡易キャッシュ（provider: rule）を自動破棄してクラウド判定へ昇格させる', () => {
    const ruleCache = createMockCache('rule');
    const cloudCache = createMockCache('cloud');

    expect(shouldUseCachedPageMarks(null, true)).toBe(false);
    expect(shouldUseCachedPageMarks(ruleCache, false)).toBe(true);
    expect(shouldUseCachedPageMarks(ruleCache, true)).toBe(false);
    expect(shouldUseCachedPageMarks(cloudCache, true)).toBe(true);
    expect(shouldUseCachedPageMarks(cloudCache, false)).toBe(true);
  });

  it('旧バージョンの同意記録（2026-11-19）は未同意扱いとなり再同意を要求する・開発者モードは既定 OFF', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kaidoku_gemini_api_key: 'test-key',
            kaidoku_cloud_consent: {
              granted: true,
              version: '2026-11-19',
              grantedAt: '2026-11-19T00:00:00.000Z',
            },
          }),
        },
      },
    };

    const settings = await loadSettings();
    expect(CLOUD_CONSENT_VERSION).toBe('2026-11-20');
    expect(settings.cloudConsent.granted).toBe(false);
    expect(settings.developerMode).toBe(false);
    expect(() => assertCloudConsentForCloudCall(settings, true)).toThrow(/同意/);
  });

  it('最新バージョン（2026-11-20）の同意と開発者モード ON を正しく読み込む', async () => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kaidoku_cloud_consent: {
              granted: true,
              version: CLOUD_CONSENT_VERSION,
              grantedAt: '2026-11-20T09:00:00.000Z',
            },
            kaidoku_developer_mode: true,
          }),
        },
      },
    };

    const settings = await loadSettings();
    expect(settings.cloudConsent.granted).toBe(true);
    expect(settings.developerMode).toBe(true);
  });
});
