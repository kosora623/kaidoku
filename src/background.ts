import {
  classifyBatchConstructsWithCloud,
  DEFAULT_CLOUD_MODEL,
} from './ai/cloud';
import { probePromptApi, resetNanoBaseSession } from './ai/nano';
import { analyzeSentence, getAiEnvironmentStatus } from './ai/router';
import { AnalysisValidationError } from './ai/schema';
import {
  clearAllPageMarkCaches,
  deletePageMarkCache,
  getValidPageMarkCache,
  getWeakConstructCounts,
  recordConstructFeedback,
  savePageMarkCache,
} from './db';
import {
  calculateDifficultyAndMarkLevel,
  computeRuleFallbackMark,
  selectAndBatchCandidates,
} from './lang/en/difficulty';
import { hashCandidateList } from './lang/en/sentence-splitter';
import { loadSettings } from './settings';
import type {
  AiProviderPreference,
  Analysis,
  CachedSentenceMark,
  ConstructId,
  MarkedSentencePayload,
  NanoPromptMode,
} from './types';

export interface PageSentenceInput {
  id: string;
  sentenceHash: string;
  text: string;
  viewportOrder: number;
}

export interface MarkPageResponseData {
  marks: MarkedSentencePayload[];
  fromCache: boolean;
  provider: 'cloud' | 'rule';
  modelName: string;
  batchCallCount: number;
  candidateCount: number;
  markedCount: number;
  notice?: string;
}

/** background.ts が受け取るメッセージ型 */
export type BackgroundRequest =
  | { type: 'PROBE_PROMPT_API'; runPromptCheck?: boolean }
  | { type: 'GET_AI_STATUS' }
  | { type: 'RESET_NANO_SESSION' }
  | { type: 'CLEAR_PAGE_CACHE'; url?: string }
  | { type: 'RUN_MARK_ON_TAB'; tabId: number }
  | {
      type: 'ANALYZE_SENTENCE';
      sentence: string;
      preferredProvider?: AiProviderPreference;
      nanoPromptMode?: NanoPromptMode;
      allowNanoDownload?: boolean;
    }
  | {
      type: 'MARK_PAGE_SENTENCES';
      pageUrl: string;
      pageTitle: string;
      sentences: PageSentenceInput[];
      forceRefresh?: boolean;
    }
  | {
      type: 'RECORD_CONSTRUCT_FEEDBACK';
      text: string;
      pageUrl: string;
      pageTitle: string;
      constructs: ConstructId[];
      result: 'understood' | 'unsure';
      analysis?: Analysis;
    };

/** 指定タブへ content.js を動的注入し、難文マーク処理を起動する */
async function injectAndRunMarking(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  await chrome.tabs.sendMessage(tabId, { type: 'KAIDOKU_RUN_MARK' });
}

/** ツールバーの拡張機能アイコン押下時の処理（初回未同意なら同意画面、同意済みなら難文マーク注入） */
chrome.action?.onClicked.addListener((tab) => {
  void (async () => {
    const settings = await loadSettings();
    const tabUrl = tab.url ?? '';
    const isWebPage = /^https?:\/\//i.test(tabUrl);

    if (!settings.cloudConsent.granted) {
      const consentUrl =
        isWebPage && typeof tab.id === 'number'
          ? chrome.runtime.getURL(`consent.html?tabId=${tab.id}`)
          : chrome.runtime.getURL('consent.html');
      await chrome.tabs.create({ url: consentUrl });
      return;
    }

    if (isWebPage && typeof tab.id === 'number') {
      try {
        await injectAndRunMarking(tab.id);
        return;
      } catch (err) {
        console.error('χ読: content.js 注入に失敗しました:', err);
      }
    }

    // Web ページ以外（chrome:// 等）で押された場合はデバッグ画面を開く
    await chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
  })();
});

/** ページ内英文候補のバッチ難文判定（URL キャッシュ＋最大3回分割クラウド呼び出し） */
async function handleMarkPageSentences(
  req: Extract<BackgroundRequest, { type: 'MARK_PAGE_SENTENCES' }>,
): Promise<MarkPageResponseData> {
  const settings = await loadSettings();
  if (!settings.cloudConsent.granted) {
    throw new Error(
      '外部データ送信への同意が未完了です。同意画面（consent.html）から同意してください。',
    );
  }

  const weakCounts = await getWeakConstructCounts();
  const batches = selectAndBatchCandidates(req.sentences);
  const selectedCandidates = batches.flat();
  const contentHash = hashCandidateList(selectedCandidates.map((c) => c.text));

  if (selectedCandidates.length === 0) {
    return {
      marks: [],
      fromCache: false,
      provider: settings.geminiApiKey ? 'cloud' : 'rule',
      modelName: settings.geminiApiKey ? DEFAULT_CLOUD_MODEL : 'rule-only',
      batchCallCount: 0,
      candidateCount: 0,
      markedCount: 0,
      notice: '8 語以上の英文候補が見つかりませんでした。',
    };
  }

  // 1. URL キャッシュ照会（強制再判定でなければキャッシュを優先使用）
  if (req.forceRefresh) {
    await deletePageMarkCache(req.pageUrl);
  } else {
    const cached = await getValidPageMarkCache(req.pageUrl, contentHash);
    if (cached) {
      const byHash = new Map<string, CachedSentenceMark>();
      for (const m of cached.marks) {
        byHash.set(m.sentenceHash, m);
      }

      const payloads: MarkedSentencePayload[] = [];
      for (const cand of selectedCandidates) {
        const hit = byHash.get(cand.sentenceHash);
        if (!hit) continue;
        // 最新の苦手構文カウントを使ってマークの濃さを再計算する（API 再呼び出し不要）
        const computed = calculateDifficultyAndMarkLevel(
          cand.text,
          hit.constructs,
          weakCounts,
          { overrideLongSubject: hit.constructs.includes('long_subject') },
        );
        if (computed.markLevel > 0) {
          payloads.push({
            id: cand.id,
            sentenceHash: cand.sentenceHash,
            text: cand.text,
            constructs: computed.constructs,
            difficulty: computed.difficulty,
            markLevel: computed.markLevel,
            weakConstructsHit: computed.weakConstructsHit,
          });
        }
      }

      return {
        marks: payloads,
        fromCache: true,
        provider: cached.provider,
        modelName: cached.modelName,
        batchCallCount: 0,
        candidateCount: selectedCandidates.length,
        markedCount: payloads.length,
        ...(cached.provider === 'rule'
          ? {
              notice:
                'API キー未設定のためルールベースの簡易マークで表示中です（設定画面で API キーを登録すると高精度な AI 判定になります）。',
            }
          : {}),
      };
    }
  }

  // 2. キャッシュなし：API キーがあれば最大 3 回のクラウドバッチ呼び出し、なければルールベース暫定判定
  const apiKey = settings.geminiApiKey;
  const cachedMarks: CachedSentenceMark[] = [];
  const payloads: MarkedSentencePayload[] = [];
  let provider: 'cloud' | 'rule' = 'rule';
  let modelName = 'rule-only';
  let batchCallCount = 0;

  if (apiKey) {
    provider = 'cloud';
    modelName = DEFAULT_CLOUD_MODEL;

    for (const batch of batches) {
      const batchInput = batch.map((cand, idx) => ({
        id: idx,
        text: cand.text,
      }));
      const classified = await classifyBatchConstructsWithCloud(
        batchInput,
        apiKey,
      );
      batchCallCount += 1;

      for (let idx = 0; idx < batch.length; idx++) {
        const cand = batch[idx];
        const aiConstructs = classified.constructsById.get(idx) ?? [];
        const computed = calculateDifficultyAndMarkLevel(
          cand.text,
          aiConstructs,
          weakCounts,
        );

        cachedMarks.push({
          sentenceHash: cand.sentenceHash,
          text: cand.text,
          constructs: computed.constructs,
          difficulty: computed.difficulty,
        });

        if (computed.markLevel > 0) {
          payloads.push({
            id: cand.id,
            sentenceHash: cand.sentenceHash,
            text: cand.text,
            constructs: computed.constructs,
            difficulty: computed.difficulty,
            markLevel: computed.markLevel,
            weakConstructsHit: computed.weakConstructsHit,
          });
        }
      }
    }
  } else {
    for (const cand of selectedCandidates) {
      const fallback = computeRuleFallbackMark(cand.text);
      cachedMarks.push({
        sentenceHash: cand.sentenceHash,
        text: cand.text,
        constructs: fallback.constructs,
        difficulty: fallback.difficulty,
      });
      if (fallback.markLevel > 0) {
        payloads.push({
          id: cand.id,
          sentenceHash: cand.sentenceHash,
          text: cand.text,
          constructs: fallback.constructs,
          difficulty: fallback.difficulty,
          markLevel: fallback.markLevel,
          weakConstructsHit: [],
        });
      }
    }
  }

  // 3. URL ごとにキャッシュを保存
  await savePageMarkCache({
    rawUrl: req.pageUrl,
    pageTitle: req.pageTitle,
    contentHash,
    provider,
    modelName,
    batchCallCount,
    marks: cachedMarks,
  });

  return {
    marks: payloads,
    fromCache: false,
    provider,
    modelName,
    batchCallCount,
    candidateCount: selectedCandidates.length,
    markedCount: payloads.length,
    ...(provider === 'rule'
      ? {
          notice:
            'API キー未設定のためルールベースの簡易マークで表示中です（設定画面で API キーを登録すると高精度な AI 判定になります）。',
        }
      : {}),
  };
}

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

    if (message.type === 'CLEAR_PAGE_CACHE') {
      const work = message.url
        ? deletePageMarkCache(message.url)
        : clearAllPageMarkCaches();
      void work
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'RUN_MARK_ON_TAB') {
      void injectAndRunMarking(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'MARK_PAGE_SENTENCES') {
      void handleMarkPageSentences(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'RECORD_CONSTRUCT_FEEDBACK') {
      void recordConstructFeedback({
        text: message.text,
        pageUrl: message.pageUrl,
        pageTitle: message.pageTitle,
        constructs: message.constructs,
        result: message.result,
        analysis: message.analysis,
      })
        .then(() => getWeakConstructCounts())
        .then((weakCounts) => sendResponse({ ok: true, data: { weakCounts } }))
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
