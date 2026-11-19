import {
  grantCloudConsent,
  loadSettings,
  saveGeminiApiKey,
} from './settings';

const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com/*';

const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const consentCheckbox = document.getElementById(
  'consent-checkbox',
) as HTMLInputElement;
const agreeBtn = document.getElementById('agree-btn') as HTMLButtonElement;
const declineBtn = document.getElementById('decline-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

function showStatus(message: string, kind: 'ok' | 'err'): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  if (settings.geminiApiKey) {
    apiKeyInput.value = settings.geminiApiKey;
  }
}

consentCheckbox.addEventListener('change', () => {
  agreeBtn.disabled = !consentCheckbox.checked;
});

agreeBtn.addEventListener('click', async () => {
  if (!consentCheckbox.checked) return;

  agreeBtn.disabled = true;
  try {
    const key = apiKeyInput.value.trim();
    if (key) {
      if (chrome.permissions?.request) {
        const granted = await chrome.permissions.request({
          origins: [GEMINI_API_ORIGIN],
        });
        if (!granted) {
          showStatus(
            'Gemini API へのアクセス権限が許可されませんでした。権限を許可してから再度お試しください。',
            'err',
          );
          agreeBtn.disabled = false;
          return;
        }
      }
      await saveGeminiApiKey(key);
    }

    await grantCloudConsent();
    showStatus('同意を保存しました。元のタブへ戻ります...', 'ok');

    // 元のタブIDが渡されていれば、そのタブをアクティブにして難文マークを実行する
    const params = new URLSearchParams(window.location.search);
    const tabIdRaw = params.get('tabId');
    const tabId = tabIdRaw ? Number(tabIdRaw) : NaN;

    if (Number.isInteger(tabId) && chrome.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({
        type: 'RUN_MARK_ON_TAB',
        tabId,
      });
      if (chrome.tabs?.update) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      }
      window.close();
      return;
    }

    showStatus(
      '同意と設定を保存しました。英語の記事や論文ページで拡張アイコンを押してお使いください。',
      'ok',
    );
  } catch (err) {
    showStatus(
      `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
    agreeBtn.disabled = false;
  }
});

declineBtn.addEventListener('click', () => {
  window.close();
});

void init();
