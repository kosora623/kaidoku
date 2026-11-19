import { describe, expect, it } from 'vitest';
import {
  aggregateEvalReport,
  filterScoringSpans,
  formatComparisonMarkdown,
  formatErrorAnalysisMarkdown,
  scoreItem,
  type EvalItemResult,
  type EvalSentenceItem,
} from '../src/eval/metrics';
import type { Analysis } from '../src/types';

const EXPECTED: Analysis = {
  spans: [
    { start: 0, end: 26, role: 'S', bracket: 'noun' },
    { start: 11, end: 26, role: 'modifier', bracket: 'adj', modifies: 0 },
    { start: 27, end: 35, role: 'V' },
    { start: 36, end: 51, role: 'O', bracket: 'noun' },
  ],
  constructs: ['relative_clause'],
  difficulty: 2,
};

describe('eval/metrics.ts', () => {
  it('完全一致する予測に対して全指標 1.0 / true を返す', () => {
    const score = scoreItem(EXPECTED, EXPECTED);
    expect(score.sExact).toBe(true);
    expect(score.vExact).toBe(true);
    expect(score.svExact).toBe(true);
    expect(score.spanStrictF1).toBe(1);
    expect(score.spanExactMatch).toBe(true);
    expect(score.constructF1).toBe(1);
    expect(score.constructExactMatch).toBe(true);
  });

  it('予測が undefined（検証失敗）のときはすべて 0 / false を返す', () => {
    const score = scoreItem(EXPECTED, undefined);
    expect(score.svExact).toBe(false);
    expect(score.spanStrictF1).toBe(0);
    expect(score.constructF1).toBe(0);
  });

  it('土台作成・初回・2回目以降の所要時間と正解率を集計し Markdown 表を生成する', () => {
    const items: EvalItemResult[] = [
      {
        id: 'eval-01',
        category: 'simple',
        text: 'A',
        ok: true,
        attempts: 1,
        timing: { sessionCreateMs: 12000, analyzeMs: 3000, totalMs: 15000 },
        analysis: EXPECTED,
        rawText: '{}',
        scores: scoreItem(EXPECTED, EXPECTED),
      },
      {
        id: 'eval-02',
        category: 'relative_clause',
        text: 'B',
        ok: true,
        attempts: 2,
        timing: { sessionCreateMs: 0, analyzeMs: 2000, totalMs: 2000 },
        analysis: EXPECTED,
        rawText: '{}',
        scores: scoreItem(EXPECTED, EXPECTED),
      },
      {
        id: 'eval-03',
        category: 'comparative',
        text: 'C',
        ok: false,
        attempts: 2,
        timing: { sessionCreateMs: 0, analyzeMs: 4000, totalMs: 4000 },
        rawText: '{}',
        validationError: { code: 'MISSING_MAIN_VERB', message: 'err' },
        scores: scoreItem(EXPECTED, undefined),
      },
    ];

    const report = aggregateEvalReport(
      {
        provider: 'nano',
        modelName: 'Gemini Nano (Prompt API)',
        datasetName: 'test',
      },
      items,
    );

    expect(report.totalCount).toBe(3);
    expect(report.validCount).toBe(2);
    expect(report.retriedCount).toBe(2);
    expect(report.timingSummary.sessionCreateMs).toBe(12000);
    expect(report.timingSummary.firstAnalyzeMs).toBe(3000);
    expect(report.timingSummary.firstTotalMs).toBe(15000);
    expect(report.timingSummary.subsequentCount).toBe(2);
    expect(report.timingSummary.subsequentAvgMs).toBe(3000);
    expect(report.timingSummary.subsequentMedianMs).toBe(3000);

    const md = formatComparisonMarkdown([report]);
    expect(md).toContain('Gemini Nano');
    expect(md).toContain('土台セッション作成時間 | 12000 ms');
    expect(md).toContain('初回（1文目）解析時間 | 3000 ms');
    expect(md).toContain('2回目以降 平均解析時間 | 3000 ms');
  });

  it('非制限用法カンマを末尾に含む正解スパンと単語境界で終わる予測スパンを一致扱いできる', () => {
    const sentence =
      'The results reported in Table 3, which were obtained without any task-specific tuning, suggest that the proposed objective is robust to label noise.';
    const expected: Analysis = {
      spans: [
        { start: 0, end: 86, role: 'S', bracket: 'noun' }, // 末尾カンマ含む
        { start: 87, end: 94, role: 'V' },
      ],
      constructs: ['relative_clause'],
      difficulty: 5,
    };
    const predicted: Analysis = {
      spans: [
        { start: 0, end: 85, role: 'S', bracket: 'noun' }, // 単語 tuning の末尾
        { start: 87, end: 94, role: 'V' },
      ],
      constructs: ['relative_clause'],
      difficulty: 5,
    };

    const score = scoreItem(expected, predicted, sentence);
    expect(score.sExact).toBe(true);
    expect(score.vExact).toBe(true);
    expect(score.spanStrictF1).toBe(1);
  });

  it('formatErrorAnalysisMarkdown が不一致文の正解記法・予測記法・検証エラーを出力する', () => {
    const sentence = 'The method that we propose achieves higher accuracy.';
    const dataset: EvalSentenceItem[] = [
      {
        id: 'eval-01',
        category: 'relative_clause',
        text: sentence,
        expected: EXPECTED,
      },
    ];
    const report = aggregateEvalReport(
      {
        provider: 'cloud',
        modelName: 'gemini-3.1-flash-lite',
        datasetName: 'test',
      },
      [
        {
          id: 'eval-01',
          category: 'relative_clause',
          text: sentence,
          ok: false,
          attempts: 2,
          timing: { sessionCreateMs: 0, analyzeMs: 1200, totalMs: 1200 },
          rawText: '{"spans":[]}',
          validationError: {
            code: 'MISSING_MAIN_VERB',
            message: '主節の動詞が見つかりません。',
          },
          scores: scoreItem(EXPECTED, undefined, sentence),
        },
      ],
    );

    const md = formatErrorAnalysisMarkdown([report], dataset);
    expect(md).toContain('## Cloud (gemini-3.1-flash-lite)');
    expect(md).toContain('### eval-01');
    expect(md).toContain('#### 正解の記法');
    expect(md).toContain('[The method (that we propose)] S');
    expect(md).toContain('#### 予測の記法');
    expect(md).toContain('#### 検証エラー');
    expect(md).toContain('MISSING_MAIN_VERB');
  });

  it('採点では S・O・C のスパンの内側にある S・V・O・C を無視し、修飾の入れ子はそのまま採点する', () => {
    const sentence = 'What the results suggest is clear.';
    const expected: Analysis = {
      spans: [
        { start: 0, end: 24, role: 'S', bracket: 'noun' },
        { start: 25, end: 27, role: 'V' },
        { start: 28, end: 33, role: 'C' },
      ],
      constructs: ['long_subject'],
      difficulty: 3,
    };
    const predictedWithInnerClauseRoles: Analysis = {
      spans: [
        { start: 0, end: 24, role: 'S', bracket: 'noun' },
        { start: 5, end: 16, role: 'S', bracket: 'noun' }, // S の内側の S → 無視される
        { start: 17, end: 24, role: 'V' }, // S の内側の V → 無視される
        { start: 25, end: 27, role: 'V' },
        { start: 28, end: 33, role: 'C' },
      ],
      constructs: ['long_subject'],
      difficulty: 3,
    };

    expect(filterScoringSpans(predictedWithInnerClauseRoles.spans)).toHaveLength(
      3,
    );
    const score = scoreItem(expected, predictedWithInnerClauseRoles, sentence);
    expect(score.sExact).toBe(true);
    expect(score.vExact).toBe(true);
    expect(score.spanStrictF1).toBe(1);
    expect(score.spanExactMatch).toBe(true);
  });

  it('採点では 1 語の S・O・C（We, [MATH] 等）の bracket 有無を正規化して一致扱いする', () => {
    const sentence = 'We compute [MATH].';
    const expected: Analysis = {
      spans: [
        { start: 0, end: 2, role: 'S', bracket: 'noun' },
        { start: 3, end: 10, role: 'V' },
        { start: 11, end: 17, role: 'O', bracket: 'noun' },
      ],
      constructs: [],
      difficulty: 1,
    };
    const predicted: Analysis = {
      spans: [
        { start: 0, end: 2, role: 'S' },
        { start: 3, end: 10, role: 'V' },
        { start: 11, end: 17, role: 'O' },
      ],
      constructs: [],
      difficulty: 1,
    };

    const score = scoreItem(expected, predicted, sentence);
    expect(score.sExact).toBe(true);
    expect(score.vExact).toBe(true);
    expect(score.spanStrictF1).toBe(1);
    expect(score.spanExactMatch).toBe(true);
  });
});
