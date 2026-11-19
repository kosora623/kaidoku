import { describe, expect, it } from 'vitest';
import {
  calculateDifficultyAndMarkLevel,
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

  it('calculateDifficultyAndMarkLevel が SPEC.md の計算式どおりに difficulty と markLevel を算出する', () => {
    // 単純文（構文 0・短文）→ マークなし
    const simple = calculateDifficultyAndMarkLevel(
      'The experiment confirms our initial hypothesis.',
      [],
      {},
    );
    expect(simple.difficulty).toBe(1);
    expect(simple.markLevel).toBe(0);

    // 短め難文（構文 1・8 語：eval-07）→ level 1（落とさない）
    const shortHard = calculateDifficultyAndMarkLevel(
      'The features we extracted capture subtle temporal dependencies.',
      ['omitted_relative'],
      {},
    );
    expect(shortHard.difficulty).toBe(2);
    expect(shortHard.markLevel).toBe(1);

    // 苦手構文ブースト（unsure 記録あり）→ level 1 が level 2 になる
    const boosted1 = calculateDifficultyAndMarkLevel(
      'The features we extracted capture subtle temporal dependencies.',
      ['omitted_relative'],
      { omitted_relative: 2 },
    );
    expect(boosted1.markLevel).toBe(2);
    expect(boosted1.weakConstructsHit).toEqual(['omitted_relative']);

    // 複数構文（baseLevel 2）＋ 苦手構文あり → level 3（濃い強調）
    const boostedMax = calculateDifficultyAndMarkLevel(
      'The system evaluated on noisy speech benchmarks outperforms conventional pipelines.',
      ['participle_modifier'],
      { participle_modifier: 1 },
      { overrideLongSubject: true },
    );
    expect(boostedMax.constructs).toContain('long_subject');
    expect(boostedMax.markLevel).toBe(3);
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
