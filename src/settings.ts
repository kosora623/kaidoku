import type { CloudConsentState, MarkDensity, NanoPromptMode } from './types';

/**
 * 拡張機能の設定（Gemini API キー、外部送信同意状態、Nano プロンプト方式、マーク量など）を
 * chrome.storage.local で管理する。
 */

export const CLOUD_CONSENT_VERSION = '2026-11-20';

export interface KaidokuSettings {
  /** クラウドの Gemini API を使うための API キー */
  geminiApiKey: string;
  /** Gemini Nano のプロンプト方式（既定: 'one-stage'） */
  nanoPromptMode: NanoPromptMode;
  /** ページ内の難文マーク量（low: 10% / normal: 20% / high: 40%、既定: 'normal'） */
  markDensity: MarkDensity;
  /** 外部データ送信（Google Gemini API）に対する初回同意状態 */
  cloudConsent: CloudConsentState;
  /** 開発者モード（所要時間内訳表示・debug.html / eval.html リンク表示、既定: false） */
  developerMode: boolean;
}

const STORAGE_KEY_API_KEY = 'kaidoku_gemini_api_key';
const STORAGE_KEY_NANO_PROMPT_MODE = 'kaidoku_nano_prompt_mode';
const STORAGE_KEY_MARK_DENSITY = 'kaidoku_mark_density';
const STORAGE_KEY_CLOUD_CONSENT = 'kaidoku_cloud_consent';
const STORAGE_KEY_DEVELOPER_MODE = 'kaidoku_developer_mode';

const DEFAULT_CONSENT: CloudConsentState = {
  granted: false,
  version: CLOUD_CONSENT_VERSION,
  grantedAt: null,
};

/** 保存済みの設定を読み込む */
export async function loadSettings(): Promise<KaidokuSettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return {
      geminiApiKey: '',
      nanoPromptMode: 'one-stage',
      markDensity: 'normal',
      cloudConsent: { ...DEFAULT_CONSENT },
      developerMode: false,
    };
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API_KEY,
    STORAGE_KEY_NANO_PROMPT_MODE,
    STORAGE_KEY_MARK_DENSITY,
    STORAGE_KEY_CLOUD_CONSENT,
    STORAGE_KEY_DEVELOPER_MODE,
  ]);
  const rawKey = stored[STORAGE_KEY_API_KEY];
  const rawMode = stored[STORAGE_KEY_NANO_PROMPT_MODE];
  const rawDensity = stored[STORAGE_KEY_MARK_DENSITY];
  const rawConsent = stored[STORAGE_KEY_CLOUD_CONSENT] as
    | Partial<CloudConsentState>
    | undefined;
  const rawDevMode = stored[STORAGE_KEY_DEVELOPER_MODE];

  const markDensity: MarkDensity =
    rawDensity === 'low' || rawDensity === 'high' ? rawDensity : 'normal';

  const consent: CloudConsentState =
    rawConsent &&
    typeof rawConsent === 'object' &&
    rawConsent.granted === true &&
    rawConsent.version === CLOUD_CONSENT_VERSION
      ? {
          granted: true,
          version: CLOUD_CONSENT_VERSION,
          grantedAt:
            typeof rawConsent.grantedAt === 'string'
              ? rawConsent.grantedAt
              : null,
        }
      : { ...DEFAULT_CONSENT };

  return {
    geminiApiKey: typeof rawKey === 'string' ? rawKey.trim() : '',
    nanoPromptMode: rawMode === 'two-stage' ? 'two-stage' : 'one-stage',
    markDensity,
    cloudConsent: consent,
    developerMode: rawDevMode === true,
  };
}

/** 開発者モードの ON / OFF を保存する */
export async function saveDeveloperMode(enabled: boolean): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEY_DEVELOPER_MODE]: Boolean(enabled),
  });
}

/** ページ内の難文マーク量（少なめ / ふつう / 多め）を保存する */
export async function saveMarkDensity(density: MarkDensity): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEY_MARK_DENSITY]: density,
  });
}

/** Gemini API キーを保存する */
export async function saveGeminiApiKey(apiKey: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local が利用できない環境です。');
  }
  await chrome.storage.local.set({
    [STORAGE_KEY_API_KEY]: apiKey.trim(),
  });
}

/** Gemini Nano のプロンプト方式を保存する */
export async function saveNanoPromptMode(mode: NanoPromptMode): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local が利用できない環境です。');
  }
  await chrome.storage.local.set({
    [STORAGE_KEY_NANO_PROMPT_MODE]: mode,
  });
}

/** 外部（Google Gemini API）データ送信への同意を保存する */
export async function grantCloudConsent(): Promise<CloudConsentState> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local が利用できない環境です。');
  }
  const state: CloudConsentState = {
    granted: true,
    version: CLOUD_CONSENT_VERSION,
    grantedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({
    [STORAGE_KEY_CLOUD_CONSENT]: state,
  });
  return state;
}

/** 外部データ送信への同意を撤回する */
export async function revokeCloudConsent(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEY_CLOUD_CONSENT);
}

/** Gemini API キーを削除する */
export async function clearGeminiApiKey(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEY_API_KEY);
}
