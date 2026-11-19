import Dexie, { type EntityTable } from 'dexie';
import {
  createInitialReviewCard,
  isCardDue,
  scheduleReviewCard,
  type ReviewRating,
} from './review';
import type {
  Analysis,
  ConstructEntry,
  ConstructId,
  PageMarkCache,
  ReviewCard,
  SourceSentence,
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

/** 復習カードと紐づく単語／構文エントリを削除する */
export async function deleteReviewCardAndEntry(
  cardId: string,
  database: KaidokuDatabase = db,
): Promise<void> {
  const card = await database.reviewCards.get(cardId);
  if (!card) return;
  await database.reviewCards.delete(cardId);
  if (card.kind === 'word') {
    await database.words.delete(card.refId);
  } else {
    await database.constructs.delete(card.refId);
  }
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
