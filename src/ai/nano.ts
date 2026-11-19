import type {
  AnalyzeResult,
  MainVerbWordSpan,
  NanoPromptMode,
  PromptApiProbeResult,
  RetryErrorRecord,
} from '../types';
import {
  buildAnalysisInitialPrompts,
  buildAnalysisUserPrompt,
  buildMainVerbInitialPrompts,
  buildMainVerbUserPrompt,
  buildRetryFeedbackPrompt,
} from './prompt';
import type {
  LanguageModelAvailability,
  LanguageModelAvailabilityOptions,
  LanguageModelMessage,
  LanguageModelMonitor,
  LanguageModelSession,
} from './prompt-api';
import {
  AnalysisValidationError,
  MAIN_VERB_JSON_SCHEMA,
  WORD_ANALYSIS_JSON_SCHEMA,
} from './schema';
import {
  convertWordAnalysisToCharAnalysisWithRepairs,
  tokenizeWords,
  type ConvertedWordAnalysisResult,
  type WordToken,
} from './tokenizer';

/**
 * Prompt API に渡す入出力言語オプション。
 * availability() と create() で同一オプションを指定する（developer.chrome.com の推奨仕様）。
 * ※ 第1段階は JSON 構造出力のみのため expectedOutputs は en とする。
 *   後の段階で日本語訳や単語の意味を出すときに ja を追加予定。
 */
export const NANO_MODEL_OPTIONS: LanguageModelAvailabilityOptions = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

interface SessionCacheSlot {
  promise: Promise<LanguageModelSession> | null;
  buildInitialPrompts: () => LanguageModelMessage[];
}

/** 構造解析用の土台セッションキャッシュ */
const structureSessionSlot: SessionCacheSlot = {
  promise: null,
  buildInitialPrompts: buildAnalysisInitialPrompts,
};

/** 2段階プロンプト 1 段目（主節動詞抽出）用の土台セッションキャッシュ */
const mainVerbSessionSlot: SessionCacheSlot = {
  promise: null,
  buildInitialPrompts: buildMainVerbInitialPrompts,
};

/** 現在の実行コンテキストで Prompt API (LanguageModel) が利用可能か判定する */
export async function getNanoAvailability(): Promise<LanguageModelAvailability> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    return 'unavailable';
  }
  try {
    return await globalThis.LanguageModel.availability(NANO_MODEL_OPTIONS);
  } catch {
    return 'unavailable';
  }
}

interface BaseSessionAcquisition {
  session: LanguageModelSession;
  created: boolean;
  createMs: number;
}

/** 指定スロットの土台セッションを作成または再利用して取得し、作成にかかった時間も返す */
async function getOrCreateBaseSession(
  slot: SessionCacheSlot,
  monitor?: (m: LanguageModelMonitor) => void,
): Promise<BaseSessionAcquisition> {
  if (typeof globalThis.LanguageModel === 'undefined') {
    throw new Error(
      'この実行環境では Prompt API（LanguageModel）が利用できません。',
    );
  }

  if (slot.promise) {
    const session = await slot.promise;
    return { session, created: false, createMs: 0 };
  }

  const lm = globalThis.LanguageModel;
  const startedAt = performance.now();
  slot.promise = (async () => {
    let topK = 1;
    if (typeof lm.params === 'function') {
      try {
        const params = await lm.params();
        if (typeof params?.maxTopK === 'number' && params.maxTopK >= 1) {
          topK = Math.min(1, params.maxTopK);
        }
      } catch {
        // params() が使えない場合は既定の topK=1 を使用する
      }
    }

    return lm.create({
      ...NANO_MODEL_OPTIONS,
      temperature: 0,
      topK,
      initialPrompts: slot.buildInitialPrompts(),
      ...(monitor ? { monitor } : {}),
    });
  })().catch((err) => {
    // 作成に失敗した場合はキャッシュを破棄して次回再試行できるようにする
    slot.promise = null;
    throw err;
  });

  const session = await slot.promise;
  const createMs = Math.round(performance.now() - startedAt);
  return { session, created: true, createMs };
}

async function resetSlot(slot: SessionCacheSlot): Promise<void> {
  const existing = slot.promise;
  slot.promise = null;
  if (!existing) return;
  try {
    const session = await existing;
    session.destroy();
  } catch {
    // すでに破棄・失敗している場合は無視する
  }
}

/** キャッシュしているすべての土台セッションを破棄する（テストや評価開始時のリセット用） */
export async function resetNanoBaseSession(): Promise<void> {
  await Promise.all([
    resetSlot(structureSessionSlot),
    resetSlot(mainVerbSessionSlot),
  ]);
}

interface ClonedSessionResult {
  clonedSession: LanguageModelSession;
  sessionCreated: boolean;
  sessionCreateMs: number;
}

/** 指定スロットの土台セッションから clone() で解析用セッションを複製する（失効時は1回だけ再作成） */
async function cloneSessionFromSlot(
  slot: SessionCacheSlot,
  monitor?: (m: LanguageModelMonitor) => void,
): Promise<ClonedSessionResult> {
  const first = await getOrCreateBaseSession(slot, monitor);
  try {
    const clonedSession = await first.session.clone();
    return {
      clonedSession,
      sessionCreated: first.created,
      sessionCreateMs: first.createMs,
    };
  } catch {
    // ブラウザ側のメモリ解放等で土台セッションが無効化されていた場合は作り直す
    await resetSlot(slot);
    const recreated = await getOrCreateBaseSession(slot, monitor);
    const clonedSession = await recreated.session.clone();
    return {
      clonedSession,
      sessionCreated: true,
      sessionCreateMs: first.createMs + recreated.createMs,
    };
  }
}

/** 2段階プロンプトの 1 段目出力（mainVerbs）を検証して単語スパン配列へ変換する */
function parseMainVerbOutput(
  sentence: string,
  rawText: string,
  tokens: WordToken[],
): MainVerbWordSpan[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const err = new AnalysisValidationError(
      'INVALID_JSON',
      '2段階プロンプト 1 段目（主節動詞抽出）の出力を JSON として解釈できませんでした。',
      rawText,
    );
    err.rawText = rawText;
    throw err;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Record<string, unknown>).mainVerbs)
  ) {
    const err = new AnalysisValidationError(
      'MISSING_MAIN_VERB',
      '2段階プロンプト 1 段目で mainVerbs 配列が得られませんでした。',
      parsed,
    );
    err.rawText = rawText;
    throw err;
  }

  const rawVerbs = (parsed as { mainVerbs: unknown[] }).mainVerbs;
  const result: MainVerbWordSpan[] = [];
  for (const item of rawVerbs) {
    if (!item || typeof item !== 'object') continue;
    const sw = (item as Record<string, unknown>).startWord;
    const ew = (item as Record<string, unknown>).endWord;
    if (
      typeof sw === 'number' &&
      typeof ew === 'number' &&
      Number.isInteger(sw) &&
      Number.isInteger(ew) &&
      sw >= 0 &&
      ew >= sw &&
      ew < tokens.length
    ) {
      result.push({
        startWord: sw,
        endWord: ew,
        text: sentence.slice(tokens[sw].start, tokens[ew].end),
      });
    }
  }

  if (result.length === 0) {
    const err = new AnalysisValidationError(
      'MISSING_MAIN_VERB',
      '2段階プロンプト 1 段目で有効な主節動詞の単語番号が得られませんでした。',
      parsed,
    );
    err.rawText = rawText;
    throw err;
  }

  return result;
}

/** 生テキストを JSON パースし、単語番号→文字位置変換・自動修復＋文法整合チェックを実行する */
function parseAndValidateWordOutput(
  sentence: string,
  rawText: string,
  tokens: WordToken[],
): ConvertedWordAnalysisResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const err = new AnalysisValidationError(
      'INVALID_JSON',
      'Gemini Nano の出力を JSON として解釈できませんでした。',
      rawText,
    );
    err.rawText = rawText;
    throw err;
  }

  try {
    return convertWordAnalysisToCharAnalysisWithRepairs(sentence, parsed, tokens);
  } catch (err) {
    if (err instanceof AnalysisValidationError) {
      err.rawText = rawText;
    }
    throw err;
  }
}

export interface AnalyzeWithNanoOptions {
  /** 'one-stage'（既定）または 'two-stage'（実験：主節 V を先に抽出） */
  nanoPromptMode?: NanoPromptMode;
  monitor?: (m: LanguageModelMonitor) => void;
  signal?: AbortSignal;
}

/**
 * Gemini Nano（Prompt API）で 1 文を構造解析し、文字位置ベースの Analysis を返す。
 * responseConstraint に JSON Schema を指定し、検証失敗時は失敗理由を添えて 1 回だけ再試行する。
 * 土台セッション作成時間と解析時間を分離して計測する。
 */
export async function analyzeWithNano(
  sentence: string,
  options?: AnalyzeWithNanoOptions,
): Promise<AnalyzeResult> {
  const trimmed = sentence.trim();
  if (!trimmed) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '解析する英文が空です。',
    );
  }

  const tokens = tokenizeWords(trimmed);
  if (tokens.length === 0) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '入力文から解析対象の単語を抽出できませんでした。',
    );
  }

  const mode: NanoPromptMode = options?.nanoPromptMode ?? 'one-stage';
  let totalSessionCreateMs = 0;
  let anySessionCreated = false;
  let stage1AnalyzeMs = 0;
  let stage1MainVerbs: MainVerbWordSpan[] | undefined;

  // 2段階プロンプトの 1 段目：主節の動詞の単語番号だけを抽出する
  if (mode === 'two-stage') {
    const stage1Slot = await cloneSessionFromSlot(
      mainVerbSessionSlot,
      options?.monitor,
    );
    totalSessionCreateMs += stage1Slot.sessionCreateMs;
    anySessionCreated = anySessionCreated || stage1Slot.sessionCreated;

    const stage1Start = performance.now();
    try {
      const stage1Raw = await stage1Slot.clonedSession.prompt(
        buildMainVerbUserPrompt(trimmed, tokens),
        {
          responseConstraint: MAIN_VERB_JSON_SCHEMA,
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
      stage1MainVerbs = parseMainVerbOutput(trimmed, stage1Raw, tokens);
    } catch (err) {
      if (err instanceof AnalysisValidationError) {
        stage1AnalyzeMs = Math.round(performance.now() - stage1Start);
        err.attempts = 1;
        err.timing = {
          sessionCreateMs: totalSessionCreateMs,
          analyzeMs: stage1AnalyzeMs,
          totalMs: totalSessionCreateMs + stage1AnalyzeMs,
        };
      }
      throw err;
    } finally {
      stage1Slot.clonedSession.destroy();
    }
    stage1AnalyzeMs = Math.round(performance.now() - stage1Start);
  }

  // 構造解析本体（1段階方式、または 2段階方式の 2 段目）
  const stage2Slot = await cloneSessionFromSlot(
    structureSessionSlot,
    options?.monitor,
  );
  totalSessionCreateMs += stage2Slot.sessionCreateMs;
  anySessionCreated = anySessionCreated || stage2Slot.sessionCreated;

  const stage2Start = performance.now();
  const promptOpts = {
    responseConstraint: WORD_ANALYSIS_JSON_SCHEMA,
    ...(options?.signal ? { signal: options.signal } : {}),
  };

  let rawText = '';
  let attempts = 1;
  let firstAttemptError: RetryErrorRecord | undefined;

  try {
    const userPrompt = buildAnalysisUserPrompt(trimmed, tokens, stage1MainVerbs);
    rawText = await stage2Slot.clonedSession.prompt(userPrompt, promptOpts);

    let converted: ConvertedWordAnalysisResult;
    try {
      converted = parseAndValidateWordOutput(trimmed, rawText, tokens);
    } catch (firstErr) {
      if (!(firstErr instanceof AnalysisValidationError)) {
        throw firstErr;
      }

      // 自動修復で直らない検証エラー時は失敗理由を添えて同じ複製セッションで 1 回だけ再試行する
      firstAttemptError = {
        code: firstErr.code,
        message: firstErr.message,
        rawText,
      };
      attempts = 2;

      const retryPrompt = buildRetryFeedbackPrompt(firstErr);
      rawText = await stage2Slot.clonedSession.prompt(retryPrompt, promptOpts);

      try {
        converted = parseAndValidateWordOutput(trimmed, rawText, tokens);
      } catch (secondErr) {
        if (secondErr instanceof AnalysisValidationError) {
          const analyzeMs =
            stage1AnalyzeMs + Math.round(performance.now() - stage2Start);
          secondErr.rawText = rawText;
          secondErr.attempts = attempts;
          secondErr.firstAttemptError = firstAttemptError;
          secondErr.timing = {
            sessionCreateMs: totalSessionCreateMs,
            analyzeMs,
            totalMs: totalSessionCreateMs + analyzeMs,
          };
        }
        throw secondErr;
      }
    }

    const analyzeMs =
      stage1AnalyzeMs + Math.round(performance.now() - stage2Start);
    const totalMs = totalSessionCreateMs + analyzeMs;

    return {
      analysis: converted.analysis,
      provider: 'nano',
      rawText,
      elapsedMs: totalMs,
      timing: {
        sessionCreateMs: totalSessionCreateMs,
        analyzeMs,
        totalMs,
      },
      sessionCreated: anySessionCreated,
      attempts,
      ...(converted.repaired.length > 0 ? { repaired: converted.repaired } : {}),
      ...(firstAttemptError ? { firstAttemptError } : {}),
      nanoPromptMode: mode,
      ...(stage1MainVerbs ? { stage1MainVerbs } : {}),
      modelName:
        mode === 'two-stage'
          ? 'Gemini Nano (2段階)'
          : 'Gemini Nano (1段階)',
    };
  } finally {
    // 複製セッションは解析ごとに必ず破棄してメモリを解放する
    stage2Slot.clonedSession.destroy();
  }
}

/**
 * 指定された実行コンテキストで Prompt API が使えるか実機検証する。
 */
export async function probePromptApi(
  context: PromptApiProbeResult['context'],
  runPromptCheck = false,
): Promise<PromptApiProbeResult> {
  const lm = globalThis.LanguageModel;
  if (typeof lm === 'undefined') {
    return {
      context,
      hasLanguageModel: false,
      availability: null,
      params: null,
      promptTestOk: false,
      error: 'LanguageModel がこのコンテキストに存在しません。',
    };
  }

  try {
    const availability = await lm.availability(NANO_MODEL_OPTIONS);
    let params: PromptApiProbeResult['params'] = null;
    if (typeof lm.params === 'function') {
      try {
        const rawParams = await lm.params();
        params = {
          defaultTopK: rawParams.defaultTopK,
          maxTopK: rawParams.maxTopK,
          defaultTemperature: rawParams.defaultTemperature,
          maxTemperature: rawParams.maxTemperature,
        };
      } catch {
        params = null;
      }
    }

    if (!runPromptCheck || availability !== 'available') {
      return {
        context,
        hasLanguageModel: true,
        availability,
        params,
        promptTestOk: false,
      };
    }

    const session = await lm.create({
      ...NANO_MODEL_OPTIONS,
      temperature: 0,
      topK: 1,
    });
    try {
      const output = await session.prompt('Return ok=true in JSON.', {
        responseConstraint: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      });
      return {
        context,
        hasLanguageModel: true,
        availability,
        params,
        promptTestOk: true,
        promptTestOutput: output,
      };
    } finally {
      session.destroy();
    }
  } catch (err) {
    return {
      context,
      hasLanguageModel: true,
      availability: null,
      params: null,
      promptTestOk: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
