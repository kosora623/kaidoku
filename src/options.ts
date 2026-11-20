import {
  exportKaidokuData,
  importKaidokuData,
  inspectImportConflicts,
  parseKaidokuExportJson,
  type KaidokuExportData,
} from './db';
import {
  clearGeminiApiKey,
  loadSettings,
  revokeCloudConsent,
  saveDeveloperMode,
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
const devModeToggle = document.getElementById(
  'developer-mode-toggle',
) as HTMLInputElement;
const devModeStatusEl = document.getElementById(
  'dev-mode-status',
) as HTMLDivElement;
const devOnlyLinks = Array.from(
  document.querySelectorAll<HTMLElement>('.dev-only-link'),
);
const exportJsonBtn = document.getElementById(
  'export-json-btn',
) as HTMLButtonElement;
const importJsonBtn = document.getElementById(
  'import-json-btn',
) as HTMLButtonElement;
const importJsonInput = document.getElementById(
  'import-json-input',
) as HTMLInputElement;
const importConfirmBox = document.getElementById(
  'import-confirm-box',
) as HTMLDivElement;
const importConfirmText = document.getElementById(
  'import-confirm-text',
) as HTMLParagraphElement;
const importOverwriteBtn = document.getElementById(
  'import-overwrite-btn',
) as HTMLButtonElement;
const importSkipBtn = document.getElementById(
  'import-skip-btn',
) as HTMLButtonElement;
const importCancelBtn = document.getElementById(
  'import-cancel-btn',
) as HTMLButtonElement;
const backupStatusEl = document.getElementById(
  'backup-status',
) as HTMLDivElement;

let pendingImportPayload: KaidokuExportData | null = null;

function syncDeveloperModeLinks(enabled: boolean): void {
  for (const el of devOnlyLinks) {
    el.classList.toggle('hidden', !enabled);
  }
}

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
  devModeToggle.checked = settings.developerMode;
  syncDeveloperModeLinks(settings.developerMode);

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

devModeToggle.addEventListener('change', async () => {
  const enabled = devModeToggle.checked;
  try {
    await saveDeveloperMode(enabled);
    syncDeveloperModeLinks(enabled);
    showStatus(
      devModeStatusEl,
      enabled
        ? '開発者モードを ON にしました（計測表示・debug.html / eval.html リンクを表示します）。'
        : '開発者モードを OFF にしました。',
      'ok',
    );
  } catch (err) {
    showStatus(
      devModeStatusEl,
      `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

function clearPendingImport(): void {
  pendingImportPayload = null;
  importConfirmBox.classList.add('hidden');
  importConfirmText.textContent = '';
  importJsonInput.value = '';
}

async function executeImport(
  payload: KaidokuExportData,
  overwriteExisting: boolean,
): Promise<void> {
  importOverwriteBtn.disabled = true;
  importSkipBtn.disabled = true;
  try {
    const res = await importKaidokuData(payload, { overwriteExisting });
    await refreshSettings();
    const totalWords = res.added.words + res.overwritten.words;
    const totalConstructs = res.added.constructs + res.overwritten.constructs;
    const totalSentences = res.added.sentences + res.overwritten.sentences;
    const totalCards = res.added.reviewCards + res.overwritten.reviewCards;
    const skippedNote =
      res.totalSkipped > 0 ? `（既存 ID ${res.totalSkipped} 件をスキップ）` : '';
    const overwrittenCount =
      res.overwritten.sentences +
      res.overwritten.words +
      res.overwritten.constructs +
      res.overwritten.reviewCards;
    const overwrittenNote =
      overwrittenCount > 0 ? `（うち上書き ${overwrittenCount} 件）` : '';

    clearPendingImport();
    showStatus(
      backupStatusEl,
      `インポートが完了しました：文 ${totalSentences} 件 / 単語 ${totalWords} 件 / 構文 ${totalConstructs} 件 / 復習カード ${totalCards} 件${overwrittenNote}${skippedNote}、設定を反映しました（API キーは変更していません）。`,
      'ok',
    );
  } catch (err) {
    showStatus(
      backupStatusEl,
      `インポートに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  } finally {
    importOverwriteBtn.disabled = false;
    importSkipBtn.disabled = false;
  }
}

exportJsonBtn.addEventListener('click', async () => {
  exportJsonBtn.disabled = true;
  try {
    const payload = await exportKaidokuData();
    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const datePart = payload.exportedAt.slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kaidoku-backup-${datePart}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showStatus(
      backupStatusEl,
      `JSON をエクスポートしました（文 ${payload.data.sentences.length} 件 / 単語 ${payload.data.words.length} 件 / 構文 ${payload.data.constructs.length} 件 / 復習カード ${payload.data.reviewCards.length} 件・API キーは除外）。`,
      'ok',
    );
  } catch (err) {
    showStatus(
      backupStatusEl,
      `エクスポートに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  } finally {
    exportJsonBtn.disabled = false;
  }
});

importJsonBtn.addEventListener('click', () => {
  clearPendingImport();
  importJsonInput.click();
});

importJsonInput.addEventListener('change', async () => {
  const file = importJsonInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = parseKaidokuExportJson(text);
    const report = await inspectImportConflicts(payload);

    if (report.totalConflicts > 0) {
      pendingImportPayload = payload;
      importConfirmText.textContent = `読み込みファイル内に、現在保存されているデータと同じ ID が ${report.totalConflicts} 件あります（文: ${report.conflicts.sentences} 件 / 単語: ${report.conflicts.words} 件 / 構文: ${report.conflicts.constructs} 件 / 復習カード: ${report.conflicts.reviewCards} 件）。同じ ID のデータを上書きしますか？`;
      importConfirmBox.classList.remove('hidden');
      showStatus(
        backupStatusEl,
        '重複 ID が見つかりました。上のボタンから取り込み方法を選択してください。',
        'ok',
      );
      return;
    }

    await executeImport(payload, false);
  } catch (err) {
    clearPendingImport();
    showStatus(
      backupStatusEl,
      `ファイルの読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );
  }
});

importOverwriteBtn.addEventListener('click', () => {
  if (!pendingImportPayload) return;
  void executeImport(pendingImportPayload, true);
});

importSkipBtn.addEventListener('click', () => {
  if (!pendingImportPayload) return;
  void executeImport(pendingImportPayload, false);
});

importCancelBtn.addEventListener('click', () => {
  clearPendingImport();
  showStatus(backupStatusEl, 'インポートをキャンセルしました。', 'ok');
});

void refreshSettings();
