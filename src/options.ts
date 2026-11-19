import {
  clearGeminiApiKey,
  loadSettings,
  revokeCloudConsent,
  saveGeminiApiKey,
  saveNanoPromptMode,
} from './settings';
import type { NanoPromptMode } from './types';

const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com/*';

const form = document.getElementById('api-key-form') as HTMLFormElement;
const input = document.getElementById('api-key-input') as HTMLInputElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const consentSummaryEl = document.getElementById(
  'consent-summary',
) as HTMLParagraphElement;
const openConsentBtn = document.getElementById(
  'open-consent-btn',
) as HTMLButtonElement;
const revokeConsentBtn = document.getElementById(
  'revoke-consent-btn',
) as HTMLButtonElement;
const clearCacheBtn = document.getElementById(
  'clear-cache-btn',
) as HTMLButtonElement;
const privacyStatusEl = document.getElementById(
  'privacy-status',
) as HTMLDivElement;

const modeSelect = document.getElementById('nano-prompt-mode') as HTMLSelectElement;
const modeStatusEl = document.getElementById('mode-status') as HTMLDivElement;

function showStatus(
  el: HTMLElement,
  message: string,
  kind: 'ok' | 'err',
): void {
  el.textContent = message;
  el.className = `status ${kind}`;
}

async function refreshSettings(): Promise<void> {
  const settings = await loadSettings();
  input.value = settings.geminiApiKey;
  modeSelect.value = settings.nanoPromptMode;

  if (settings.cloudConsent.granted) {
    const at = settings.cloudConsent.grantedAt
      ? new Date(settings.cloudConsent.grantedAt).toLocaleString('ja-JP')
      : '';
    consentSummaryEl.textContent = `外部データ送信の同意：同意済み（${at} / バージョン ${settings.cloudConsent.version}）`;
  } else {
    consentSummaryEl.textContent =
      '外部データ送信の同意：未同意（拡張アイコン押下時に同意画面が表示されます）';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = input.value.trim();
  if (!key) {
    showStatus(statusEl, 'API キーを入力してください。', 'err');
    return;
  }

  try {
    if (chrome.permissions?.request) {
      const granted = await chrome.permissions.request({
        origins: [GEMINI_API_ORIGIN],
      });
      if (!granted) {
        showStatus(
          statusEl,
          'Gemini API へのアクセス権限が許可されなかったため保存を中止しました。',
          'err',
        );
        return;
      }
    }

    await saveGeminiApiKey(key);
    showStatus(statusEl, 'API キーを保存しました。', 'ok');
  } catch (err) {
    showStatus(
      statusEl,
      `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    await clearGeminiApiKey();
    input.value = '';
    if (chrome.permissions?.remove) {
      await chrome.permissions.remove({ origins: [GEMINI_API_ORIGIN] });
    }
    showStatus(statusEl, 'API キーとクラウド通信権限を削除しました。', 'ok');
  } catch (err) {
    showStatus(
      statusEl,
      `削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

openConsentBtn.addEventListener('click', () => {
  window.location.href = 'consent.html';
});

revokeConsentBtn.addEventListener('click', async () => {
  try {
    await revokeCloudConsent();
    await refreshSettings();
    showStatus(
      privacyStatusEl,
      '外部データ送信の同意を撤回しました。次回利用時に再度同意画面が表示されます。',
      'ok',
    );
  } catch (err) {
    showStatus(
      privacyStatusEl,
      `撤回に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

clearCacheBtn.addEventListener('click', async () => {
  try {
    if (chrome.runtime?.sendMessage) {
      const res = (await chrome.runtime.sendMessage({
        type: 'CLEAR_PAGE_CACHE',
      })) as { ok?: boolean; error?: string };
      if (!res?.ok) {
        throw new Error(res?.error ?? 'キャッシュ削除に失敗しました。');
      }
    }
    showStatus(
      privacyStatusEl,
      '保存されていたページ判定キャッシュをすべて削除しました。',
      'ok',
    );
  } catch (err) {
    showStatus(
      privacyStatusEl,
      `キャッシュ削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

modeSelect.addEventListener('change', async () => {
  const mode: NanoPromptMode =
    modeSelect.value === 'two-stage' ? 'two-stage' : 'one-stage';
  try {
    await saveNanoPromptMode(mode);
    showStatus(
      modeStatusEl,
      mode === 'two-stage'
        ? 'Gemini Nano プロンプト方式を「2段階（保留・実験用）」に保存しました。'
        : 'Gemini Nano プロンプト方式を「1段階（既定）」に保存しました。',
      'ok',
    );
  } catch (err) {
    showStatus(
      modeStatusEl,
      `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

void refreshSettings();
