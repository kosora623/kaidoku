/**
 * 文脈に合う英単語の日本語の意味を 1 つだけ取得する AI クライアント。
 * クラウド Gemini（gemini-3.1-flash-lite）を既定とし、API キー未設定時のみ
 * Gemini Nano（Prompt API）にフォールバックする。
 */

import { loadSettings } from '../settings';
import type { AiProvider } from '../types';
import { DEFAULT_CLOUD_MODEL } from './cloud';
import { getNanoAvailability } from './nano';
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
  /** 日本語の品詞（例: 動詞, 名詞, 形容詞） */
  partOfSpeech: string;
  /** 文脈に合う簡潔な日本語の意味を 1 つ */
  meaningJa: string;
  provider: AiProvider;
  modelName: string;
  fromCache: boolean;
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
  '- "partOfSpeech": short Japanese part-of-speech label (e.g. "動詞", "名詞", "形容詞", "副詞", "前置詞")',
  '- "meaningJa": ONE concise, natural Japanese meaning that fits this exact sentence context (no long explanation, max ~25 Japanese characters)',
].join('\n');

const meaningCache = new Map<string, Omit<WordMeaningResult, 'fromCache'>>();

function buildCacheKey(word: string, sentence: string): string {
  return `${word.trim().toLowerCase()}\n${sentence.replace(/\s+/g, ' ').trim()}`;
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

function buildUserPrompt(word: string, sentence: string): string {
  return `Target word: ${word}\nSentence: ${sentence}\nReturn JSON only.`;
}

async function lookupWithCloud(
  word: string,
  sentence: string,
  apiKey: string,
  model = DEFAULT_CLOUD_MODEL,
  signal?: AbortSignal,
): Promise<Omit<WordMeaningResult, 'fromCache'>> {
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const bodyJson = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(word, sentence) }] }],
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
): Promise<Omit<WordMeaningResult, 'fromCache'>> {
  const lm = getLanguageModelGlobal();
  if (!lm) {
    throw new Error(
      'Gemini API キーが未設定で、Gemini Nano も利用できません。設定画面（options.html）から API キーを登録してください。',
    );
  }

  const session = await lm.create({
    initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    temperature: 0,
    topK: 1,
  });

  try {
    const rawText = await session.prompt(buildUserPrompt(word, sentence), {
      responseConstraint: NANO_WORD_MEANING_SCHEMA,
      ...(signal ? { signal } : {}),
    });
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
}

/**
 * 英文中の対象単語について、文脈に合う日本語の意味を 1 つ返す。
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

  const cacheKey = buildCacheKey(cleanWord, cleanSentence);
  const cached = meaningCache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const settings = await loadSettings();
  const apiKey =
    options?.apiKey !== undefined
      ? options.apiKey.trim()
      : settings.geminiApiKey;

  let result: Omit<WordMeaningResult, 'fromCache'>;
  if (apiKey) {
    result = await lookupWithCloud(
      cleanWord,
      cleanSentence,
      apiKey,
      options?.model ?? DEFAULT_CLOUD_MODEL,
      options?.signal,
    );
  } else {
    const availability = await getNanoAvailability();
    if (availability !== 'available') {
      throw new Error(
        'Gemini API キーが未設定のため単語の意味を取得できません。設定画面（options.html）から API キーを登録してください。',
      );
    }
    result = await lookupWithNano(cleanWord, cleanSentence, options?.signal);
  }

  meaningCache.set(cacheKey, result);
  return { ...result, fromCache: false };
}
