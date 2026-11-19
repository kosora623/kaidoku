import {
  clearGeminiApiKey,
  loadSettings,
  saveGeminiApiKey,
  saveNanoPromptMode,
} from './settings';
import type { NanoPromptMode } from './types';

const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com/*';

const form = document.getElementById('api-key-form') as HTMLFormElement;
const input = document.getElementById('api-key-input') as HTMLInputElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
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

async function init(): Promise<void> {
  const settings = await loadSettings();
  input.value = settings.geminiApiKey;
  modeSelect.value = settings.nanoPromptMode;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = input.value.trim();
  if (!key) {
    showStatus(statusEl, 'API キーを入力してください。', 'err');
    return;
  }

  try {
    // クラウド利用時のみ generativelanguage.googleapis.com へのアクセス権限を要求する
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

modeSelect.addEventListener('change', async () => {
  const mode: NanoPromptMode =
    modeSelect.value === 'two-stage' ? 'two-stage' : 'one-stage';
  try {
    await saveNanoPromptMode(mode);
    showStatus(
      modeStatusEl,
      mode === 'two-stage'
        ? 'Gemini Nano プロンプト方式を「2段階（実験）」に保存しました。'
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

void init();
