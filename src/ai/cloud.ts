import { AI_CONSTRUCT_IDS, CONSTRUCT_IDS } from '../lang/en/constructs';
import type { Analysis, AnalyzeResult, ConstructId, RetryErrorRecord } from '../types';
import {
  buildAnalysisInitialPrompts,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildRetryFeedbackPrompt,
} from './prompt';
import { AnalysisValidationError, CLOUD_WORD_ANALYSIS_SCHEMA } from './schema';
import { convertWordAnalysisToCharAnalysis, tokenizeWords } from './tokenizer';

/** クラウドフォールバックで使用する既定モデル（定数差し替え可能） */
export const DEFAULT_CLOUD_MODEL = 'gemini-3.1-flash-lite';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AnalyzeWithCloudOptions {
  model?: string;
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

/** Gemini REST API にリクエストしてレスポンステキストを返す */
async function callGeminiApi(
  endpoint: string,
  apiKey: string,
  contents: GeminiContentTurn[],
  signal?: AbortSignal,
): Promise<string> {
  const body = {
    systemInstruction: {
      parts: [{ text: buildAnalysisSystemPrompt() }],
    },
    contents,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: CLOUD_WORD_ANALYSIS_SCHEMA,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

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
    throw new Error(
      `クラウド Gemini API の呼び出しに失敗しました（${detail}）。`,
    );
  }

  const data = (await response.json()) as GeminiGenerateContentResponse;
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!rawText) {
    throw new AnalysisValidationError(
      'INVALID_JSON',
      'クラウド Gemini API から空の応答が返されました。',
      data,
    );
  }
  return rawText;
}

function parseAndValidateCloudOutput(
  sentence: string,
  rawText: string,
  tokens: ReturnType<typeof tokenizeWords>,
): Analysis {
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
    return convertWordAnalysisToCharAnalysis(sentence, parsed, tokens);
  } catch (err) {
    if (err instanceof AnalysisValidationError) {
      err.rawText = rawText;
    }
    throw err;
  }
}

/**
 * クラウドの Gemini API（Flash-Lite 系）で 1 文を構造解析する。
 * 検証失敗時は失敗理由を添えて 1 回だけ再試行する。
 * ユーザーが設定画面（または評価用 .env.local）で API キーを設定している場合のみ呼び出す。
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

  const fewShotContents: GeminiContentTurn[] = buildAnalysisInitialPrompts()
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const userTurn: GeminiContentTurn = {
    role: 'user',
    parts: [{ text: buildAnalysisUserPrompt(trimmed, tokens) }],
  };

  let attempts = 1;
  let firstAttemptError: RetryErrorRecord | undefined;
  let rawText = await callGeminiApi(
    endpoint,
    trimmedKey,
    [...fewShotContents, userTurn],
    options?.signal,
  );

  let analysis: Analysis;
  try {
    analysis = parseAndValidateCloudOutput(trimmed, rawText, tokens);
  } catch (firstErr) {
    if (!(firstErr instanceof AnalysisValidationError)) {
      throw firstErr;
    }

    // 検証エラー時は失敗理由を添えて 1 回だけ再試行する
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

    rawText = await callGeminiApi(
      endpoint,
      trimmedKey,
      retryTurns,
      options?.signal,
    );

    try {
      analysis = parseAndValidateCloudOutput(trimmed, rawText, tokens);
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
        };
      }
      throw secondErr;
    }
  }

  const analyzeMs = Math.round(performance.now() - startedAt);

  return {
    analysis,
    provider: 'cloud',
    rawText,
    elapsedMs: analyzeMs,
    timing: {
      sessionCreateMs: 0,
      analyzeMs,
      totalMs: analyzeMs,
    },
    sessionCreated: false,
    attempts,
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

  const body = {
    systemInstruction: {
      parts: [{ text: buildBatchConstructsSystemPrompt() }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userText }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: CLOUD_BATCH_CONSTRUCTS_SCHEMA,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': trimmedKey,
    },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const errBody = (await response.json()) as GeminiGenerateContentResponse;
      if (errBody?.error?.message) {
        detail = `${response.status}: ${errBody.error.message}`;
      }
    } catch {
      // JSON でない場合はステータスのみ使用
    }
    throw new Error(
      `クラウド Gemini API（バッチ構文判定）の呼び出しに失敗しました（${detail}）。`,
    );
  }

  const data = (await response.json()) as GeminiGenerateContentResponse;
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!rawText) {
    throw new Error('クラウド Gemini API（バッチ構文判定）から空の応答が返されました。');
  }

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
