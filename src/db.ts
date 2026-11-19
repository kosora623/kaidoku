import Dexie, { type EntityTable } from 'dexie';
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
export async function getWeakConstructCounts(): Promise<
  Partial<Record<ConstructId, number>>
> {
  const unsureRows = await db.constructs
    .where('result')
    .equals('unsure')
    .toArray();
  const counts: Partial<Record<ConstructId, number>> = {};
  for (const row of unsureRows) {
    counts[row.construct] = (counts[row.construct] ?? 0) + 1;
  }
  return counts;
}

/** 「分かった／まだ怪しい」のフィードバックを SourceSentence・ConstructEntry に保存する */
export async function recordConstructFeedback(params: {
  text: string;
  pageUrl: string;
  pageTitle: string;
  constructs: ConstructId[];
  result: 'understood' | 'unsure';
  analysis?: Analysis;
}): Promise<void> {
  const sentenceId = crypto.randomUUID();
  await db.sentences.put({
    id: sentenceId,
    text: params.text,
    pageUrl: normalizePageUrl(params.pageUrl),
    pageTitle: params.pageTitle,
    lang: 'en',
    analysis: params.analysis,
    createdAt: new Date().toISOString(),
  });

  const rows: ConstructEntry[] = params.constructs.map((construct) => ({
    id: crypto.randomUUID(),
    construct,
    sentenceId,
    result: params.result,
  }));
  if (rows.length > 0) {
    await db.constructs.bulkPut(rows);
  }
}
