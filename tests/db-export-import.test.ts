import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteReviewCardAndEntry,
  exportKaidokuData,
  getHydratedReviewCards,
  getLearningSummary,
  importKaidokuData,
  inspectImportConflicts,
  parseKaidokuExportJson,
  pruneOrphanSourceSentences,
  recordConstructFeedback,
  saveWordEntry,
  submitReviewAnswer,
  type ExportableSettings,
  type KaidokuDatabase,
} from '../src/db';
import type {
  Analysis,
  ConstructEntry,
  ReviewCard,
  SourceSentence,
  WordEntry,
} from '../src/types';

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

const SAMPLE_TEXT =
  'The MRAS controller that we propose achieves faster convergence.';
const SAMPLE_ANALYSIS: Analysis = {
  spans: [
    { start: 0, end: 35, role: 'S', bracket: 'noun' },
    { start: 20, end: 35, role: 'modifier', bracket: 'adj', modifies: 0 },
    { start: 36, end: 44, role: 'V' },
    { start: 45, end: 63, role: 'O', bracket: 'noun' },
  ],
  constructs: ['relative_clause'],
  difficulty: 3,
};
const NOW = Date.parse('2026-11-20T10:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('db.ts（孤立 SourceSentence クリーンアップ・JSON エクスポート／インポート）', () => {
  it('最後の参照が削除されたときに孤立 SourceSentence も自動削除し、参照が残る間は保持する', async () => {
    const fakeDb = createFakeDb();

    const wordSaved = await saveWordEntry(
      {
        word: 'MRAS',
        meaning: 'モデル規範適応システム（Model reference adaptive systems）',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      fakeDb,
    );
    const constructSaved = await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        constructs: ['relative_clause'],
        result: 'unsure',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      fakeDb,
    );

    expect(await fakeDb.sentences.toArray()).toHaveLength(1);

    // 単語カードを削除しても構文側が同じ SourceSentence を参照しているため残る
    await deleteReviewCardAndEntry(wordSaved.reviewCard.id, fakeDb);
    expect(await fakeDb.sentences.toArray()).toHaveLength(1);

    // 残った構文カードも削除すると孤立 SourceSentence も自動削除される
    const cards = await fakeDb.reviewCards.toArray();
    expect(cards).toHaveLength(1);
    expect(constructSaved.createdCardCount).toBe(1);
    await deleteReviewCardAndEntry(cards[0].id, fakeDb);
    expect(await fakeDb.sentences.toArray()).toHaveLength(0);
  });

  it('pruneOrphanSourceSentences が既存データ内の孤立文だけを削除する', async () => {
    const fakeDb = createFakeDb();
    await fakeDb.sentences.put({
      id: 'orphan-1',
      text: 'Unused sentence.',
      pageUrl: 'https://example.com/old',
      pageTitle: 'Old',
      lang: 'en',
      createdAt: new Date(NOW).toISOString(),
    });
    await saveWordEntry(
      {
        word: 'convergence',
        meaning: '収束',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        nowMs: NOW,
      },
      fakeDb,
    );

    const removed = await pruneOrphanSourceSentences(fakeDb);
    expect(removed).toBe(1);
    const remaining = await fakeDb.sentences.toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe(SAMPLE_TEXT);
  });

  it('エクスポート JSON に API キーを一切含めず、別プロファイルへ復元すると単語・構文・復習カードと設定が元どおりに出る', async () => {
    const profileADb = createFakeDb();
    const secretApiKey = 'AIzaSySUPER_SECRET_TEST_KEY_DO_NOT_EXPORT';

    // プロファイル A の chrome.storage.local に API キーと設定が入っている想定
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kaidoku_gemini_api_key: secretApiKey,
            kaidoku_mark_density: 'high',
            kaidoku_nano_prompt_mode: 'one-stage',
            kaidoku_developer_mode: true,
            kaidoku_cloud_consent: {
              granted: true,
              version: '2026-11-20',
              grantedAt: '2026-11-20T09:00:00.000Z',
            },
          }),
        },
      },
    };

    const wordSaved = await saveWordEntry(
      {
        word: 'MRAS',
        meaning: 'モデル規範適応システム（Model reference adaptive systems）',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      profileADb,
    );
    await recordConstructFeedback(
      {
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        constructs: ['relative_clause'],
        result: 'unsure',
        analysis: SAMPLE_ANALYSIS,
        nowMs: NOW,
      },
      profileADb,
    );
    // 単語カードを 1 回「忘れた」にして lapses = 1 を記録しておく
    await submitReviewAnswer(wordSaved.reviewCard.id, 'again', NOW, profileADb);

    // 孤立文があってもエクスポート時に掃除されることを確認
    await profileADb.sentences.put({
      id: 'orphan-sentence',
      text: 'Should be pruned before export.',
      pageUrl: 'https://example.com/orphan',
      pageTitle: 'Orphan',
      lang: 'en',
      createdAt: new Date(NOW).toISOString(),
    });

    const exported = await exportKaidokuData({ nowMs: NOW }, profileADb);
    const jsonText = JSON.stringify(exported, null, 2);

    // API キーおよび同意情報は絶対に書き出されないこと
    expect(jsonText).not.toContain(secretApiKey);
    expect(jsonText).not.toContain('geminiApiKey');
    expect(jsonText).not.toContain('cloudConsent');
    expect(exported.settings).toEqual({
      markDensity: 'high',
      nanoPromptMode: 'one-stage',
      developerMode: true,
    });
    expect(exported.data.sentences).toHaveLength(1);
    expect(exported.data.words).toHaveLength(1);
    expect(exported.data.constructs).toHaveLength(1);
    expect(exported.data.reviewCards).toHaveLength(2);

    // 別プロファイル B（空 DB）へインポート
    const profileBDb = createFakeDb();
    let appliedSettings: ExportableSettings | null = null;
    const parsed = parseKaidokuExportJson(jsonText);
    const conflicts = await inspectImportConflicts(parsed, profileBDb);
    expect(conflicts.totalConflicts).toBe(0);

    const importRes = await importKaidokuData(
      parsed,
      {
        overwriteExisting: false,
        applySettings: async (s) => {
          appliedSettings = s;
        },
      },
      profileBDb,
    );
    expect(importRes.totalApplied).toBe(5);
    expect(appliedSettings).toEqual({
      markDensity: 'high',
      nanoPromptMode: 'one-stage',
      developerMode: true,
    });

    // 復習画面で参照するデータ（getHydratedReviewCards / getLearningSummary）が元どおりに復元されていること
    const hydratedA = await getHydratedReviewCards(profileADb);
    const hydratedB = await getHydratedReviewCards(profileBDb);
    expect(hydratedB).toEqual(hydratedA);

    const summaryA = await getLearningSummary(NOW + 20 * 60 * 1000, profileADb);
    const summaryB = await getLearningSummary(NOW + 20 * 60 * 1000, profileBDb);
    expect(summaryB).toEqual(summaryA);
    expect(summaryB.totalCards).toBe(2);
    expect(summaryB.totalWordCards).toBe(1);
    expect(summaryB.totalConstructCards).toBe(1);
  });

  it('同じ ID のデータが存在する場合、重複件数を検出し「スキップ」と「上書き」の両方を正しく処理する', async () => {
    const dbTarget = createFakeDb();
    const existing = await saveWordEntry(
      {
        word: 'MRAS',
        meaning: '旧訳',
        text: SAMPLE_TEXT,
        pageUrl: 'https://arxiv.org/html/2501.00001v1',
        pageTitle: 'MRAS Paper',
        nowMs: NOW,
      },
      dbTarget,
    );

    const incomingPayload = parseKaidokuExportJson(
      JSON.stringify({
        app: 'kaidoku',
        formatVersion: 1,
        exportedAt: new Date(NOW).toISOString(),
        settings: {
          markDensity: 'low',
          nanoPromptMode: 'one-stage',
          developerMode: false,
          geminiApiKey: 'SHOULD_BE_IGNORED',
        },
        data: {
          sentences: [existing.sentence],
          words: [
            {
              ...existing.wordEntry,
              meaning: '新しい正確な訳',
            },
            {
              id: 'word-new-1',
              word: 'convergence',
              meaning: '収束',
              sentenceId: existing.sentence.id,
            },
          ],
          constructs: [],
          reviewCards: [existing.reviewCard],
        },
      }),
    );

    // 紛れ込んだ geminiApiKey はパース時に無視される
    expect('geminiApiKey' in incomingPayload.settings).toBe(false);

    const report = await inspectImportConflicts(incomingPayload, dbTarget);
    expect(report.conflicts).toEqual({
      sentences: 1,
      words: 1,
      constructs: 0,
      reviewCards: 1,
    });
    expect(report.totalConflicts).toBe(3);

    // 1. スキップ指定：既存 ID は残し、新規 ID のみ追加される
    const skipRes = await importKaidokuData(
      incomingPayload,
      { overwriteExisting: false, applySettings: async () => {} },
      dbTarget,
    );
    expect(skipRes.skipped.words).toBe(1);
    expect(skipRes.added.words).toBe(1);
    expect((await dbTarget.words.get(existing.wordEntry.id))?.meaning).toBe('旧訳');
    expect((await dbTarget.words.get('word-new-1'))?.meaning).toBe('収束');

    // 2. 上書き指定：同じ ID が新しい内容で上書きされる
    const overwriteRes = await importKaidokuData(
      incomingPayload,
      { overwriteExisting: true, applySettings: async () => {} },
      dbTarget,
    );
    expect(overwriteRes.overwritten.words).toBe(2);
    expect((await dbTarget.words.get(existing.wordEntry.id))?.meaning).toBe(
      '新しい正確な訳',
    );
  });

  it('不正な JSON や危険な URL スキーム（javascript:）を含むファイルはエラーで拒否する', () => {
    expect(() => parseKaidokuExportJson('not-json')).toThrow(/構文エラー/);
    expect(() =>
      parseKaidokuExportJson(JSON.stringify({ app: 'other', formatVersion: 1 })),
    ).toThrow(/χ読のエクスポートファイルではありません/);
    expect(() =>
      parseKaidokuExportJson(
        JSON.stringify({
          app: 'kaidoku',
          formatVersion: 1,
          exportedAt: new Date(NOW).toISOString(),
          settings: {},
          data: {
            sentences: [
              {
                id: 's1',
                text: 'Hello world.',
                pageUrl: 'javascript:alert(1)',
                pageTitle: 'Bad',
                lang: 'en',
                createdAt: new Date(NOW).toISOString(),
              },
            ],
            words: [],
            constructs: [],
            reviewCards: [],
          },
        }),
      ),
    ).toThrow(/pageUrl/);
  });
});
