import { describe, expect, it } from 'vitest';
import {
  applyRelativePageMarks,
  calculateDifficultyAndMarkLevel,
  CONSTRUCT_WEIGHTS,
  countWords,
  detectLongSubjectFromSentence,
  selectAndBatchCandidates,
} from '../src/lang/en/difficulty';

describe('lang/en/difficulty.ts', () => {
  it('countWords が [MATH] を 1 語としてカウントする', () => {
    expect(
      countWords(
        'When the parameter [MATH] increases, the model achieves better convergence.',
      ),
    ).toBe(10);
  });

  it('detectLongSubjectFromSentence が長い主語を判定し、形式主語 it や分詞構文を誤爆しない', () => {
    expect(
      detectLongSubjectFromSentence(
        'What these ablation studies demonstrate is the importance of careful regularization.',
      ),
    ).toBe(true);
    expect(
      detectLongSubjectFromSentence(
        'Whether sparse attention scales to million-token contexts remains an open question.',
      ),
    ).toBe(true);
    expect(
      detectLongSubjectFromSentence(
        'Training large foundation models on uncurated web corpora introduces severe calibration errors.',
      ),
    ).toBe(true);

    // 形式主語 it・分詞構文・短い主語は false
    expect(
      detectLongSubjectFromSentence(
        'It is well established that deeper networks require residual connections.',
      ),
    ).toBe(false);
    expect(
      detectLongSubjectFromSentence(
        'Combining local caching with asynchronous prefetching, the engine eliminates disk bottlenecks.',
      ),
    ).toBe(false);
    expect(
      detectLongSubjectFromSentence(
        'The experiment confirms our initial hypothesis.',
      ),
    ).toBe(false);
  });

  it('誤読しやすい構文の重みが高く、文の長さと relative_clause の重みが低く抑えられている', () => {
    // 単純文（構文 0・短文）→ スコア 0・マークなし
    const simple = calculateDifficultyAndMarkLevel(
      'The experiment confirms our initial hypothesis.',
      [],
      {},
    );
    expect(simple.hardnessScore).toBe(0);
    expect(simple.difficulty).toBe(1);
    expect(simple.markLevel).toBe(0);

    // 短めでも誤読しやすい構文（omitted_relative: 3.0）
    const shortOmitted = calculateDifficultyAndMarkLevel(
      'The features we extracted capture subtle temporal dependencies.',
      ['omitted_relative'],
      {},
    );
    // 長めだが頻出の relative_clause（0.8）だけの 35 語文（長さ加点 +0.75 → 計 1.55）
    const longRelativeOnly = calculateDifficultyAndMarkLevel(
      'This long descriptive sentence that appears in an academic introduction simply lists many straightforward technical words one after another without introducing any complex nested clauses or omitted pronouns across its entire thirty five word length.',
      ['relative_clause'],
      {},
      { overrideLongSubject: false },
    );

    expect(CONSTRUCT_WEIGHTS.omitted_relative).toBeGreaterThan(
      CONSTRUCT_WEIGHTS.relative_clause,
    );
    expect(shortOmitted.hardnessScore).toBeGreaterThan(
      longRelativeOnly.hardnessScore,
    );

    // 苦手構文ブースト（unsure 記録あり）でスコアと markLevel が上がる
    const boosted = calculateDifficultyAndMarkLevel(
      'The features we extracted capture subtle temporal dependencies.',
      ['omitted_relative'],
      { omitted_relative: 2 },
    );
    expect(boosted.hardnessScore).toBeGreaterThan(shortOmitted.hardnessScore);
    expect(boosted.weakConstructsHit).toEqual(['omitted_relative']);
    expect(boosted.markLevel).toBe(3);
  });

  it('applyRelativePageMarks が上位 10% / 20% / 40% のみをマークし、濃さもマーク内順位で決める', () => {
    // 全 100 文（スコア 1..100）
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `s-${i}`,
      hardnessScore: i + 1,
      weakConstructsHit: [] as [],
      viewportOrder: i,
    }));

    const lowMap = applyRelativePageMarks(items, {
      totalPageSentences: 100,
      density: 'low',
    });
    const normalMap = applyRelativePageMarks(items, {
      totalPageSentences: 100,
      density: 'normal',
    });
    const highMap = applyRelativePageMarks(items, {
      totalPageSentences: 100,
      density: 'high',
    });

    const countMarked = (m: Map<string, number>) =>
      Array.from(m.values()).filter((v) => v > 0).length;

    expect(countMarked(lowMap)).toBe(10);
    expect(countMarked(normalMap)).toBe(20);
    expect(countMarked(highMap)).toBe(40);

    // normal（上位 20 文 = s-80..s-99）の中で、最高スコア s-99 は濃さ 3、中位は 2、下位は 1、s-79 は 0
    expect(normalMap.get('s-99')).toBe(3);
    expect(normalMap.get('s-90')).toBe(2);
    expect(normalMap.get('s-80')).toBe(1);
    expect(normalMap.get('s-79')).toBe(0);
  });

  it('selectAndBatchCandidates が 8 語以上を原則すべて候補にし、80 文 / 12,000 文字・最大 3 バッチで読む順に分割する', () => {
    const shortItem = {
      id: 'short',
      text: 'This has only six simple words.',
      viewportOrder: 0,
    };
    const items = [
      shortItem,
      ...Array.from({ length: 10 }, (_, idx) => ({
        id: `s-${idx}`,
        text: `The method that we propose achieves better accuracy on benchmark number ${idx}.`,
        viewportOrder: 10 - idx, // 逆順にして viewportOrder 昇順ソートを検証
      })),
    ];

    const batches = selectAndBatchCandidates(items, {
      minWords: 8,
      maxSentencesPerBatch: 4,
      maxCharsPerBatch: 12000,
      maxBatches: 3,
    });

    // 6語の文は除外され、8語以上の 10 文はすべて 4+4+2 の 3 バッチに収まる
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
    // viewportOrder 昇順（画面に見えている順）になっている
    expect(batches[0][0].id).toBe('s-9');
    expect(batches[2][1].id).toBe('s-0');
  });

  it('3 バッチ上限を超える超長文ページではルールスコア上位を優先選択した上で読む順に最大 3 バッチへ分割する', () => {
    const items = Array.from({ length: 10 }, (_, idx) => ({
      id: `item-${idx}`,
      // 後半に高スコア文を置く
      text:
        idx >= 6
          ? `The architecture that we introduce achieves higher throughput than dense baselines trained on larger corpora in setting ${idx}.`
          : `This simple sentence has eight plain words number ${idx}.`,
      viewportOrder: idx,
    }));

    const batches = selectAndBatchCandidates(items, {
      minWords: 8,
      maxSentencesPerBatch: 2,
      maxCharsPerBatch: 12000,
      maxBatches: 3, // 最大 6 文まで
    });

    expect(batches).toHaveLength(3);
    const selectedIds = batches.flat().map((i) => i.id);
    expect(selectedIds).toHaveLength(6);
    // 高スコアの item-6..9 が必ず優先採用されていること
    expect(selectedIds).toContain('item-6');
    expect(selectedIds).toContain('item-7');
    expect(selectedIds).toContain('item-8');
    expect(selectedIds).toContain('item-9');
    // 出力は読む順（viewportOrder 昇順）に戻されていること
    const orders = batches.flat().map((i) => i.viewportOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});
