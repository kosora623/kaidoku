import { describe, expect, it } from 'vitest';
import {
  AnalysisValidationError,
  findMainVerbSpans,
  validateAnalysis,
} from '../src/ai/schema';

const SENTENCE = 'The method that we propose achieves higher accuracy.';

describe('validateAnalysis', () => {
  it('正しい文字位置ベースの解析結果を通過させる', () => {
    const result = validateAnalysis(SENTENCE, {
      spans: [
        { start: 0, end: 26, role: 'S', bracket: 'noun' },
        { start: 11, end: 26, role: 'modifier', bracket: 'adj', modifies: 0 },
        { start: 27, end: 35, role: 'V' },
        { start: 36, end: 51, role: 'O', bracket: 'noun' },
      ],
      constructs: ['relative_clause', 'participle_modifier'],
      difficulty: 3,
    });

    expect(result.spans).toHaveLength(4);
    expect(result.constructs).toEqual([
      'relative_clause',
      'participle_modifier',
    ]);
    expect(result.difficulty).toBe(3);
  });

  it('end が文の長さを超える場合は SPAN_OUT_OF_RANGE を投げる', () => {
    expect(() =>
      validateAnalysis(SENTENCE, {
        spans: [{ start: 0, end: SENTENCE.length + 5, role: 'S' }],
        constructs: [],
        difficulty: 2,
      }),
    ).toThrowError(AnalysisValidationError);
  });

  it('start >= end の場合はエラーにする', () => {
    expect(() =>
      validateAnalysis(SENTENCE, {
        spans: [{ start: 10, end: 10, role: 'S' }],
        constructs: [],
        difficulty: 1,
      }),
    ).toThrowError(AnalysisValidationError);
  });

  it('スパンの前後に空白が含まれる場合は SPAN_WHITESPACE_BOUNDARY を投げる', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 4, role: 'S' }, // "The "
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe(
        'SPAN_WHITESPACE_BOUNDARY',
      );
    }
  });

  it('単語の途中で分断する start/end は SPAN_WORD_BOUNDARY を投げる', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 4, end: 7, role: 'S' }, // "met" of "method"
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 1,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('SPAN_WORD_BOUNDARY');
    }
  });

  it('同一範囲の重複スパンは SPAN_DUPLICATE を投げる', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 10, role: 'S', bracket: 'noun' },
          { start: 0, end: 10, role: 'modifier', bracket: 'adj' },
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('SPAN_DUPLICATE');
    }
  });

  it('交差するスパンは SPAN_CROSSING_OVERLAP を投げる', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 15, role: 'S', bracket: 'noun' }, // "The method that"
          { start: 11, end: 26, role: 'modifier', bracket: 'adj' }, // "that we propose"
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe(
        'SPAN_CROSSING_OVERLAP',
      );
    }
  });

  it('未定義の構文ID（例: 旧表記 past_participle_modifier）を拒否する', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 10, role: 'S' },
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: ['past_participle_modifier'],
        difficulty: 3,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('INVALID_CONSTRUCT');
    }
  });

  it('自己参照や範囲外の modifies を拒否する', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 10, role: 'modifier', bracket: 'adj', modifies: 0 },
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('INVALID_MODIFIES');
    }
  });

  it('role が modifier なのに bracket がないスパンは INVALID_BRACKET で拒否する', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 26, role: 'S', bracket: 'noun' },
          { start: 11, end: 26, role: 'modifier', modifies: 0 },
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: ['relative_clause'],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('INVALID_BRACKET');
    }
  });

  it('difficulty が 1〜5 以外のときは INVALID_DIFFICULTY を投げる', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 10, role: 'S' },
          { start: 27, end: 35, role: 'V' },
        ],
        constructs: [],
        difficulty: 6,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('INVALID_DIFFICULTY');
    }
  });
});

describe('validateAnalysis（文法整合チェック）', () => {
  it('実機の誤り（S に achieves が含まれ主節の V がない）を MISSING_MAIN_VERB で検出する', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 35, role: 'S', bracket: 'noun' }, // "The method that we propose achieves"
          { start: 11, end: 35, role: 'modifier', bracket: 'adj', modifies: 0 },
          { start: 27, end: 35, role: 'V' }, // S かつ modifier に含まれている
          { start: 36, end: 51, role: 'O', bracket: 'noun' },
        ],
        constructs: ['relative_clause'],
        difficulty: 3,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('MISSING_MAIN_VERB');
    }
  });

  it('V がまったくない場合も MISSING_MAIN_VERB で検出する', () => {
    try {
      validateAnalysis(SENTENCE, {
        spans: [
          { start: 0, end: 26, role: 'S', bracket: 'noun' },
          { start: 36, end: 51, role: 'O', bracket: 'noun' },
        ],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('MISSING_MAIN_VERB');
    }
  });

  it('名詞節の主語（What the results suggest is ...）で S の中に V があっても主節 V が外にあれば許可する', () => {
    const s = 'What the results suggest is clear.';
    const res = validateAnalysis(s, {
      spans: [
        { start: 0, end: 24, role: 'S', bracket: 'noun' }, // What the results suggest
        { start: 17, end: 24, role: 'V' }, // suggest（S の内部の V）
        { start: 25, end: 27, role: 'V' }, // is（主節の V）
        { start: 28, end: 33, role: 'C' }, // clear
      ],
      constructs: ['long_subject'],
      difficulty: 3,
    });

    expect(findMainVerbSpans(res.spans)).toEqual([
      { start: 25, end: 27, role: 'V' },
    ]);
  });

  it('形式主語 it（It is known that ...）で that 節 S の中に V があっても許可する', () => {
    const s = 'It is known that the model works well.';
    const res = validateAnalysis(s, {
      spans: [
        { start: 0, end: 2, role: 'S' }, // It
        { start: 3, end: 5, role: 'V' }, // is（主節の V）
        { start: 6, end: 11, role: 'C' }, // known
        { start: 12, end: 37, role: 'S', bracket: 'noun' }, // that the model works well
        { start: 27, end: 32, role: 'V' }, // works（that 節 S 内の V）
      ],
      constructs: ['formal_it'],
      difficulty: 3,
    });

    expect(findMainVerbSpans(res.spans)).toEqual([
      { start: 3, end: 5, role: 'V' },
    ]);
  });

  it('並列動詞（We collected and analyzed the data.）は coordination が含まれていれば複数 V を許可する', () => {
    const s = 'We collected and analyzed the data.';
    const res = validateAnalysis(s, {
      spans: [
        { start: 0, end: 2, role: 'S' }, // We
        { start: 3, end: 12, role: 'V' }, // collected
        { start: 17, end: 25, role: 'V' }, // analyzed
        { start: 26, end: 34, role: 'O', bracket: 'noun' }, // the data
      ],
      constructs: ['coordination'],
      difficulty: 2,
    });

    expect(findMainVerbSpans(res.spans)).toHaveLength(2);
  });

  it('coordination がないのに主節 V が 2 つ以上ある場合は MULTIPLE_MAIN_VERBS を投げる', () => {
    const s = 'We collected and analyzed the data.';
    try {
      validateAnalysis(s, {
        spans: [
          { start: 0, end: 2, role: 'S' },
          { start: 3, end: 12, role: 'V' },
          { start: 17, end: 25, role: 'V' },
          { start: 26, end: 34, role: 'O', bracket: 'noun' },
        ],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('MULTIPLE_MAIN_VERBS');
    }
  });
});
