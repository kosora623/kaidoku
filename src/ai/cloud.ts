import { AI_CONSTRUCT_IDS, CONSTRUCT_IDS } from '../lang/en/constructs';
import type { AnalyzeResult, ConstructId, RetryErrorRecord } from '../types';
import {
  buildAnalysisInitialPrompts,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildClauseSkeletonFewShotTurns,
  buildClauseSkeletonSystemPrompt,
  buildClauseSkeletonUserPrompt,
  buildRetryFeedbackPrompt,
  type ClauseSkeletonItem,
} from './prompt';
import {
  acquireCloudRateLimitSlot,
  extractTransientRetryWaitMs,
  sleepWithAbort,
} from './rate-limiter';
import {
  AnalysisValidationError,
  CLOUD_CLAUSE_SKELETON_SCHEMA,
  CLOUD_WORD_ANALYSIS_SCHEMA,
} from './schema';
import {
  convertWordAnalysisToCharAnalysisWithRepairs,
  tokenizeWords,
  type ConvertedWordAnalysisResult,
  type WordToken,
} from './tokenizer';

/** クラウドフォールバックで使用する既定モデル（定数差し替え可能） */
export const DEFAULT_CLOUD_MODEL = 'gemini-3.1-flash-lite';

/** 2段階解析（auto モード時）を発動する単語数のしきい値 */
export const LONG_SENTENCE_TWO_STAGE_WORDS = 25;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type CloudPromptMode = 'one-stage' | 'two-stage' | 'auto';

export interface Stage1SkeletonProgress {
  clauses: ClauseSkeletonItem[];
  stage1Ms: number;
  waitMs: number;
}

export interface AnalyzeWithCloudOptions {
  model?: string;
  /** 'auto'（既定・25語以上のみ2段階） / 'one-stage' / 'two-stage'（強制2段階） */
  cloudPromptMode?: CloudPromptMode;
  /** auto モードで 2段階解析を使う最小単語数（既定 25） */
  twoStageMinWords?: number;
  /** 2段階解析の 1 段目（主節 S・V と節の区切り）が完了した直後に呼ばれる通知コールバック */
  onStage1Complete?: (progress: Stage1SkeletonProgress) => void;
  signal?: AbortSignal;
}

interface GeminiContentTurn {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface GeminiApiCallResult {
  rawText: string;
  /** 実際の API 応答待ち時間（ms、レート制限・429/503 待機を除く） */
  apiMs: number;
  /** 15 RPM 調整および 429/503 リトライで待機した合計時間（ms） */
  waitMs: number;
}

/**
 * Gemini REST API にリクエストしてレスポンステキストと所要時間内訳を返す。
 * 共有レートリミッタ（15回/分）を通し、一時的な HTTP 429 / 503 は 1 回だけ待機リトライする。
 */
async function callGeminiApi(
  endpoint: string,
  apiKey: string,
  contents: GeminiContentTurn[],
  signal?: AbortSignal,
  overrides?: {
    systemPrompt?: string;
    responseSchema?: Record<string, unknown>;
    errorLabel?: string;
  },
): Promise<GeminiApiCallResult> {
  const body = {
    systemInstruction: {
      parts: [{ text: overrides?.systemPrompt ?? buildAnalysisSystemPrompt() }],
    },
    contents,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: overrides?.responseSchema ?? CLOUD_WORD_ANALYSIS_SCHEMA,
    },
  };
  const bodyJson = JSON.stringify(body);
  const label = overrides?.errorLabel ?? 'クラウド Gemini API';

  let totalWaitMs = 0;
  let totalApiMs = 0;

  for (let transientAttempt = 0; transientAttempt < 2; transientAttempt++) {
    totalWaitMs += await acquireCloudRateLimitSlot(signal);

    const reqStart = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: bodyJson,
      signal,
    });
    const reqMs = Math.round(performance.now() - reqStart);

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errBody = (await response.json()) as GeminiGenerateContentResponse;
        if (errBody?.error?.message) {
          detail = `${response.status}: ${errBody.error.message}`;
        }
      } catch {
        // レスポンス本文が JSON でない場合はステータスのみ使用
      }

      if (
        (response.status === 429 || response.status === 503) &&
        transientAttempt === 0
      ) {
        const retryWaitMs = extractTransientRetryWaitMs(response.status, detail);
        await sleepWithAbort(retryWaitMs, signal);
        totalWaitMs += retryWaitMs;
        continue;
      }

      throw new Error(`${label} の呼び出しに失敗しました（${detail}）。`);
    }

    totalApiMs += reqMs;
    const data = (await response.json()) as GeminiGenerateContentResponse;
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!rawText) {
      throw new AnalysisValidationError(
        'INVALID_JSON',
        `${label} から空の応答が返されました。`,
        data,
      );
    }
    return { rawText, apiMs: totalApiMs, waitMs: totalWaitMs };
  }

  throw new Error(`${label} の呼び出しに失敗しました。`);
}

function parseAndValidateCloudOutput(
  sentence: string,
  rawText: string,
  tokens: ReturnType<typeof tokenizeWords>,
): ConvertedWordAnalysisResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const err = new AnalysisValidationError(
      'INVALID_JSON',
      'クラウド Gemini API の出力を JSON として解釈できませんでした。',
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

/** 2段階解析 1 段目の出力 JSON（clauses）を検証して ClauseSkeletonItem[] へ正規化する */
function parseClauseSkeletonOutput(
  sentence: string,
  rawText: string,
  tokens: WordToken[],
): ClauseSkeletonItem[] {
  const isValidWordRange = (sw: unknown, ew: unknown): boolean =>
    typeof sw === 'number' &&
    typeof ew === 'number' &&
    Number.isInteger(sw) &&
    Number.isInteger(ew) &&
    sw >= 0 &&
    ew >= sw &&
    ew < tokens.length;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }

  const rawClauses = (parsed as { clauses?: unknown })?.clauses;
  if (!Array.isArray(rawClauses)) return [];

  const result: ClauseSkeletonItem[] = [];
  for (const entry of rawClauses) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (!isValidWordRange(c.startWord, c.endWord)) continue;

    const subjects: ClauseSkeletonItem['subjects'] = [];
    if (Array.isArray(c.subjects)) {
      for (const s of c.subjects) {
        if (s && typeof s === 'object') {
          const sr = s as Record<string, unknown>;
          if (isValidWordRange(sr.startWord, sr.endWord)) {
            const sw = sr.startWord as number;
            const ew = sr.endWord as number;
            subjects.push({
              startWord: sw,
              endWord: ew,
              text: sentence.slice(tokens[sw].start, tokens[ew].end),
            });
          }
        }
      }
    }

    const mainVerbs: ClauseSkeletonItem['mainVerbs'] = [];
    if (Array.isArray(c.mainVerbs)) {
      for (const v of c.mainVerbs) {
        if (v && typeof v === 'object') {
          const vr = v as Record<string, unknown>;
          if (isValidWordRange(vr.startWord, vr.endWord)) {
            const sw = vr.startWord as number;
            const ew = vr.endWord as number;
            mainVerbs.push({
              startWord: sw,
              endWord: ew,
              text: sentence.slice(tokens[sw].start, tokens[ew].end),
            });
          }
        }
      }
    }

    if (mainVerbs.length === 0) continue;

    const item: ClauseSkeletonItem = {
      startWord: c.startWord as number,
      endWord: c.endWord as number,
      subjects,
      mainVerbs,
    };

    if (
      typeof c.coordinatorWord === 'number' &&
      Number.isInteger(c.coordinatorWord) &&
      c.coordinatorWord >= 0 &&
      c.coordinatorWord < tokens.length
    ) {
      item.coordinatorWord = c.coordinatorWord;
      item.coordinatorText = tokens[c.coordinatorWord].text;
    }

    result.push(item);
  }

  return result;
}

/**
 * クラウドの Gemini API（Flash-Lite 系）で 1 文を構造解析する。
 * 検証失敗時は失敗理由を添えて 1 回だけ再試行する。
 * 長い文（25語以上）では cloudPromptMode: 'auto' または 'two-stage' により
 * 「1段目：主節の S・V と等位節の区切り → 2段目：細部構造」の 2 段階解析を実行できる。
 */
export async function analyzeWithCloud(
  sentence: string,
  apiKey: string,
  options?: AnalyzeWithCloudOptions,
): Promise<AnalyzeResult> {
  const trimmed = sentence.trim();
  if (!trimmed) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '解析する英文が空です。',
    );
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error(
      'Gemini API キーが設定されていません。設定画面（options.html）から登録してください。',
    );
  }

  const tokens = tokenizeWords(trimmed);
  if (tokens.length === 0) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '入力文から解析対象の単語を抽出できませんでした。',
    );
  }

  const model = options?.model ?? DEFAULT_CLOUD_MODEL;
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const startedAt = performance.now();

  const promptMode: CloudPromptMode = options?.cloudPromptMode ?? 'auto';
  const minWords = options?.twoStageMinWords ?? LONG_SENTENCE_TWO_STAGE_WORDS;
  const useTwoStage =
    promptMode === 'two-stage' ||
    (promptMode === 'auto' && tokens.length >= minWords);

  let stage1Ms: number | undefined;
  let totalWaitMs = 0;
  let clauseSkeleton: ClauseSkeletonItem[] | undefined;

  if (useTwoStage) {
    const stage1Contents: GeminiContentTurn[] = [
      ...buildClauseSkeletonFewShotTurns(),
      {
        role: 'user',
        parts: [{ text: buildClauseSkeletonUserPrompt(trimmed, tokens) }],
      },
    ];
    const stage1Res = await callGeminiApi(
      endpoint,
      trimmedKey,
      stage1Contents,
      options?.signal,
      {
        systemPrompt: buildClauseSkeletonSystemPrompt(),
        responseSchema: CLOUD_CLAUSE_SKELETON_SCHEMA,
      },
    );
    stage1Ms = stage1Res.apiMs;
    totalWaitMs += stage1Res.waitMs;
    const parsedSkeleton = parseClauseSkeletonOutput(
      trimmed,
      stage1Res.rawText,
      tokens,
    );
    if (parsedSkeleton.length > 0) {
      clauseSkeleton = parsedSkeleton;
      options?.onStage1Complete?.({
        clauses: parsedSkeleton,
        stage1Ms,
        waitMs: totalWaitMs,
      });
    }
  }

  const fewShotContents: GeminiContentTurn[] = buildAnalysisInitialPrompts()
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const userTurn: GeminiContentTurn = {
    role: 'user',
    parts: [
      {
        text: buildAnalysisUserPrompt(
          trimmed,
          tokens,
          undefined,
          clauseSkeleton,
        ),
      },
    ],
  };

  let attempts = 1;
  let firstAttemptError: RetryErrorRecord | undefined;
  const stage2Res = await callGeminiApi(
    endpoint,
    trimmedKey,
    [...fewShotContents, userTurn],
    options?.signal,
  );
  let rawText = stage2Res.rawText;
  const stage2Ms = stage2Res.apiMs;
  totalWaitMs += stage2Res.waitMs;
  let retryMs = 0;

  let converted: ConvertedWordAnalysisResult;
  try {
    converted = parseAndValidateCloudOutput(trimmed, rawText, tokens);
  } catch (firstErr) {
    if (!(firstErr instanceof AnalysisValidationError)) {
      throw firstErr;
    }

    // 自動修復で直らないエラー時は失敗理由を添えて 1 回だけ再試行する
    firstAttemptError = {
      code: firstErr.code,
      message: firstErr.message,
      rawText,
    };
    attempts = 2;

    const retryTurns: GeminiContentTurn[] = [
      ...fewShotContents,
      userTurn,
      { role: 'model', parts: [{ text: rawText }] },
      { role: 'user', parts: [{ text: buildRetryFeedbackPrompt(firstErr) }] },
    ];

    const retryRes = await callGeminiApi(
      endpoint,
      trimmedKey,
      retryTurns,
      options?.signal,
    );
    rawText = retryRes.rawText;
    retryMs = retryRes.apiMs;
    totalWaitMs += retryRes.waitMs;

    try {
      converted = parseAndValidateCloudOutput(trimmed, rawText, tokens);
    } catch (secondErr) {
      if (secondErr instanceof AnalysisValidationError) {
        const analyzeMs = Math.round(performance.now() - startedAt);
        secondErr.rawText = rawText;
        secondErr.attempts = attempts;
        secondErr.firstAttemptError = firstAttemptError;
        secondErr.timing = {
          sessionCreateMs: 0,
          analyzeMs,
          totalMs: analyzeMs,
          ...(stage1Ms !== undefined ? { stage1Ms } : {}),
          stage2Ms,
          retryMs,
          waitMs: totalWaitMs,
        };
      }
      throw secondErr;
    }
  }

  const analyzeMs = Math.round(performance.now() - startedAt);

  return {
    analysis: converted.analysis,
    provider: 'cloud',
    rawText,
    elapsedMs: analyzeMs,
    timing: {
      sessionCreateMs: 0,
      analyzeMs,
      totalMs: analyzeMs,
      ...(stage1Ms !== undefined ? { stage1Ms } : {}),
      stage2Ms,
      retryMs,
      waitMs: totalWaitMs,
    },
    sessionCreated: false,
    attempts,
    ...(converted.repaired.length > 0 ? { repaired: converted.repaired } : {}),
    ...(firstAttemptError ? { firstAttemptError } : {}),
    modelName: model,
  };
}

/** バッチ難文判定（constructs のみ返させる）用のレスポンススキーマ */
export const CLOUD_BATCH_CONSTRUCTS_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          constructs: {
            type: 'ARRAY',
            items: {
              type: 'STRING',
              enum: [...AI_CONSTRUCT_IDS],
            },
          },
        },
        required: ['id', 'constructs'],
      },
    },
  },
  required: ['items'],
};

const VALID_AI_CONSTRUCT_SET = new Set<ConstructId>(CONSTRUCT_IDS);

function buildBatchConstructsSystemPrompt(): string {
  return [
    'You are an English syntax classifier for Japanese English-interpretation learning.',
    'For each numbered English sentence in the input list, detect ONLY which grammatical constructs are present from the allowed enum. Do NOT output difficulty or explanations.',
    'Return ONLY JSON matching {"items":[{"id":0,"constructs":[...]}]}. Include every input id exactly once.',
    '',
    'Allowed constructs (do NOT output long_subject — it is detected by code):',
    '- relative_clause: explicit relative clause modifying a noun (that/which/who/whose/where..., including non-restrictive ", which ...")',
    '- omitted_relative: contact/reduced relative clause where the object relative pronoun is omitted (e.g., "the data we collected", "the gains we observe")',
    '- participle_modifier: post-nominal past/present participle phrase modifying a noun (e.g., "models trained on...", "tasks requiring...")',
    '- formal_it: extraposed subject with dummy "It" ("It is/remains ... that ..." or "It is/remains ... to ...")',
    '- inversion: fronted negative/restrictive phrase causing subject-auxiliary inversion ("Only then did...", "Not only does...", "Rarely do...")',
    '- comparative: comparative structure ("higher ... than ...", "less ... than ...", "faster than ...")',
    '- apposition: appositive "that"-clause explaining an abstract noun ("the assumption that...", "the finding that...", "the hypothesis that...") — NOT a relative clause',
    '- participial_construction: adverbial participial clause separated by comma ("Given ..., S V", "Combining ..., S V")',
    '- coordination: coordinated main verbs or coordinated main clauses joined by and/but/or ("collects X and validates Y", "Not only ..., but ...")',
    '',
    'Notes:',
    '- Inline math placeholders appear as [MATH]; treat [MATH] as a noun phrase.',
    '- If a sentence has none of the 9 constructs, return an empty array [] for that id.',
  ].join('\n');
}

export interface BatchConstructInputItem {
  id: number;
  text: string;
}

export interface BatchConstructClassificationResult {
  /** 入力 id ごとに AI が検出した constructs（long_subject を除く） */
  constructsById: Map<number, ConstructId[]>;
  rawText: string;
  elapsedMs: number;
  modelName: string;
}

/**
 * 複数文（最大 80 文・約 12,000 文字）を 1 回のクラウド呼び出しでまとめて構文判定する。
 * AI には difficulty を出させず、各文の constructs のみを返させる。
 */
export async function classifyBatchConstructsWithCloud(
  items: readonly BatchConstructInputItem[],
  apiKey: string,
  options?: AnalyzeWithCloudOptions,
): Promise<BatchConstructClassificationResult> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error(
      'Gemini API キーが設定されていません。設定画面（options.html）から登録してください。',
    );
  }

  const model = options?.model ?? DEFAULT_CLOUD_MODEL;
  if (items.length === 0) {
    return {
      constructsById: new Map(),
      rawText: '{"items":[]}',
      elapsedMs: 0,
      modelName: model,
    };
  }

  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const startedAt = performance.now();

  const userText = [
    'Classify constructs for each sentence below:',
    ...items.map((item) => `[${item.id}] ${item.text}`),
  ].join('\n');

  const apiResult = await callGeminiApi(
    endpoint,
    trimmedKey,
    [{ role: 'user', parts: [{ text: userText }] }],
    options?.signal,
    {
      systemPrompt: buildBatchConstructsSystemPrompt(),
      responseSchema: CLOUD_BATCH_CONSTRUCTS_SCHEMA,
      errorLabel: 'クラウド Gemini API（バッチ構文判定）',
    },
  );
  const rawText = apiResult.rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      'クラウド Gemini API（バッチ構文判定）の出力を JSON として解釈できませんでした。',
    );
  }

  const validIds = new Set(items.map((item) => item.id));
  const constructsById = new Map<number, ConstructId[]>();
  for (const item of items) {
    constructsById.set(item.id, []);
  }

  const rawItems = (parsed as { items?: unknown }).items;
  if (Array.isArray(rawItems)) {
    for (const entry of rawItems) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== 'number' || !validIds.has(id)) continue;

      const list: ConstructId[] = [];
      const seen = new Set<ConstructId>();
      if (Array.isArray(rec.constructs)) {
        for (const c of rec.constructs) {
          if (
            typeof c === 'string' &&
            VALID_AI_CONSTRUCT_SET.has(c as ConstructId) &&
            c !== 'long_subject' &&
            !seen.has(c as ConstructId)
          ) {
            seen.add(c as ConstructId);
            list.push(c as ConstructId);
          }
        }
      }
      constructsById.set(id, list);
    }
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  return {
    constructsById,
    rawText,
    elapsedMs,
    modelName: model,
  };
}
