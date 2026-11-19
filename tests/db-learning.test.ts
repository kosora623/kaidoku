import { describe, expect, it } from 'vitest';
import {
  deleteReviewCardAndEntry,
  getHydratedReviewCards,
  getLearningSummary,
  getWeakConstructCounts,
  recordConstructFeedback,
  saveWordEntry,
  submitReviewAnswer,
  type KaidokuDatabase,
} from '../src/db';
import type {
  Analysis,
  ConstructEntry,
  ReviewCard,
  SourceSentence,
  WordEntry,
} from '../src/types';

/** テスト用の最小インメモリ Dexie テーブルモック */
function createMemoryTable<T extends object>(pk: keyof T) {
  const store = new Map<string, T>();
  return {
    async get(key: string): Promise<T | undefined> {
      return store.get(key);
    },
    async put(item: T): Promise<string> {
      const k = String(item[pk]);
      store.set(k, structuredClone(item));
      return k;
    },
    async bulkPut(items: T[]): Promise<void> {
      for (const item of items) {
        await this.put(item);
      }
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
    async toArray(): Promise<T[]> {
      return Array.from(store.values()).map((v) => structuredClone(v));
    },
    where(field: keyof T) {
      return {
        equals(value: unknown) {
          return {
            async toArray(): Promise<T[]> {
              return Array.from(store.values())
                .filter((row) => row[field] === value)
                .map((v) => structuredClone(v));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(): KaidokuDatabase {
  return {
    sentences: createMemoryTable<SourceSentence>('id'),
    words: createMemoryTable<WordEntry>('id'),
    constructs: createMemoryTable<ConstructEntry>('id'),
    reviewCards: createMemoryTable<ReviewCard>('id'),
    pageMarkCaches: createMemoryTable<Record<string, unknown>>('url'),
  } as unknown as KaidokuDatabase;
}

const SAMPLE_TEXT = 'The method that we propose achieves higher accuracy.';
const SAMPLE_ANALYSIS: Analysis = {
  spans: [
    { start: 0, end: 26, role: 'S', bracket: 'noun' },
    { start: 11, end: 26, role: 'modifier', bracket: 'adj', modifies: 0 },
    { start: 27, end: 35, role: 'V' },
    { start: 36, end: 51, role: 'O', bracket: 'noun' },
  ],
  constructs: ['relative_clause'],
  difficulty: 2,
};
const NOW = Date.parse('2026-11-19T10:00:00.000Z');

describe('db.ts（単語記録・構文フィードバック・復習カード連携）', () => {
  it('「まだ怪しい」を押した構文だけ復習カードを作成し、「分かった」だけではカードを作らない', async () => {
    const fakeDb = createFakeDb();

    // 1. 「分かった」は ConstructEntry のみ記録し、新規カードは作成しない
    const okRes = await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5?utm_source=x#S1',
        pageTitle: 'Gemini Paper',
        constructs: ['relative_clause'],
        result: 'understood',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      fakeDb,
    );
    expect(okRes.createdCardCount).toBe(0);
    expect(await getHydratedReviewCards(fakeDb)).toHaveLength(0);

    // 2. 同じ文で「まだ怪しい」を押すと SourceSentence を再利用し、構文カードが 1 枚作られる
    const unsureRes = await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5#S2',
        pageTitle: 'Gemini Paper',
        constructs: ['relative_clause'],
        result: 'unsure',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      fakeDb,
    );
    expect(unsureRes.sentence.id).toBe(okRes.sentence.id);
    expect(unsureRes.createdCardCount).toBe(1);

    const weak = await getWeakConstructCounts(fakeDb);
    expect(weak.relative_clause).toBe(1);

    const cards = await getHydratedReviewCards(fakeDb);
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe('construct');

    // 3. 既存カードがある状態で「分かった」を押すと、そのカードの間隔が伸びる（新規カードは作らない）
    const okAgain = await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5',
        pageTitle: 'Gemini Paper',
        constructs: ['relative_clause'],
        result: 'understood',
        nowMs: NOW,
      },
      fakeDb,
    );
    expect(okAgain.createdCardCount).toBe(0);
    expect(okAgain.updatedCardCount).toBe(1);
    const updatedCards = await getHydratedReviewCards(fakeDb);
    expect(updatedCards[0].card.interval).toBe(1);
  });

  it('単語を元の文・記事 URL・タイトルごと記録し、同じ文の構文記録と SourceSentence を共有する', async () => {
    const fakeDb = createFakeDb();

    const first = await saveWordEntry(
      {
        word: 'achieves',
        meaning: '達成する',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5?utm_medium=test',
        pageTitle: 'Gemini Paper',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      fakeDb,
    );
    expect(first.created).toBe(true);
    expect(first.sentence.pageUrl).toBe('https://arxiv.org/html/2312.11805v5');
    expect(first.sentence.pageTitle).toBe('Gemini Paper');
    expect(first.reviewCard.kind).toBe('word');

    // 同じ文・同じ単語（大文字小文字違い）を再保存すると上書き更新されカードは増えない
    const dup = await saveWordEntry(
      {
        word: 'Achieves',
        meaning: '実現する・達成する',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5',
        pageTitle: 'Gemini Paper',
        nowMs: NOW,
      },
      fakeDb,
    );
    expect(dup.created).toBe(false);
    expect(dup.wordEntry.id).toBe(first.wordEntry.id);
    expect(dup.wordEntry.meaning).toBe('実現する・達成する');

    // 同じ文で構文「まだ怪しい」を記録すると SourceSentence は 1 件のまま共有される
    await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2312.11805v5',
        pageTitle: 'Gemini Paper',
        constructs: ['relative_clause'],
        result: 'unsure',
        nowMs: NOW,
      },
      fakeDb,
    );

    const summary = await getLearningSummary(NOW, fakeDb);
    expect(summary.totalCards).toBe(2);
    expect(summary.totalWordCards).toBe(1);
    expect(summary.totalConstructCards).toBe(1);
    expect(summary.dueTotal).toBe(2);

    // 復習回答（good）で期限待ちから外れ、削除でカードと単語エントリが消える
    const answered = await submitReviewAnswer(first.reviewCard.id, 'good', NOW, fakeDb);
    expect(answered.interval).toBe(1);
    const afterSummary = await getLearningSummary(NOW, fakeDb);
    expect(afterSummary.dueWords).toBe(0);
    expect(afterSummary.dueConstructs).toBe(1);

    await deleteReviewCardAndEntry(first.reviewCard.id, fakeDb);
    const afterDelete = await getHydratedReviewCards(fakeDb);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].kind).toBe('construct');
  });
});
