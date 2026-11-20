/**
 * 解析パネルの「訳を見る」押下時に、対象 1 文の自然な日本語訳を生成する AI クライアント。
 * - クラウド Gemini（gemini-3.1-flash-lite）を既定とし、API キー未設定時のみ Gemini Nano にフォールバックする
 * - 共有レートリミッタ（15 回/分）を通し、ページ本文から抽出した略語定義を訳に反映する
 */

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

export interface AcronymGlossaryEntry {
  acronym: string;
  fullForm: string;
}

export interface TranslateSentenceResult {
  sentence: string;
  /** 自然な日本語訳（1 文） */
  translationJa: string;
  /** 訳に反映したページ内の略語定義一覧 */
  appliedAcronyms: AcronymGlossaryEntry[];
  /** ページ内に定義が見つからず推測せず表記した略語一覧 */
  unresolvedAcronyms: string[];
  provider: AiProvider;
  modelName: string;
  fromCache: boolean;
}

export interface TranslateSentenceOptions {
  /** ページ本文から見つかった略語の定義一覧 */
  acronymDefinitions?: AcronymGlossaryEntry[];
  /** ページ本文に定義が見つからなかった略語一覧（推測させずそのまま表記する） */
  unresolvedAcronyms?: string[];
  apiKey?: string;
  model?: string;
  signal?: AbortSignal;
}

const CLOUD_TRANSLATE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    translationJa: { type: 'STRING' },
  },
  required: ['translationJa'],
};

const NANO_TRANSLATE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    translationJa: { type: 'string' },
  },
  required: ['translationJa'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You are an English-to-Japanese translator for academic papers and technical articles.',
  'Translate the given single English sentence into natural, accurate Japanese.',
  'Rules:',
  '- Return ONLY JSON with: {"translationJa": "..."}',
  '- Keep inline math placeholders "[MATH]" as "[MATH]" without altering or omitting them.',
  '- If "Known acronyms defined on this page" are provided, you MUST translate those acronyms strictly according to their given full forms (you may keep the acronym in parentheses where helpful, e.g. "モデル規範適応システム（MRAS）"). Do NOT invent a different meaning.',
  '- If "Undefined acronyms" are listed, do NOT guess or invent their full names; keep the acronym letters as-is in the Japanese translation.',
].join('\n');

const translationCache = new Map<
  string,
  Omit<TranslateSentenceResult, 'fromCache'>
>();

function normalizeGlossary(
  entries?: AcronymGlossaryEntry[],
): AcronymGlossaryEntry[] {
  if (!entries || entries.length === 0) return [];
  const seen = new Set<string>();
  const normalized: AcronymGlossaryEntry[] = [];
  for (const entry of entries) {
    const acronym = entry.acronym.trim();
    const fullForm = entry.fullForm.replace(/\s+/g, ' ').trim();
    if (!acronym || !fullForm) continue;
    const key = `${acronym}::${fullForm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ acronym, fullForm });
  }
  return normalized;
}

function normalizeUnresolved(items?: string[]): string[] {
  if (!items || items.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of items) {
    const acronym = raw.trim();
    if (!acronym || seen.has(acronym)) continue;
    seen.add(acronym);
    normalized.push(acronym);
  }
  return normalized;
}

function buildCacheKey(
  sentence: string,
  appliedAcronyms: AcronymGlossaryEntry[],
  unresolvedAcronyms: string[],
): string {
  const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
  const defPart = appliedAcronyms
    .map((a) => `${a.acronym}=${a.fullForm}`)
    .sort()
    .join('|');
  const undefPart = [...unresolvedAcronyms].sort().join('|');
  return `${cleanSentence}\nDEF:${defPart}\nUNDEF:${undefPart}`;
}

/** テスト用：日本語訳のメモリキャッシュをクリアする */
export function clearTranslationCache(): void {
  translationCache.clear();
}

/** 日本語訳プロンプトのユーザー入力を構築する */
export function buildTranslateUserPrompt(
  sentence: string,
  appliedAcronyms: AcronymGlossaryEntry[],
  unresolvedAcronyms: string[],
): string {
  const lines: string[] = [`Sentence: ${sentence}`];

  if (appliedAcronyms.length > 0) {
    lines.push('Known acronyms defined on this page:');
    for (const item of appliedAcronyms) {
      lines.push(`- ${item.acronym}: ${item.fullForm}`);
    }
  }

  if (unresolvedAcronyms.length > 0) {
    lines.push('Undefined acronyms (do NOT guess their expansion; keep as-is):');
    for (const acronym of unresolvedAcronyms) {
      lines.push(`- ${acronym}`);
    }
  }

  lines.push('Return JSON only.');
  return lines.join('\n');
}

function parseTranslationJson(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('日本語訳の応答を JSON として解釈できませんでした。');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('日本語訳の応答形式が不正です。');
  }

  const translationJa =
    typeof (parsed as Record<string, unknown>).translationJa === 'string'
      ? ((parsed as Record<string, unknown>).translationJa as string).trim()
      : '';
  if (!translationJa) {
    throw new Error('日本語訳を取得できませんでした。');
  }

  return translationJa;
}

async function translateWithCloud(
  sentence: string,
  appliedAcronyms: AcronymGlossaryEntry[],
  unresolvedAcronyms: string[],
  apiKey: string,
  model = DEFAULT_CLOUD_MODEL,
  signal?: AbortSignal,
): Promise<Omit<TranslateSentenceResult, 'fromCache'>> {
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const userPrompt = buildTranslateUserPrompt(
    sentence,
    appliedAcronyms,
    unresolvedAcronyms,
  );
  const bodyJson = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: CLOUD_TRANSLATE_SCHEMA,
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
        const errBody = (await response.json()) as {
          error?: { message?: string };
        };
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

      throw new Error(`日本語訳の取得に失敗しました（${detail}）。`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const translationJa = parseTranslationJson(rawText);

    return {
      sentence,
      translationJa,
      appliedAcronyms,
      unresolvedAcronyms,
      provider: 'cloud',
      modelName: model,
    };
  }

  throw new Error('日本語訳の取得に失敗しました。');
}

async function translateWithNano(
  sentence: string,
  appliedAcronyms: AcronymGlossaryEntry[],
  unresolvedAcronyms: string[],
  signal?: AbortSignal,
): Promise<Omit<TranslateSentenceResult, 'fromCache'>> {
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
    const userPrompt = buildTranslateUserPrompt(
      sentence,
      appliedAcronyms,
      unresolvedAcronyms,
    );
    const rawText = await session.prompt(userPrompt, {
      responseConstraint: NANO_TRANSLATE_SCHEMA,
      ...(signal ? { signal } : {}),
    });
    const translationJa = parseTranslationJson(rawText);
    return {
      sentence,
      translationJa,
      appliedAcronyms,
      unresolvedAcronyms,
      provider: 'nano',
      modelName: 'Gemini Nano',
    };
  } finally {
    session.destroy();
  }
}

/**
 * 指定された 1 文の自然な日本語訳を取得する（ページ内の略語定義を反映）。
 */
export async function translateSentence(
  sentence: string,
  options?: TranslateSentenceOptions,
): Promise<TranslateSentenceResult> {
  const cleanSentence = sentence.replace(/\s+/g, ' ').trim();
  if (!cleanSentence) {
    throw new Error('翻訳する英文が空です。');
  }

  const appliedAcronyms = normalizeGlossary(options?.acronymDefinitions);
  const unresolvedAcronyms = normalizeUnresolved(options?.unresolvedAcronyms);

  const cacheKey = buildCacheKey(
    cleanSentence,
    appliedAcronyms,
    unresolvedAcronyms,
  );
  const cached = translationCache.get(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const settings = await loadSettings();
  const apiKey =
    options?.apiKey !== undefined
      ? options.apiKey.trim()
      : settings.geminiApiKey;

  let result: Omit<TranslateSentenceResult, 'fromCache'>;
  if (apiKey) {
    result = await translateWithCloud(
      cleanSentence,
      appliedAcronyms,
      unresolvedAcronyms,
      apiKey,
      options?.model ?? DEFAULT_CLOUD_MODEL,
      options?.signal,
    );
  } else {
    const availability = await getNanoAvailability(NANO_JA_OUTPUT_OPTIONS);
    if (availability !== 'available') {
      throw new Error(
        'Gemini API キーが未設定のため日本語訳を取得できません。設定画面（options.html）から API キーを登録してください。',
      );
    }
    result = await translateWithNano(
      cleanSentence,
      appliedAcronyms,
      unresolvedAcronyms,
      options?.signal,
    );
  }

  translationCache.set(cacheKey, result);
  return { ...result, fromCache: false };
}
