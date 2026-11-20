import Dexie, { type EntityTable } from 'dexie';
import { CONSTRUCT_IDS } from './lang/en/constructs';
import {
  createInitialReviewCard,
  isCardDue,
  scheduleReviewCard,
  type ReviewRating,
} from './review';
import {
  loadSettings,
  saveDeveloperMode,
  saveMarkDensity,
  saveNanoPromptMode,
} from './settings';
import type {
  Analysis,
  AnalysisSpan,
  BracketType,
  ConstructEntry,
  ConstructId,
  MarkDensity,
  NanoPromptMode,
  PageMarkCache,
  ReviewCard,
  SourceSentence,
  SpanRole,
  WordEntry,
} from './types';

/** ページ判定キャッシュの既定有効期間（7日間） */
export const PAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

/**
 * キャッシュキー用に URL を正規化する。
 * ハッシュフラグメント（#...）とトラッキング用クエリパラメータを除き、残りのクエリを昇順ソートする。
 */
export function normalizePageUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    const kept: Array<[string, string]> = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      if (!TRACKING_QUERY_PARAMS.has(k.toLowerCase())) {
        kept.push([k, v]);
      }
    }
    kept.sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [k, v] of kept) {
      parsed.searchParams.append(k, v);
    }
    return parsed.toString();
  } catch {
    return rawUrl.split('#')[0];
  }
}

/**
 * χ読のローカル IndexedDB（Dexie）スキーマ
 * すべての学習データと URL キャッシュは手元のブラウザにのみ保存する。
 */
export class KaidokuDatabase extends Dexie {
  sentences!: EntityTable<SourceSentence, 'id'>;
  words!: EntityTable<WordEntry, 'id'>;
  constructs!: EntityTable<ConstructEntry, 'id'>;
  reviewCards!: EntityTable<ReviewCard, 'id'>;
  pageMarkCaches!: EntityTable<PageMarkCache, 'url'>;

  constructor(name = 'kaidoku') {
    super(name);
    this.version(1).stores({
      sentences: 'id, pageUrl, lang, createdAt',
      words: 'id, word, sentenceId',
      constructs: 'id, construct, sentenceId, result',
      reviewCards: 'id, kind, refId, dueAt',
    });
    this.version(2).stores({
      sentences: 'id, pageUrl, lang, createdAt',
      words: 'id, word, sentenceId',
      constructs: 'id, construct, sentenceId, result',
      reviewCards: 'id, kind, refId, dueAt',
      pageMarkCaches: 'url, createdAt, expiresAt',
    });
  }
}

export const db = new KaidokuDatabase();

/** 正規化 URL で有効なページ判定キャッシュを取得する（期限切れ・本文更新時は null） */
export async function getValidPageMarkCache(
  rawUrl: string,
  expectedContentHash: string,
  nowMs = Date.now(),
): Promise<PageMarkCache | null> {
  const url = normalizePageUrl(rawUrl);
  const entry = await db.pageMarkCaches.get(url);
  if (!entry) return null;

  const expiresMs = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    await db.pageMarkCaches.delete(url);
    return null;
  }

  if (entry.contentHash !== expectedContentHash) {
    return null;
  }

  return entry;
}

/** ページ判定キャッシュを URL ごとに保存する */
export async function savePageMarkCache(
  entry: Omit<PageMarkCache, 'url' | 'createdAt' | 'expiresAt'> & {
    rawUrl: string;
    ttlMs?: number;
  },
): Promise<PageMarkCache> {
  const now = Date.now();
  const record: PageMarkCache = {
    url: normalizePageUrl(entry.rawUrl),
    pageTitle: entry.pageTitle,
    contentHash: entry.contentHash,
    provider: entry.provider,
    modelName: entry.modelName,
    batchCallCount: entry.batchCallCount,
    marks: entry.marks,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (entry.ttlMs ?? PAGE_CACHE_TTL_MS)).toISOString(),
  };
  await db.pageMarkCaches.put(record);
  return record;
}

/** 特定 URL のページキャッシュを削除する */
export async function deletePageMarkCache(rawUrl: string): Promise<void> {
  await db.pageMarkCaches.delete(normalizePageUrl(rawUrl));
}

/** すべてのページ判定キャッシュを削除する */
export async function clearAllPageMarkCaches(): Promise<void> {
  await db.pageMarkCaches.clear();
}

/** ユーザーの苦手構文（result === 'unsure'）の件数を構文IDごとに集計する */
export async function getWeakConstructCounts(
  database: KaidokuDatabase = db,
): Promise<Partial<Record<ConstructId, number>>> {
  const unsureRows = await database.constructs
    .where('result')
    .equals('unsure')
    .toArray();
  const counts: Partial<Record<ConstructId, number>> = {};
  for (const row of unsureRows) {
    counts[row.construct] = (counts[row.construct] ?? 0) + 1;
  }
  return counts;
}

/**
 * 同一ページ（正規化 URL）かつ同一本文の SourceSentence があれば再利用し、なければ新規作成する。
 * 単語と構文の記録が共通の SourceSentence を参照する（SPEC.md 準拠）。
 */
export async function findOrCreateSourceSentence(
  params: {
    text: string;
    pageUrl: string;
    pageTitle: string;
    analysis?: Analysis;
    nowMs?: number;
  },
  database: KaidokuDatabase = db,
): Promise<SourceSentence> {
  const normalizedUrl = normalizePageUrl(params.pageUrl);
  const cleanText = params.text.trim();
  const cleanTitle = params.pageTitle.trim() || normalizedUrl;

  const samePage = await database.sentences
    .where('pageUrl')
    .equals(normalizedUrl)
    .toArray();
  const existing = samePage.find((s) => s.text.trim() === cleanText);

  if (existing) {
    const needsUpdate =
      (!existing.analysis && Boolean(params.analysis)) ||
      (existing.pageTitle !== cleanTitle && Boolean(params.pageTitle.trim()));
    if (needsUpdate) {
      const updated: SourceSentence = {
        ...existing,
        pageTitle: params.pageTitle.trim() ? cleanTitle : existing.pageTitle,
        analysis: params.analysis ?? existing.analysis,
      };
      await database.sentences.put(updated);
      return updated;
    }
    return existing;
  }

  const created: SourceSentence = {
    id: crypto.randomUUID(),
    text: cleanText,
    pageUrl: normalizedUrl,
    pageTitle: cleanTitle,
    lang: 'en',
    ...(params.analysis ? { analysis: params.analysis } : {}),
    createdAt: new Date(params.nowMs ?? Date.now()).toISOString(),
  };
  await database.sentences.put(created);
  return created;
}

/**
 * 「分かった／まだ怪しい」のフィードバックを SourceSentence・ConstructEntry・ReviewCard に保存する。
 * - まだ怪しい（unsure）：新規の復習カードを作成（既存カードがあれば期限を現在に戻し lapses + 1）
 * - 分かった（understood）：新規カードは作成せず、既存カードがある場合のみ間隔を伸ばして更新する
 */
export async function recordConstructFeedback(
  params: {
    text: string;
    pageUrl: string;
    pageTitle: string;
    constructs: ConstructId[];
    result: 'understood' | 'unsure';
    analysis?: Analysis;
    nowMs?: number;
  },
  database: KaidokuDatabase = db,
): Promise<{
  sentence: SourceSentence;
  entries: ConstructEntry[];
  createdCardCount: number;
  updatedCardCount: number;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const sentence = await findOrCreateSourceSentence(
    {
      text: params.text,
      pageUrl: params.pageUrl,
      pageTitle: params.pageTitle,
      analysis: params.analysis,
      nowMs,
    },
    database,
  );

  const uniqueConstructs = Array.from(new Set(params.constructs));
  const existingEntries = await database.constructs
    .where('sentenceId')
    .equals(sentence.id)
    .toArray();
  const existingCards = await database.reviewCards
    .where('kind')
    .equals('construct')
    .toArray();

  const entries: ConstructEntry[] = [];
  let createdCardCount = 0;
  let updatedCardCount = 0;

  for (const construct of uniqueConstructs) {
    const foundEntry = existingEntries.find((e) => e.construct === construct);
    const entry: ConstructEntry = foundEntry
      ? { ...foundEntry, result: params.result }
      : {
          id: crypto.randomUUID(),
          construct,
          sentenceId: sentence.id,
          result: params.result,
        };
    await database.constructs.put(entry);
    entries.push(entry);

    const foundCard = existingCards.find((c) => c.refId === entry.id);

    if (params.result === 'unsure') {
      if (foundCard) {
        const resetCard: ReviewCard = {
          ...foundCard,
          interval: 0,
          lapses: foundCard.lapses + 1,
          dueAt: new Date(nowMs).toISOString(),
        };
        await database.reviewCards.put(resetCard);
        updatedCardCount += 1;
      } else {
        const newCard = createInitialReviewCard('construct', entry.id, nowMs);
        await database.reviewCards.put(newCard);
        createdCardCount += 1;
      }
    } else if (foundCard) {
      // 「分かった」時は既存カードがあれば間隔を伸ばす（新規カードは作成しない）
      const advanced = scheduleReviewCard(foundCard, 'good', nowMs);
      await database.reviewCards.put(advanced);
      updatedCardCount += 1;
    }
  }

  return { sentence, entries, createdCardCount, updatedCardCount };
}

/**
 * 単語を元の文・記事 URL・タイトルごと記録し、復習カード（kind: 'word'）を作成する。
 * 同じ文＋同じ単語（大文字小文字無視）が既に記録済みの場合は意味を上書き更新する。
 */
export async function saveWordEntry(
  params: {
    word: string;
    meaning: string;
    text: string;
    pageUrl: string;
    pageTitle: string;
    analysis?: Analysis;
    nowMs?: number;
  },
  database: KaidokuDatabase = db,
): Promise<{
  wordEntry: WordEntry;
  sentence: SourceSentence;
  reviewCard: ReviewCard;
  created: boolean;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const cleanWord = params.word.trim();
  const cleanMeaning = params.meaning.trim();
  if (!cleanWord || !cleanMeaning) {
    throw new Error('単語と意味の両方を指定してください。');
  }

  const sentence = await findOrCreateSourceSentence(
    {
      text: params.text,
      pageUrl: params.pageUrl,
      pageTitle: params.pageTitle,
      analysis: params.analysis,
      nowMs,
    },
    database,
  );

  const existingWords = await database.words
    .where('sentenceId')
    .equals(sentence.id)
    .toArray();
  const foundWord = existingWords.find(
    (w) => w.word.toLowerCase() === cleanWord.toLowerCase(),
  );

  const created = !foundWord;
  const wordEntry: WordEntry = foundWord
    ? { ...foundWord, word: cleanWord, meaning: cleanMeaning }
    : {
        id: crypto.randomUUID(),
        word: cleanWord,
        meaning: cleanMeaning,
        sentenceId: sentence.id,
      };
  await database.words.put(wordEntry);

  const existingWordCards = await database.reviewCards
    .where('kind')
    .equals('word')
    .toArray();
  const foundCard = existingWordCards.find((c) => c.refId === wordEntry.id);

  let reviewCard: ReviewCard;
  if (foundCard) {
    reviewCard = foundCard;
  } else {
    reviewCard = createInitialReviewCard('word', wordEntry.id, nowMs);
    await database.reviewCards.put(reviewCard);
  }

  return { wordEntry, sentence, reviewCard, created };
}

/** 復習画面で表示するために元文・単語/構文データを結合したカード情報 */
export type HydratedReviewCard =
  | {
      kind: 'word';
      card: ReviewCard;
      wordEntry: WordEntry;
      sentence: SourceSentence;
    }
  | {
      kind: 'construct';
      card: ReviewCard;
      constructEntry: ConstructEntry;
      sentence: SourceSentence;
    };

/** すべての有効な復習カードを元文・単語／構文データと結合して取得する */
export async function getHydratedReviewCards(
  database: KaidokuDatabase = db,
): Promise<HydratedReviewCard[]> {
  const [cards, words, constructs, sentences] = await Promise.all([
    database.reviewCards.toArray(),
    database.words.toArray(),
    database.constructs.toArray(),
    database.sentences.toArray(),
  ]);

  const wordById = new Map(words.map((w) => [w.id, w]));
  const constructById = new Map(constructs.map((c) => [c.id, c]));
  const sentenceById = new Map(sentences.map((s) => [s.id, s]));

  const hydrated: HydratedReviewCard[] = [];
  for (const card of cards) {
    if (card.kind === 'word') {
      const wordEntry = wordById.get(card.refId);
      if (!wordEntry) continue;
      const sentence = sentenceById.get(wordEntry.sentenceId);
      if (!sentence) continue;
      hydrated.push({ kind: 'word', card, wordEntry, sentence });
    } else {
      const constructEntry = constructById.get(card.refId);
      if (!constructEntry) continue;
      const sentence = sentenceById.get(constructEntry.sentenceId);
      if (!sentence) continue;
      hydrated.push({ kind: 'construct', card, constructEntry, sentence });
    }
  }

  return hydrated;
}

/** 復習回答を保存し、更新後の ReviewCard を返す */
export async function submitReviewAnswer(
  cardId: string,
  rating: ReviewRating,
  nowMs = Date.now(),
  database: KaidokuDatabase = db,
): Promise<ReviewCard> {
  const card = await database.reviewCards.get(cardId);
  if (!card) {
    throw new Error(`指定された復習カードが見つかりません（${cardId}）。`);
  }
  const updated = scheduleReviewCard(card, rating, nowMs);
  await database.reviewCards.put(updated);
  return updated;
}

/** 復習カードと紐づく単語／構文エントリを削除し、どの記録からも参照されなくなった孤立 SourceSentence も削除する */
export async function deleteReviewCardAndEntry(
  cardId: string,
  database: KaidokuDatabase = db,
): Promise<void> {
  const card = await database.reviewCards.get(cardId);
  if (!card) return;

  let sentenceId: string | null = null;
  if (card.kind === 'word') {
    const word = await database.words.get(card.refId);
    sentenceId = word?.sentenceId ?? null;
    await database.reviewCards.delete(cardId);
    await database.words.delete(card.refId);
  } else {
    const construct = await database.constructs.get(card.refId);
    sentenceId = construct?.sentenceId ?? null;
    await database.reviewCards.delete(cardId);
    await database.constructs.delete(card.refId);
  }

  if (sentenceId) {
    const [remainingWords, remainingConstructs] = await Promise.all([
      database.words.where('sentenceId').equals(sentenceId).toArray(),
      database.constructs.where('sentenceId').equals(sentenceId).toArray(),
    ]);
    if (remainingWords.length === 0 && remainingConstructs.length === 0) {
      await database.sentences.delete(sentenceId);
    }
  }
}

/** どの単語・構文からも参照されていない孤立 SourceSentence を一括削除し、削除件数を返す */
export async function pruneOrphanSourceSentences(
  database: KaidokuDatabase = db,
): Promise<number> {
  const [sentences, words, constructs] = await Promise.all([
    database.sentences.toArray(),
    database.words.toArray(),
    database.constructs.toArray(),
  ]);

  const referencedIds = new Set<string>();
  for (const w of words) referencedIds.add(w.sentenceId);
  for (const c of constructs) referencedIds.add(c.sentenceId);

  let removed = 0;
  for (const s of sentences) {
    if (!referencedIds.has(s.id)) {
      await database.sentences.delete(s.id);
      removed += 1;
    }
  }
  return removed;
}

/** 復習画面サマリー用の学習状況を集計する */
export interface LearningSummary {
  dueTotal: number;
  dueWords: number;
  dueConstructs: number;
  totalCards: number;
  totalWordCards: number;
  totalConstructCards: number;
  weakConstructs: Array<{ construct: ConstructId; count: number }>;
}

export async function getLearningSummary(
  nowMs = Date.now(),
  database: KaidokuDatabase = db,
): Promise<LearningSummary> {
  const [hydrated, weakCounts] = await Promise.all([
    getHydratedReviewCards(database),
    getWeakConstructCounts(database),
  ]);

  let dueWords = 0;
  let dueConstructs = 0;
  let totalWordCards = 0;
  let totalConstructCards = 0;

  for (const item of hydrated) {
    const due = isCardDue(item.card, nowMs);
    if (item.kind === 'word') {
      totalWordCards += 1;
      if (due) dueWords += 1;
    } else {
      totalConstructCards += 1;
      if (due) dueConstructs += 1;
    }
  }

  const weakConstructs = (
    Object.entries(weakCounts) as Array<[ConstructId, number]>
  )
    .filter(([, count]) => count > 0)
    .map(([construct, count]) => ({ construct, count }))
    .sort((a, b) => b.count - a.count);

  return {
    dueTotal: dueWords + dueConstructs,
    dueWords,
    dueConstructs,
    totalCards: hydrated.length,
    totalWordCards,
    totalConstructCards,
    weakConstructs,
  };
}

/** エクスポート JSON のスキーマバージョン */
export const KAIDOKU_EXPORT_FORMAT_VERSION = 1 as const;

/** エクスポート対象の設定（API キーおよび同意状態は絶対に含めない） */
export interface ExportableSettings {
  markDensity: MarkDensity;
  nanoPromptMode: NanoPromptMode;
  developerMode: boolean;
}

/** エクスポート・インポート用 JSON ペイロード */
export interface KaidokuExportData {
  app: 'kaidoku';
  formatVersion: typeof KAIDOKU_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  settings: ExportableSettings;
  data: {
    sentences: SourceSentence[];
    words: WordEntry[];
    constructs: ConstructEntry[];
    reviewCards: ReviewCard[];
  };
}

export interface ImportTableCounts {
  sentences: number;
  words: number;
  constructs: number;
  reviewCards: number;
}

export interface ImportConflictReport {
  incoming: ImportTableCounts;
  conflicts: ImportTableCounts;
  totalIncoming: number;
  totalConflicts: number;
}

export interface ImportExecutionResult {
  added: ImportTableCounts;
  overwritten: ImportTableCounts;
  skipped: ImportTableCounts;
  totalApplied: number;
  totalSkipped: number;
}

const VALID_CONSTRUCT_SET = new Set<string>(CONSTRUCT_IDS);
const VALID_ROLE_SET = new Set<SpanRole>(['S', 'V', 'O', 'C', 'modifier']);
const VALID_BRACKET_SET = new Set<BracketType>(['noun', 'adj', 'adv']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeOptionalAnalysis(raw: unknown): Analysis | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new Error('エクスポート内の解析データ（analysis）の形式が不正です。');
  }
  if (!Array.isArray(raw.spans) || !Array.isArray(raw.constructs)) {
    throw new Error('エクスポート内の解析スパンまたは構文配列が不正です。');
  }
  if (typeof raw.difficulty !== 'number' || !Number.isFinite(raw.difficulty)) {
    throw new Error('エクスポート内の難易度（difficulty）が不正です。');
  }

  const spans: AnalysisSpan[] = raw.spans.map((item, idx) => {
    if (!isRecord(item)) {
      throw new Error(`解析スパン[${idx}]の形式が不正です。`);
    }
    if (
      typeof item.start !== 'number' ||
      typeof item.end !== 'number' ||
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 0 ||
      item.end <= item.start
    ) {
      throw new Error(`解析スパン[${idx}]の文字位置が不正です。`);
    }
    if (typeof item.role !== 'string' || !VALID_ROLE_SET.has(item.role as SpanRole)) {
      throw new Error(`解析スパン[${idx}]の role が不正です。`);
    }
    const span: AnalysisSpan = {
      start: item.start,
      end: item.end,
      role: item.role as SpanRole,
    };
    if (item.bracket !== undefined) {
      if (
        typeof item.bracket !== 'string' ||
        !VALID_BRACKET_SET.has(item.bracket as BracketType)
      ) {
        throw new Error(`解析スパン[${idx}]の bracket が不正です。`);
      }
      span.bracket = item.bracket as BracketType;
    }
    if (item.modifies !== undefined) {
      if (
        typeof item.modifies !== 'number' ||
        !Number.isInteger(item.modifies) ||
        item.modifies < 0
      ) {
        throw new Error(`解析スパン[${idx}]の modifies が不正です。`);
      }
      span.modifies = item.modifies;
    }
    return span;
  });

  const constructs: ConstructId[] = [];
  for (const cid of raw.constructs) {
    if (typeof cid === 'string' && VALID_CONSTRUCT_SET.has(cid)) {
      constructs.push(cid as ConstructId);
    }
  }

  return {
    spans,
    constructs,
    difficulty: Math.min(5, Math.max(1, Math.round(raw.difficulty))),
  };
}

function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
}

/**
 * 単語・構文・文・復習カード・設定（API キーと同意状態を除く）を JSON エクスポート用に収集する。
 * 出力前に孤立 SourceSentence を自動でクリーンアップする。
 */
export async function exportKaidokuData(
  options?: {
    settings?: ExportableSettings;
    nowMs?: number;
  },
  database: KaidokuDatabase = db,
): Promise<KaidokuExportData> {
  await pruneOrphanSourceSentences(database);

  const [sentences, words, constructs, reviewCards, loadedSettings] =
    await Promise.all([
      database.sentences.toArray(),
      database.words.toArray(),
      database.constructs.toArray(),
      database.reviewCards.toArray(),
      options?.settings ? Promise.resolve(null) : loadSettings(),
    ]);

  // API キー（geminiApiKey）や同意状態（cloudConsent）は絶対に書き出さない
  const exportSettings: ExportableSettings = options?.settings
    ? {
        markDensity: options.settings.markDensity,
        nanoPromptMode: options.settings.nanoPromptMode,
        developerMode: Boolean(options.settings.developerMode),
      }
    : {
        markDensity: loadedSettings?.markDensity ?? 'normal',
        nanoPromptMode: loadedSettings?.nanoPromptMode ?? 'one-stage',
        developerMode: Boolean(loadedSettings?.developerMode),
      };

  return {
    app: 'kaidoku',
    formatVersion: KAIDOKU_EXPORT_FORMAT_VERSION,
    exportedAt: new Date(options?.nowMs ?? Date.now()).toISOString(),
    settings: exportSettings,
    data: {
      sentences,
      words,
      constructs,
      reviewCards,
    },
  };
}

/**
 * インポート用 JSON 文字列を検証・正規化して KaidokuExportData に変換する。
 * 不正な形式や未対応バージョンは分かりやすい日本語エラーを投げる。
 */
export function parseKaidokuExportJson(rawJson: string): KaidokuExportData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('JSON ファイルの形式が正しくありません（構文エラー）。');
  }

  if (!isRecord(parsed)) {
    throw new Error('エクスポートファイルのトップレベル形式が不正です。');
  }
  if (parsed.app !== 'kaidoku') {
    throw new Error('χ読のエクスポートファイルではありません（app が一致しません）。');
  }
  if (parsed.formatVersion !== KAIDOKU_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `未対応のエクスポート形式バージョンです（formatVersion: ${String(parsed.formatVersion)}）。`,
    );
  }
  if (!isRecord(parsed.data)) {
    throw new Error('エクスポートファイルに data フィールドがありません。');
  }

  const rawData = parsed.data;
  if (
    !Array.isArray(rawData.sentences) ||
    !Array.isArray(rawData.words) ||
    !Array.isArray(rawData.constructs) ||
    !Array.isArray(rawData.reviewCards)
  ) {
    throw new Error(
      'エクスポートファイル内の sentences / words / constructs / reviewCards 配列が不足しています。',
    );
  }

  const sentences: SourceSentence[] = rawData.sentences.map((row, idx) => {
    if (!isRecord(row)) {
      throw new Error(`文データ（sentences[${idx}]）の形式が不正です。`);
    }
    if (!isNonEmptyString(row.id) || !isNonEmptyString(row.text)) {
      throw new Error(`文データ（sentences[${idx}]）に必須項目（id / text）がありません。`);
    }
    if (!isNonEmptyString(row.pageUrl) || !isSafeHttpUrl(row.pageUrl.trim())) {
      throw new Error(`文データ（sentences[${idx}]）の pageUrl が不正です。`);
    }
    const analysis = sanitizeOptionalAnalysis(row.analysis);
    return {
      id: row.id.trim(),
      text: row.text.trim(),
      pageUrl: normalizePageUrl(row.pageUrl.trim()),
      pageTitle:
        typeof row.pageTitle === 'string' && row.pageTitle.trim()
          ? row.pageTitle.trim()
          : normalizePageUrl(row.pageUrl.trim()),
      lang: 'en',
      ...(analysis ? { analysis } : {}),
      createdAt:
        typeof row.createdAt === 'string' && row.createdAt.trim()
          ? row.createdAt.trim()
          : new Date().toISOString(),
    };
  });

  const words: WordEntry[] = rawData.words.map((row, idx) => {
    if (!isRecord(row)) {
      throw new Error(`単語データ（words[${idx}]）の形式が不正です。`);
    }
    if (
      !isNonEmptyString(row.id) ||
      !isNonEmptyString(row.word) ||
      !isNonEmptyString(row.meaning) ||
      !isNonEmptyString(row.sentenceId)
    ) {
      throw new Error(`単語データ（words[${idx}]）の必須項目が不足しています。`);
    }
    return {
      id: row.id.trim(),
      word: row.word.trim(),
      meaning: row.meaning.trim(),
      sentenceId: row.sentenceId.trim(),
    };
  });

  const constructs: ConstructEntry[] = rawData.constructs.map((row, idx) => {
    if (!isRecord(row)) {
      throw new Error(`構文データ（constructs[${idx}]）の形式が不正です。`);
    }
    if (
      !isNonEmptyString(row.id) ||
      !isNonEmptyString(row.sentenceId) ||
      typeof row.construct !== 'string' ||
      !VALID_CONSTRUCT_SET.has(row.construct) ||
      (row.result !== 'understood' && row.result !== 'unsure')
    ) {
      throw new Error(`構文データ（constructs[${idx}]）の内容が不正です。`);
    }
    return {
      id: row.id.trim(),
      construct: row.construct as ConstructId,
      sentenceId: row.sentenceId.trim(),
      result: row.result,
    };
  });

  const reviewCards: ReviewCard[] = rawData.reviewCards.map((row, idx) => {
    if (!isRecord(row)) {
      throw new Error(`復習カード（reviewCards[${idx}]）の形式が不正です。`);
    }
    if (
      !isNonEmptyString(row.id) ||
      (row.kind !== 'word' && row.kind !== 'construct') ||
      !isNonEmptyString(row.refId) ||
      !isNonEmptyString(row.dueAt) ||
      typeof row.interval !== 'number' ||
      !Number.isFinite(row.interval) ||
      row.interval < 0 ||
      typeof row.ease !== 'number' ||
      !Number.isFinite(row.ease) ||
      row.ease <= 0 ||
      typeof row.lapses !== 'number' ||
      !Number.isFinite(row.lapses) ||
      row.lapses < 0
    ) {
      throw new Error(`復習カード（reviewCards[${idx}]）の内容が不正です。`);
    }
    return {
      id: row.id.trim(),
      kind: row.kind,
      refId: row.refId.trim(),
      dueAt: row.dueAt.trim(),
      interval: row.interval,
      ease: row.ease,
      lapses: row.lapses,
    };
  });

  // 設定は許可された 3 項目のみ取り込み、万一 API キー等が含まれていても無視する
  const rawSettings = isRecord(parsed.settings) ? parsed.settings : {};
  const markDensity: MarkDensity =
    rawSettings.markDensity === 'low' || rawSettings.markDensity === 'high'
      ? rawSettings.markDensity
      : 'normal';
  const nanoPromptMode: NanoPromptMode =
    rawSettings.nanoPromptMode === 'two-stage' ? 'two-stage' : 'one-stage';
  const developerMode = rawSettings.developerMode === true;

  return {
    app: 'kaidoku',
    formatVersion: KAIDOKU_EXPORT_FORMAT_VERSION,
    exportedAt:
      typeof parsed.exportedAt === 'string' && parsed.exportedAt.trim()
        ? parsed.exportedAt.trim()
        : new Date().toISOString(),
    settings: {
      markDensity,
      nanoPromptMode,
      developerMode,
    },
    data: {
      sentences: deduplicateById(sentences),
      words: deduplicateById(words),
      constructs: deduplicateById(constructs),
      reviewCards: deduplicateById(reviewCards),
    },
  };
}

/**
 * インポート前に、既存 DB と同じ ID が何件重複するかを事前集計する。
 */
export async function inspectImportConflicts(
  payload: KaidokuExportData,
  database: KaidokuDatabase = db,
): Promise<ImportConflictReport> {
  const [existingSentences, existingWords, existingConstructs, existingCards] =
    await Promise.all([
      database.sentences.toArray(),
      database.words.toArray(),
      database.constructs.toArray(),
      database.reviewCards.toArray(),
    ]);

  const sentenceIds = new Set(existingSentences.map((s) => s.id));
  const wordIds = new Set(existingWords.map((w) => w.id));
  const constructIds = new Set(existingConstructs.map((c) => c.id));
  const cardIds = new Set(existingCards.map((c) => c.id));

  const incoming: ImportTableCounts = {
    sentences: payload.data.sentences.length,
    words: payload.data.words.length,
    constructs: payload.data.constructs.length,
    reviewCards: payload.data.reviewCards.length,
  };

  const conflicts: ImportTableCounts = {
    sentences: payload.data.sentences.filter((s) => sentenceIds.has(s.id)).length,
    words: payload.data.words.filter((w) => wordIds.has(w.id)).length,
    constructs: payload.data.constructs.filter((c) => constructIds.has(c.id))
      .length,
    reviewCards: payload.data.reviewCards.filter((c) => cardIds.has(c.id)).length,
  };

  return {
    incoming,
    conflicts,
    totalIncoming:
      incoming.sentences +
      incoming.words +
      incoming.constructs +
      incoming.reviewCards,
    totalConflicts:
      conflicts.sentences +
      conflicts.words +
      conflicts.constructs +
      conflicts.reviewCards,
  };
}

/**
 * 検証済みのエクスポートデータをローカル DB と設定へ取り込む。
 * - overwriteExisting: true なら同じ ID を上書き、false なら既存 ID をスキップして新規のみ追加する
 * - API キーおよび外部送信の同意状態は一切変更しない
 */
export async function importKaidokuData(
  payload: KaidokuExportData,
  options: {
    overwriteExisting: boolean;
    applySettings?: (settings: ExportableSettings) => Promise<void>;
  },
  database: KaidokuDatabase = db,
): Promise<ImportExecutionResult> {
  const added: ImportTableCounts = {
    sentences: 0,
    words: 0,
    constructs: 0,
    reviewCards: 0,
  };
  const overwritten: ImportTableCounts = {
    sentences: 0,
    words: 0,
    constructs: 0,
    reviewCards: 0,
  };
  const skipped: ImportTableCounts = {
    sentences: 0,
    words: 0,
    constructs: 0,
    reviewCards: 0,
  };

  const runDbImport = async (): Promise<void> => {
    const [existingSentences, existingWords, existingConstructs, existingCards] =
      await Promise.all([
        database.sentences.toArray(),
        database.words.toArray(),
        database.constructs.toArray(),
        database.reviewCards.toArray(),
      ]);

    const applyTable = async <T extends { id: string }>(
      tableKey: keyof ImportTableCounts,
      incomingRows: T[],
      existingIds: Set<string>,
      table: { bulkPut: (rows: T[]) => Promise<unknown> },
    ): Promise<void> => {
      const toWrite: T[] = [];
      for (const row of incomingRows) {
        if (existingIds.has(row.id)) {
          if (options.overwriteExisting) {
            toWrite.push(row);
            overwritten[tableKey] += 1;
          } else {
            skipped[tableKey] += 1;
          }
        } else {
          toWrite.push(row);
          added[tableKey] += 1;
        }
      }
      if (toWrite.length > 0) {
        await table.bulkPut(toWrite);
      }
    };

    await applyTable(
      'sentences',
      payload.data.sentences,
      new Set(existingSentences.map((s) => s.id)),
      database.sentences,
    );
    await applyTable(
      'words',
      payload.data.words,
      new Set(existingWords.map((w) => w.id)),
      database.words,
    );
    await applyTable(
      'constructs',
      payload.data.constructs,
      new Set(existingConstructs.map((c) => c.id)),
      database.constructs,
    );
    await applyTable(
      'reviewCards',
      payload.data.reviewCards,
      new Set(existingCards.map((c) => c.id)),
      database.reviewCards,
    );
  };

  if (typeof database.transaction === 'function') {
    await database.transaction(
      'rw',
      [
        database.sentences,
        database.words,
        database.constructs,
        database.reviewCards,
      ],
      runDbImport,
    );
  } else {
    await runDbImport();
  }

  if (options.applySettings) {
    await options.applySettings(payload.settings);
  } else {
    await Promise.all([
      saveMarkDensity(payload.settings.markDensity),
      saveNanoPromptMode(payload.settings.nanoPromptMode),
      saveDeveloperMode(payload.settings.developerMode),
    ]);
  }

  const totalApplied =
    added.sentences +
    added.words +
    added.constructs +
    added.reviewCards +
    overwritten.sentences +
    overwritten.words +
    overwritten.constructs +
    overwritten.reviewCards;
  const totalSkipped =
    skipped.sentences +
    skipped.words +
    skipped.constructs +
    skipped.reviewCards;

  return {
    added,
    overwritten,
    skipped,
    totalApplied,
    totalSkipped,
  };
}
