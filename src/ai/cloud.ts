import type { Analysis, AnalyzeResult, RetryErrorRecord } from '../types';
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
