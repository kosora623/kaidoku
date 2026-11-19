import type { CloudConsentState, NanoPromptMode } from './types';

/**
 * 拡張機能の設定（Gemini API キー、外部送信同意状態、Nano プロンプト方式など）を
 * chrome.storage.local で管理する。
 */

export const CLOUD_CONSENT_VERSION = '2026-11-19';

export interface KaidokuSettings {
  /** クラウドの Gemini API を使うための API キー */
  geminiApiKey: string;
  /** Gemini Nano のプロンプト方式（既定: 'one-stage'） */
  nanoPromptMode: NanoPromptMode;
  /** 外部データ送信（Google Gemini API）に対する初回同意状態 */
  cloudConsent: CloudConsentState;
}

const STORAGE_KEY_API_KEY = 'kaidoku_gemini_api_key';
const STORAGE_KEY_NANO_PROMPT_MODE = 'kaidoku_nano_prompt_mode';
const STORAGE_KEY_CLOUD_CONSENT = 'kaidoku_cloud_consent';

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
      cloudConsent: { ...DEFAULT_CONSENT },
    };
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API_KEY,
    STORAGE_KEY_NANO_PROMPT_MODE,
    STORAGE_KEY_CLOUD_CONSENT,
  ]);
  const rawKey = stored[STORAGE_KEY_API_KEY];
  const rawMode = stored[STORAGE_KEY_NANO_PROMPT_MODE];
  const rawConsent = stored[STORAGE_KEY_CLOUD_CONSENT] as
    | Partial<CloudConsentState>
    | undefined;

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
    cloudConsent: consent,
  };
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
