import {
  classifyBatchConstructsWithCloud,
  DEFAULT_CLOUD_MODEL,
} from './ai/cloud';
import { probePromptApi, resetNanoBaseSession } from './ai/nano';
import { analyzeSentence, getAiEnvironmentStatus } from './ai/router';
import { AnalysisValidationError } from './ai/schema';
import {
  translateSentence,
  type AcronymGlossaryEntry,
} from './ai/translate';
import { lookupWordMeaning } from './ai/word-meaning';
import {
  assertCloudConsentForCloudCall,
  CLOUD_CONSENT_REQUIRED_ERROR,
  shouldUseCachedPageMarks,
} from './cloud-guard';
import {
  clearAllPageMarkCaches,
  deletePageMarkCache,
  getValidPageMarkCache,
  getWeakConstructCounts,
  recordConstructFeedback,
  savePageMarkCache,
  saveWordEntry,
} from './db';
import {
  applyRelativePageMarks,
  calculateDifficultyAndMarkLevel,
  computeRuleFallbackMark,
  selectAndBatchCandidates,
} from './lang/en/difficulty';
import { hashCandidateList } from './lang/en/sentence-splitter';
import { loadSettings, saveMarkDensity } from './settings';
import type {
  AiProviderPreference,
  Analysis,
  CachedSentenceMark,
  ConstructId,
  MarkDensity,
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
  /** 全判定済み候補（markLevel 0 の文も含め、密度切替時に API 再呼び出しなしで再計算する） */
  marks: MarkedSentencePayload[];
  fromCache: boolean;
  provider: 'cloud' | 'rule';
  modelName: string;
  batchCallCount: number;
  /** ページ全体から抽出された総文数（全 N 文中 M 文の N） */
  totalSentenceCount: number;
  candidateCount: number;
  markedCount: number;
  markDensity: MarkDensity;
  developerMode: boolean;
  notice?: string;
}

/** background.ts が受け取るメッセージ型 */
export type BackgroundRequest =
  | { type: 'PROBE_PROMPT_API'; runPromptCheck?: boolean }
  | { type: 'GET_AI_STATUS' }
  | { type: 'RESET_NANO_SESSION' }
  | { type: 'CLEAR_PAGE_CACHE'; url?: string }
  | { type: 'RUN_MARK_ON_TAB'; tabId: number }
  | { type: 'SET_MARK_DENSITY'; density: MarkDensity }
  | {
      type: 'ANALYZE_SENTENCE';
      sentence: string;
      requestId?: string;
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
    }
  | {
      type: 'LOOKUP_WORD_MEANING';
      word: string;
      sentence: string;
      isAcronym?: boolean;
      acronymDefinition?: string | null;
      allowAcronymGuess?: boolean;
    }
  | {
      type: 'TRANSLATE_SENTENCE';
      sentence: string;
      acronymDefinitions?: AcronymGlossaryEntry[];
      unresolvedAcronyms?: string[];
    }
  | {
      type: 'SAVE_WORD_ENTRY';
      word: string;
      meaning: string;
      text: string;
      pageUrl: string;
      pageTitle: string;
      analysis?: Analysis;
    }
  | {
      type: 'OPEN_REVIEW_PAGE';
    }
  | {
      type: 'OPEN_OPTIONS_PAGE';
    }
  | {
      type: 'OPEN_CONSENT_PAGE';
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

    // Web ページ以外（chrome:// 等）で押された場合は復習画面（開発者モード ON 時はデバッグ画面）を開く
    const fallbackPage = settings.developerMode ? 'debug.html' : 'review.html';
    await chrome.tabs.create({ url: chrome.runtime.getURL(fallbackPage) });
  })();
});

/** ページ内英文候補のバッチ難文判定（URL キャッシュ＋最大3回分割クラウド呼び出し） */
async function handleMarkPageSentences(
  req: Extract<BackgroundRequest, { type: 'MARK_PAGE_SENTENCES' }>,
): Promise<MarkPageResponseData> {
  const settings = await loadSettings();
  if (!settings.cloudConsent.granted) {
    throw new Error(CLOUD_CONSENT_REQUIRED_ERROR);
  }

  const weakCounts = await getWeakConstructCounts();
  const batches = selectAndBatchCandidates(req.sentences);
  const selectedCandidates = batches.flat();
  const contentHash = hashCandidateList(selectedCandidates.map((c) => c.text));
  const totalSentenceCount = req.sentences.length;
  const markDensity = settings.markDensity;
  const developerMode = settings.developerMode;

  if (selectedCandidates.length === 0) {
    return {
      marks: [],
      fromCache: false,
      provider: settings.geminiApiKey ? 'cloud' : 'rule',
      modelName: settings.geminiApiKey ? DEFAULT_CLOUD_MODEL : 'rule-only',
      batchCallCount: 0,
      totalSentenceCount,
      candidateCount: 0,
      markedCount: 0,
      markDensity,
      developerMode,
      notice: '8 語以上の英文候補が見つかりませんでした。',
    };
  }

  /** ページ全体の相対順位から markLevel を確定するヘルパー */
  const applyRanking = (
    items: Array<MarkedSentencePayload & { viewportOrder: number }>,
  ): { payloads: MarkedSentencePayload[]; markedCount: number } => {
    const levelMap = applyRelativePageMarks(items, {
      totalPageSentences: totalSentenceCount,
      density: markDensity,
    });
    let markedCount = 0;
    const payloads: MarkedSentencePayload[] = items.map((item) => {
      const level = levelMap.get(item.id) ?? 0;
      if (level > 0) markedCount += 1;
      return {
        id: item.id,
        sentenceHash: item.sentenceHash,
        text: item.text,
        constructs: item.constructs,
        difficulty: item.difficulty,
        hardnessScore: item.hardnessScore,
        markLevel: level,
        weakConstructsHit: item.weakConstructsHit,
      };
    });
    return { payloads, markedCount };
  };

  // 1. URL キャッシュ照会（強制再判定でなければキャッシュを優先使用。ただしルール簡易キャッシュは API キー登録後に自動昇格する）
  if (req.forceRefresh) {
    await deletePageMarkCache(req.pageUrl);
  } else {
    const cached = await getValidPageMarkCache(req.pageUrl, contentHash);
    if (shouldUseCachedPageMarks(cached, Boolean(settings.geminiApiKey))) {
      const byHash = new Map<string, CachedSentenceMark>();
      for (const m of cached.marks) {
        byHash.set(m.sentenceHash, m);
      }

      const rawItems: Array<MarkedSentencePayload & { viewportOrder: number }> = [];
      for (const cand of selectedCandidates) {
        const hit = byHash.get(cand.sentenceHash);
        if (!hit) continue;
        // 最新の苦手構文カウントと現在のマーク密度でスコアと順位を再計算する（API 再呼び出し不要）
        const computed = calculateDifficultyAndMarkLevel(
          cand.text,
          hit.constructs,
          weakCounts,
          { overrideLongSubject: hit.constructs.includes('long_subject') },
        );
        rawItems.push({
          id: cand.id,
          sentenceHash: cand.sentenceHash,
          text: cand.text,
          constructs: computed.constructs,
          difficulty: computed.difficulty,
          hardnessScore: computed.hardnessScore,
          markLevel: 0,
          weakConstructsHit: computed.weakConstructsHit,
          viewportOrder: cand.viewportOrder,
        });
      }

      const { payloads, markedCount } = applyRanking(rawItems);

      return {
        marks: payloads,
        fromCache: true,
        provider: cached.provider,
        modelName: cached.modelName,
        batchCallCount: 0,
        totalSentenceCount,
        candidateCount: selectedCandidates.length,
        markedCount,
        markDensity,
        developerMode,
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
  const rawItems: Array<MarkedSentencePayload & { viewportOrder: number }> = [];
  let provider: 'cloud' | 'rule' = 'rule';
  let modelName = 'rule-only';
  let batchCallCount = 0;

  if (apiKey) {
    provider = 'cloud';
    modelName = DEFAULT_CLOUD_MODEL;

    for (const batch of batches) {
      // クラウド送信直前に最新の同意状態を再確認する
      const latestSettings = await loadSettings();
      assertCloudConsentForCloudCall(latestSettings, true);

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

        rawItems.push({
          id: cand.id,
          sentenceHash: cand.sentenceHash,
          text: cand.text,
          constructs: computed.constructs,
          difficulty: computed.difficulty,
          hardnessScore: computed.hardnessScore,
          markLevel: 0,
          weakConstructsHit: computed.weakConstructsHit,
          viewportOrder: cand.viewportOrder,
        });
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
      rawItems.push({
        id: cand.id,
        sentenceHash: cand.sentenceHash,
        text: cand.text,
        constructs: fallback.constructs,
        difficulty: fallback.difficulty,
        hardnessScore: fallback.hardnessScore,
        markLevel: 0,
        weakConstructsHit: [],
        viewportOrder: cand.viewportOrder,
      });
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

  const { payloads, markedCount } = applyRanking(rawItems);

  return {
    marks: payloads,
    fromCache: false,
    provider,
    modelName,
    batchCallCount,
    totalSentenceCount,
    candidateCount: selectedCandidates.length,
    markedCount,
    markDensity,
    developerMode,
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
  (message: BackgroundRequest, sender, sendResponse) => {
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
        .then(async (saved) => {
          const weakCounts = await getWeakConstructCounts();
          sendResponse({
            ok: true,
            data: {
              weakCounts,
              createdCardCount: saved.createdCardCount,
              updatedCardCount: saved.updatedCardCount,
            },
          });
        })
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'LOOKUP_WORD_MEANING') {
      void (async () => {
        const settings = await loadSettings();
        const skipsAi = Boolean(
          message.isAcronym &&
            !message.acronymDefinition &&
            !message.allowAcronymGuess,
        );
        const willUseCloud = !skipsAi && Boolean(settings.geminiApiKey);
        assertCloudConsentForCloudCall(settings, willUseCloud);

        return lookupWordMeaning(message.word, message.sentence, {
          isAcronym: message.isAcronym,
          acronymDefinition: message.acronymDefinition,
          allowAcronymGuess: message.allowAcronymGuess,
        });
      })()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'TRANSLATE_SENTENCE') {
      void (async () => {
        const settings = await loadSettings();
        assertCloudConsentForCloudCall(settings, Boolean(settings.geminiApiKey));

        return translateSentence(message.sentence, {
          acronymDefinitions: message.acronymDefinitions,
          unresolvedAcronyms: message.unresolvedAcronyms,
        });
      })()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'SAVE_WORD_ENTRY') {
      void saveWordEntry({
        word: message.word,
        meaning: message.meaning,
        text: message.text,
        pageUrl: message.pageUrl,
        pageTitle: message.pageTitle,
        analysis: message.analysis,
      })
        .then((saved) =>
          sendResponse({
            ok: true,
            data: {
              wordId: saved.wordEntry.id,
              cardId: saved.reviewCard.id,
              created: saved.created,
            },
          }),
        )
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'OPEN_REVIEW_PAGE') {
      void chrome.tabs
        .create({ url: chrome.runtime.getURL('review.html') })
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'OPEN_OPTIONS_PAGE') {
      void chrome.tabs
        .create({ url: chrome.runtime.getURL('options.html') })
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'OPEN_CONSENT_PAGE') {
      const tabId = sender?.tab?.id;
      const consentUrl =
        typeof tabId === 'number'
          ? chrome.runtime.getURL(`consent.html?tabId=${tabId}`)
          : chrome.runtime.getURL('consent.html');
      void chrome.tabs
        .create({ url: consentUrl })
        .then(() => sendResponse({ ok: true }))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (message.type === 'SET_MARK_DENSITY') {
      void saveMarkDensity(message.density)
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
      const tabId = sender?.tab?.id;
      void (async () => {
        const settings = await loadSettings();
        const willUseCloud =
          message.preferredProvider === 'cloud' ||
          (message.preferredProvider !== 'nano' && Boolean(settings.geminiApiKey));
        assertCloudConsentForCloudCall(settings, willUseCloud);

        const result = await analyzeSentence(message.sentence, {
          preferredProvider: message.preferredProvider,
          nanoPromptMode: message.nanoPromptMode,
          allowNanoDownload: message.allowNanoDownload,
          onStage1Complete:
            typeof tabId === 'number'
              ? (progress) => {
                  void chrome.tabs
                    .sendMessage(tabId, {
                      type: 'KAIDOKU_ANALYSIS_STAGE1',
                      requestId: message.requestId,
                      sentence: message.sentence,
                      clauses: progress.clauses,
                      stage1Ms: progress.stage1Ms,
                      waitMs: progress.waitMs,
                    })
                    .catch(() => {
                      // タブが閉じられた場合等は無視
                    });
                }
              : undefined,
        });
        return { result, developerMode: settings.developerMode };
      })()
        .then(({ result, developerMode }) =>
          sendResponse({ ok: true, data: result, developerMode }),
        )
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
