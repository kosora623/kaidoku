import { probePromptApi, resetNanoBaseSession } from './ai/nano';
import { analyzeSentence, getAiEnvironmentStatus } from './ai/router';
import { AnalysisValidationError } from './ai/schema';
import type { AiProviderPreference } from './types';

/** background.ts が受け取るメッセージ型 */
export type BackgroundRequest =
  | { type: 'PROBE_PROMPT_API'; runPromptCheck?: boolean }
  | { type: 'GET_AI_STATUS' }
  | { type: 'RESET_NANO_SESSION' }
  | {
      type: 'ANALYZE_SENTENCE';
      sentence: string;
      preferredProvider?: AiProviderPreference;
      nanoPromptMode?: 'one-stage' | 'two-stage';
      allowNanoDownload?: boolean;
    };

/** ツールバーの拡張機能アイコン押下時にデバッグ画面を開く（第1段階の動作確認用） */
chrome.action?.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
});

/** 拡張内ページ・Content Script からのメッセージを取り次ぐ */
chrome.runtime?.onMessage.addListener(
  (message: BackgroundRequest, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'PROBE_PROMPT_API') {
      void probePromptApi('service_worker', Boolean(message.runPromptCheck))
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'GET_AI_STATUS') {
      void getAiEnvironmentStatus()
        .then((status) => sendResponse({ ok: true, data: status }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'RESET_NANO_SESSION') {
      void resetNanoBaseSession()
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'ANALYZE_SENTENCE') {
      void analyzeSentence(message.sentence, {
        preferredProvider: message.preferredProvider,
        nanoPromptMode: message.nanoPromptMode,
        allowNanoDownload: message.allowNanoDownload,
      })
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => {
          const payload: Record<string, unknown> = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
          if (err instanceof AnalysisValidationError) {
            payload.errorCode = err.code;
            payload.rawOutput = err.rawOutput;
            payload.rawText = err.rawText;
            payload.attempts = err.attempts;
            payload.firstAttemptError = err.firstAttemptError;
            payload.timing = err.timing;
          }
          sendResponse(payload);
        });
      return true;
    }

    return false;
  },
);
