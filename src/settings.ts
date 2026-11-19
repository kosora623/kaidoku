import type { NanoPromptMode } from './types';

/**
 * 拡張機能の設定（Gemini API キーや Nano プロンプト方式など）を
 * chrome.storage.local で管理する。
 */

export interface KaidokuSettings {
  /** クラウドの Gemini API を使うための API キー */
  geminiApiKey: string;
  /** Gemini Nano のプロンプト方式（既定: 'one-stage'） */
  nanoPromptMode: NanoPromptMode;
}

const STORAGE_KEY_API_KEY = 'kaidoku_gemini_api_key';
const STORAGE_KEY_NANO_PROMPT_MODE = 'kaidoku_nano_prompt_mode';

/** 保存済みの設定を読み込む */
export async function loadSettings(): Promise<KaidokuSettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { geminiApiKey: '', nanoPromptMode: 'one-stage' };
  }
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_API_KEY,
    STORAGE_KEY_NANO_PROMPT_MODE,
  ]);
  const rawKey = stored[STORAGE_KEY_API_KEY];
  const rawMode = stored[STORAGE_KEY_NANO_PROMPT_MODE];
  return {
    geminiApiKey: typeof rawKey === 'string' ? rawKey.trim() : '',
    nanoPromptMode: rawMode === 'two-stage' ? 'two-stage' : 'one-stage',
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

/** Gemini API キーを削除する */
export async function clearGeminiApiKey(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.remove(STORAGE_KEY_API_KEY);
}
