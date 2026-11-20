/**
 * 文脈に合う英単語の日本語の意味を 1 つだけ取得する AI クライアント。
 * クラウド Gemini（gemini-3.1-flash-lite）を既定とし、API キー未設定時のみ
 * Gemini Nano（Prompt API）にフォールバックする。
 */

import { normalizeAcronymBase } from '../lang/en/acronym';
import { loadSettings } from '../settings';
import type { AiProvider } from '../types';
import { DEFAULT_CLOUD_MODEL } from './cloud';
import { getNanoAvailability, NANO_JA_OUTPUT_OPTIONS } from './nano';
import type { LanguageModelStatic } from './prompt-api';
import {
  acquireCloudRateLimitSlot,
  extractTransientRetryWaitMs,
  sleepWithAbort,
} from './rate-limiter';

function getLanguageModelGlobal(): LanguageModelStatic | null {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelStatic };
  return typeof g.LanguageModel === 'object' || typeof g.LanguageModel === 'function'
    ? g.LanguageModel ?? null
    : null;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface WordMeaningResult {
  word: string;
  /** 辞書の見出し語（原形） */
  lemma: string;
  /** 日本語の品詞（例: 動詞, 名詞, 形容詞, 略語） */
  partOfSpeech: string;
  /** 文脈に合う簡潔な日本語の意味を 1 つ（ページ内定義が見つからず推測しない場合は空文字） */
  meaningJa: string;
  provider: AiProvider | 'none';
  modelName: string;
  fromCache: boolean;
  /** 対象語が略語として処理されたか */
  isAcronym?: boolean;
  /** ページ本文から見つかった略語の正式名称（見つからなかった場合は null） */
  acronymDefinition?: string | null;
  /** ページ内に定義が見つからず AI が推測した訳か */
  isGuessed?: boolean;
}

const CLOUD_WORD_MEANING_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    lemma: { type: 'STRING' },
    partOfSpeech: { type: 'STRING' },
    meaningJa: { type: 'STRING' },
  },
  required: ['lemma', 'partOfSpeech', 'meaningJa'],
};

const NANO_WORD_MEANING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    lemma: { type: 'string' },
    partOfSpeech: { type: 'string' },
    meaningJa: { type: 'string' },
  },
  required: ['lemma', 'partOfSpeech', 'meaningJa'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You are an English-to-Japanese contextual dictionary for academic papers and technical articles.',
  'Given one target English word and the sentence it appears in, return ONLY JSON with:',
  '- "lemma": dictionary base form of the target word in English',
  '- "partOfSpeech": short Japanese part-of-speech label (e.g. "動詞", "名詞", "形容詞", "副詞", "前置詞", "略語")',
  '- "meaningJa": ONE concise, natural Japanese meaning that fits this exact sentence context (no long explanation, max ~25 Japanese characters)',
  '- If "Page definition of acronym" is provided, you MUST translate that exact full form into a concise, natural Japanese meaning fitting the sentence context (do NOT invent a different expansion), and set "lemma" to the singular base acronym.',
  '- If "Acronym with no definition on page" is noted, return your best contextual Japanese meaning guess for that acronym.',
].join('\n');

const meaningCache = new Map<string, Omit<WordMeaningResult, 'fromCache'>>();

function buildCacheKey(
  word: string,
  sentence: string,
  acronymContext?: {
    isAcronym: boolean;
    acronymDefinition: string | null;
    isGuessed: boolean;
  },
): string {
  const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
  if (!acronymContext?.isAcronym) {
    return `${word.trim().toLowerCase()}\n${cleanSentence}`;
  }
  const base = normalizeAcronymBase(word);
  return `acronym:${base}\n${acronymContext.acronymDefinition ?? ''}\n${acronymContext.isGuessed ? 'guess' : 'defined'}\n${cleanSentence}`;
}

/** テスト用：メモリキャッシュをクリアする */
export function clearWordMeaningCache(): void {
  meaningCache.clear();
}

function parseMeaningJson(
  rawText: string,
  fallbackWord: string,
): { lemma: string; partOfSpeech: string; meaningJa: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('単語の意味の応答を JSON として解釈できませんでした。');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('単語の意味の応答形式が不正です。');
  }

  const obj = parsed as Record<string, unknown>;
  const meaningJa =
    typeof obj.meaningJa === 'string' ? obj.meaningJa.trim() : '';
  if (!meaningJa) {
    throw new Error('単語の日本語の意味が取得できませんでした。');
  }

  const lemma =
    typeof obj.lemma === 'string' && obj.lemma.trim()
      ? obj.lemma.trim()
      : fallbackWord;
  const partOfSpeech =
    typeof obj.partOfSpeech === 'string' && obj.partOfSpeech.trim()
      ? obj.partOfSpeech.trim()
      : '語句';

  return { lemma, partOfSpeech, meaningJa };
}

interface AcronymPromptContext {
  isAcronym: boolean;
  acronymDefinition: string | null;
  isGuessed: boolean;
}

function buildUserPrompt(
  word: string,
  sentence: string,
  acronymContext?: AcronymPromptContext,
): string {
  if (acronymContext?.isAcronym && acronymContext.acronymDefinition) {
    return [
      `Target word: ${word}`,
      `Page definition of acronym: ${acronymContext.acronymDefinition}`,
      `Sentence: ${sentence}`,
      'Translate the page definition into a concise Japanese meaning fitting this sentence context. Return JSON only.',
    ].join('\n');
  }
  if (acronymContext?.isAcronym && acronymContext.isGuessed) {
    return [
      `Target word: ${word}`,
      'Note: Acronym with no definition on page.',
      `Sentence: ${sentence}`,
      'Provide your best contextual Japanese meaning guess for this acronym. Return JSON only.',
    ].join('\n');
  }
  return `Target word: ${word}\nSentence: ${sentence}\nReturn JSON only.`;
}

async function lookupWithCloud(
  word: string,
  sentence: string,
  apiKey: string,
  model = DEFAULT_CLOUD_MODEL,
  signal?: AbortSignal,
  acronymContext?: AcronymPromptContext,
): Promise<Omit<WordMeaningResult, 'fromCache'>> {
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const bodyJson = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: buildUserPrompt(word, sentence, acronymContext) }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: CLOUD_WORD_MEANING_SCHEMA,
    },
  });

  for (let transientAttempt = 0; transientAttempt < 2; transientAttempt++) {
    await acquireCloudRateLimitSlot(signal);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: bodyJson,
      signal,
    });

    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) {
          detail = `${response.status}: ${errBody.error.message}`;
        }
      } catch {
        // 本文が JSON でない場合はステータスのみ使用
      }

      if (
        (response.status === 429 || response.status === 503) &&
        transientAttempt === 0
      ) {
        const waitMs = extractTransientRetryWaitMs(response.status, detail);
        await sleepWithAbort(waitMs, signal);
        continue;
      }

      throw new Error(`単語の意味の取得に失敗しました（${detail}）。`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = parseMeaningJson(rawText, word);

    return {
      word,
      ...parsed,
      provider: 'cloud',
      modelName: model,
    };
  }

  throw new Error('単語の意味の取得に失敗しました。');
}

async function lookupWithNano(
  word: string,
  sentence: string,
  signal?: AbortSignal,
  acronymContext?: AcronymPromptContext,
): Promise<Omit<WordMeaningResult, 'fromCache'>> {
  const lm = getLanguageModelGlobal();
  if (!lm) {
    throw new Error(
      'Gemini API キーが未設定で、Gemini Nano も利用できません。設定画面（options.html）から API キーを登録してください。',
    );
  }

  const session = await lm.create({
    ...NANO_JA_OUTPUT_OPTIONS,
    initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    temperature: 0,
    topK: 1,
  });

  try {
    const rawText = await session.prompt(
      buildUserPrompt(word, sentence, acronymContext),
      {
        responseConstraint: NANO_WORD_MEANING_SCHEMA,
        ...(signal ? { signal } : {}),
      },
    );
    const parsed = parseMeaningJson(rawText, word);
    return {
      word,
      ...parsed,
      provider: 'nano',
      modelName: 'Gemini Nano',
    };
  } finally {
    session.destroy();
  }
}

export interface LookupWordMeaningOptions {
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
  /** 対象単語が略語として探索対象かどうか */
  isAcronym?: boolean;
  /** ページ本文から見つかった略語の正式名称（見つからなかった場合は null） */
  acronymDefinition?: string | null;
  /** ページ内に定義が見つからない略語でも AI に推測させる場合のみ true（既定 false） */
  allowAcronymGuess?: boolean;
}

/**
 * 英文中の対象単語について、文脈に合う日本語の意味を 1 つ返す。
 * 略語かつページ内に定義が見つからない場合は、既定では AI に推測させず未定義結果を返す。
 */
export async function lookupWordMeaning(
  word: string,
  sentence: string,
  options?: LookupWordMeaningOptions,
): Promise<WordMeaningResult> {
  const cleanWord = word.trim();
  const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
  if (!cleanWord || !cleanSentence) {
    throw new Error('単語または元の文が空です。');
  }

  const cleanDefinition =
    typeof options?.acronymDefinition === 'string' &&
    options.acronymDefinition.trim()
      ? options.acronymDefinition.trim()
      : null;
  const isAcronym = Boolean(options?.isAcronym || cleanDefinition);
  const allowGuess = Boolean(options?.allowAcronymGuess);

  // 略語かつページ内定義が見つからず、推測も明示要求されていない場合は AI を呼ばない
  if (isAcronym && !cleanDefinition && !allowGuess) {
    return {
      word: cleanWord,
      lemma: normalizeAcronymBase(cleanWord),
      partOfSpeech: '略語',
      meaningJa: '',
      provider: 'none',
      modelName: 'page-lookup',
      fromCache: false,
      isAcronym: true,
      acronymDefinition: null,
      isGuessed: false,
    };
  }

  const acronymContext: AcronymPromptContext | undefined = isAcronym
    ? {
        isAcronym: true,
        acronymDefinition: cleanDefinition,
        isGuessed: !cleanDefinition && allowGuess,
      }
    : undefined;

  const cacheKey = buildCacheKey(cleanWord, cleanSentence, acronymContext);
  const cached = meaningCache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const settings = await loadSettings();
  const apiKey =
    options?.apiKey !== undefined
      ? options.apiKey.trim()
      : settings.geminiApiKey;

  let baseResult: Omit<WordMeaningResult, 'fromCache'>;
  if (apiKey) {
    baseResult = await lookupWithCloud(
      cleanWord,
      cleanSentence,
      apiKey,
      options?.model ?? DEFAULT_CLOUD_MODEL,
      options?.signal,
      acronymContext,
    );
  } else {
    const availability = await getNanoAvailability(NANO_JA_OUTPUT_OPTIONS);
    if (availability !== 'available') {
      throw new Error(
        'Gemini API キーが未設定のため単語の意味を取得できません。設定画面（options.html）から API キーを登録してください。',
      );
    }
    baseResult = await lookupWithNano(
      cleanWord,
      cleanSentence,
      options?.signal,
      acronymContext,
    );
  }

  const result: Omit<WordMeaningResult, 'fromCache'> = acronymContext
    ? {
        ...baseResult,
        isAcronym: true,
        acronymDefinition: acronymContext.acronymDefinition,
        isGuessed: acronymContext.isGuessed,
      }
    : baseResult;

  meaningCache.set(cacheKey, result);
  return { ...result, fromCache: false };
}
