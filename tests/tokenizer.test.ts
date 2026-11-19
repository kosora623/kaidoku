import { describe, expect, it } from 'vitest';
import { AnalysisValidationError } from '../src/ai/schema';
import {
  convertWordAnalysisToCharAnalysis,
  convertWordAnalysisToCharAnalysisWithRepairs,
  tokenizeWords,
} from '../src/ai/tokenizer';

const SPEC_SENTENCE =
  'The method that we propose achieves higher accuracy than existing approaches trained on larger datasets.';

describe('tokenizeWords', () => {
  it('SPEC.md の例文を 0 始まりの単語と正確な文字位置に分割する', () => {
    const tokens = tokenizeWords(SPEC_SENTENCE);

    expect(tokens.map((t) => t.text)).toEqual([
      'The',
      'method',
      'that',
      'we',
      'propose',
      'achieves',
      'higher',
      'accuracy',
      'than',
      'existing',
      'approaches',
      'trained',
      'on',
      'larger',
      'datasets',
    ]);

    for (const token of tokens) {
      expect(SPEC_SENTENCE.slice(token.start, token.end)).toBe(token.text);
    }
    expect(tokens[0]).toEqual({ index: 0, text: 'The', start: 0, end: 3 });
    expect(tokens[4]).toEqual({
      index: 4,
      text: 'propose',
      start: 19,
      end: 26,
    });
    expect(tokens[14]).toEqual({
      index: 14,
      text: 'datasets',
      start: 95,
      end: 103,
    });
  });

  it('短縮形・ハイフン複合語・小数パーセント・通貨・句読点を適切に扱う', () => {
    const sentence =
      'It\'s a state-of-the-art model achieving 98.5% accuracy (costing $100), right?';
    const tokens = tokenizeWords(sentence);

    expect(tokens.map((t) => t.text)).toEqual([
      "It's",
      'a',
      'state-of-the-art',
      'model',
      'achieving',
      '98.5%',
      'accuracy',
      'costing',
      '$100',
      'right',
    ]);

    for (const token of tokens) {
      expect(sentence.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it('全角ダッシュ等で繋がった単語も分割できる', () => {
    const sentence = 'The method—which we propose—works.';
    const tokens = tokenizeWords(sentence);
    expect(tokens.map((t) => t.text)).toEqual([
      'The',
      'method',
      'which',
      'we',
      'propose',
      'works',
    ]);
  });
});

describe('convertWordAnalysisToCharAnalysis', () => {
  it('mainVerbs と単語番号ベース spans を SPEC.md 準拠の文字位置ベース Analysis に変換する', () => {
    const raw = {
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [
        { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
        { startWord: 2, endWord: 4, role: 'modifier', bracket: 'adj', modifies: 0 },
        { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
        { startWord: 8, endWord: 14, role: 'modifier', bracket: 'adv', modifies: 2 },
        { startWord: 11, endWord: 14, role: 'modifier', bracket: 'adj', modifies: 3 },
      ],
      constructs: ['relative_clause', 'comparative', 'participle_modifier'],
      difficulty: 3,
    };

    const analysis = convertWordAnalysisToCharAnalysis(SPEC_SENTENCE, raw);

    expect(analysis.spans).toEqual([
      { start: 0, end: 26, role: 'S', bracket: 'noun' },
      { start: 11, end: 26, role: 'modifier', bracket: 'adj', modifies: 0 },
      { start: 36, end: 51, role: 'O', bracket: 'noun' },
      { start: 52, end: 103, role: 'modifier', bracket: 'adv', modifies: 2 },
      { start: 77, end: 103, role: 'modifier', bracket: 'adj', modifies: 3 },
      { start: 27, end: 35, role: 'V' },
    ]);

    // 5語主語なので long_subject は付かない
    expect(analysis.constructs).not.toContain('long_subject');
  });

  it('long_subject をコード側ルール（what/whether/動名詞/6語以上）で自動付与し、形式主語 it の後置 S には付けない', () => {
    const sWhat = 'What the results suggest is clear.';
    const aWhat = convertWordAnalysisToCharAnalysis(sWhat, {
      mainVerbs: [{ startWord: 4, endWord: 4 }],
      spans: [
        { startWord: 0, endWord: 3, role: 'S', bracket: 'noun' },
        { startWord: 5, endWord: 5, role: 'C' },
      ],
      constructs: [],
      difficulty: 3,
    });
    expect(aWhat.constructs).toContain('long_subject');

    const sGerund = 'Training large models takes time.';
    const aGerund = convertWordAnalysisToCharAnalysis(sGerund, {
      mainVerbs: [{ startWord: 3, endWord: 3 }],
      spans: [
        { startWord: 0, endWord: 2, role: 'S', bracket: 'noun' },
        { startWord: 4, endWord: 4, role: 'O', bracket: 'noun' },
      ],
      constructs: [],
      difficulty: 2,
    });
    expect(aGerund.constructs).toContain('long_subject');

    const sFormalIt =
      'It is well established that deeper networks require residual connections.';
    const aFormalIt = convertWordAnalysisToCharAnalysis(sFormalIt, {
      mainVerbs: [{ startWord: 1, endWord: 3 }],
      spans: [
        { startWord: 0, endWord: 0, role: 'S' },
        { startWord: 2, endWord: 2, role: 'modifier', bracket: 'adv' },
        { startWord: 4, endWord: 9, role: 'S', bracket: 'noun' },
      ],
      constructs: ['formal_it'],
      difficulty: 3,
    });
    expect(aFormalIt.constructs).toEqual(['formal_it']);
    // 受け身動詞の内側の modifier（well）は自動的に V スパンへ modifies 紐づけされる
    const wellSpan = aFormalIt.spans.find((s) => s.role === 'modifier');
    expect(wellSpan?.modifies).toBe(3);
  });

  it('mainVerbs が空または欠落している場合は MISSING_MAIN_VERB エラーにする', () => {
    try {
      convertWordAnalysisToCharAnalysis(SPEC_SENTENCE, {
        mainVerbs: [],
        spans: [{ startWord: 0, endWord: 4, role: 'S', bracket: 'noun' }],
        constructs: [],
        difficulty: 2,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe('MISSING_MAIN_VERB');
    }
  });

  it('endWord が単語数を超えている場合は WORD_INDEX_OUT_OF_RANGE エラーにする', () => {
    const raw = {
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [{ startWord: 0, endWord: 99, role: 'S', bracket: 'noun' }],
      constructs: [],
      difficulty: 1,
    };

    try {
      convertWordAnalysisToCharAnalysis(SPEC_SENTENCE, raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe(
        'WORD_INDEX_OUT_OF_RANGE',
      );
    }
  });

  it('startWord > endWord の場合は WORD_INDEX_OUT_OF_RANGE エラーにする', () => {
    const raw = {
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [{ startWord: 4, endWord: 2, role: 'S', bracket: 'noun' }],
      constructs: [],
      difficulty: 1,
    };

    expect(() => convertWordAnalysisToCharAnalysis(SPEC_SENTENCE, raw)).toThrow(
      AnalysisValidationError,
    );
  });

  it('変換後にスパンが交差している場合は SPAN_CROSSING_OVERLAP エラーにする', () => {
    const raw = {
      mainVerbs: [{ startWord: 6, endWord: 6 }],
      spans: [
        { startWord: 0, endWord: 3, role: 'S', bracket: 'noun' },
        { startWord: 2, endWord: 5, role: 'modifier', bracket: 'adj', modifies: 0 },
      ],
      constructs: [],
      difficulty: 2,
    };

    try {
      convertWordAnalysisToCharAnalysis(SPEC_SENTENCE, raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).code).toBe(
        'SPAN_CROSSING_OVERLAP',
      );
    }
  });

  it('スパン末尾が (Section 6)・(86 Hz)・カンマ入り引用で終わる場合に閉じ括弧 ")" まで含める', () => {
    const sentence =
      'We evaluate the model through post-training (Section 6) at 50 Hz rather than DAC (86 Hz) on LAMBADA (Paperno et al., 2016; Maynez et al., 2020).';
    const tokens = tokenizeWords(sentence);
    const idx = (word: string) => tokens.findIndex((t) => t.text === word);
    const secondHz = tokens.map((t) => t.text).lastIndexOf('Hz');

    const analysis = convertWordAnalysisToCharAnalysis(sentence, {
      mainVerbs: [{ startWord: idx('evaluate'), endWord: idx('evaluate') }],
      spans: [
        { startWord: idx('We'), endWord: idx('We'), role: 'S', bracket: 'noun' },
        { startWord: idx('the'), endWord: idx('model'), role: 'O', bracket: 'noun' },
        { startWord: idx('through'), endWord: idx('6'), role: 'modifier', bracket: 'adv' },
        { startWord: idx('rather'), endWord: secondHz, role: 'modifier', bracket: 'adv' },
        { startWord: idx('on'), endWord: idx('2020'), role: 'modifier', bracket: 'adv' },
      ],
      constructs: ['comparative'],
      difficulty: 3,
    });

    // 1語主語 "We" からは [ ] が外れる
    expect(analysis.spans[0]).toEqual({ start: 0, end: 2, role: 'S' });
    // "(Section 6)" の閉じ括弧まで含まれる
    expect(sentence.slice(analysis.spans[2].start, analysis.spans[2].end)).toBe(
      'through post-training (Section 6)',
    );
    // "(86 Hz)" の閉じ括弧まで含まれる
    expect(sentence.slice(analysis.spans[3].start, analysis.spans[3].end)).toBe(
      'rather than DAC (86 Hz)',
    );
    // カンマ・セミコロン入り引用 "(Paperno et al., 2016; Maynez et al., 2020)" の閉じ括弧まで含まれる
    expect(sentence.slice(analysis.spans[4].start, analysis.spans[4].end)).toBe(
      'on LAMBADA (Paperno et al., 2016; Maynez et al., 2020)',
    );
  });

  it('括弧が入れ子になる場合（Whisper (large-v2 (Radford et al., 2023))）でも対応する閉じ括弧をすべて含め、括弧内始まりのスパンは外側の ")" を奪わない', () => {
    const sentence =
      'We compare our system with Whisper (large-v2 (Radford et al., 2023)).';
    const tokens = tokenizeWords(sentence);
    const idx = (word: string) => tokens.findIndex((t) => t.text === word);

    const analysis = convertWordAnalysisToCharAnalysis(sentence, {
      mainVerbs: [{ startWord: idx('compare'), endWord: idx('compare') }],
      spans: [
        { startWord: idx('We'), endWord: idx('We'), role: 'S' },
        { startWord: idx('our'), endWord: idx('system'), role: 'O', bracket: 'noun' },
        { startWord: idx('with'), endWord: idx('2023'), role: 'modifier', bracket: 'adv' },
        // 括弧の内側から始まるスパン（"(" を含まないため ")" を取り込んではいけない）
        {
          startWord: idx('Radford'),
          endWord: idx('2023'),
          role: 'modifier',
          bracket: 'noun',
          modifies: 2,
        },
      ],
      constructs: [],
      difficulty: 3,
    });

    expect(sentence.slice(analysis.spans[2].start, analysis.spans[2].end)).toBe(
      'with Whisper (large-v2 (Radford et al., 2023))',
    );
    expect(sentence.slice(analysis.spans[3].start, analysis.spans[3].end)).toBe(
      'Radford et al., 2023',
    );
  });

  it('軽い検証エラー（不正な modifies・modifier の bracket 欠落）を自動修復し、修復ログを返す', () => {
    const sentence =
      'The vector of derivatives works well in practice.';
    const tokens = tokenizeWords(sentence);
    const idx = (word: string) => tokens.findIndex((t) => t.text === word);

    const { analysis, repaired } = convertWordAnalysisToCharAnalysisWithRepairs(
      sentence,
      {
        mainVerbs: [{ startWord: idx('works'), endWord: idx('works') }],
        spans: [
          { startWord: idx('The'), endWord: idx('derivatives'), role: 'S', bracket: 'noun' },
          // S の内側で bracket 欠落 → adj 補完、さらに自己参照 modifies: 1 → 除去
          { startWord: idx('of'), endWord: idx('derivatives'), role: 'modifier', modifies: 1 },
          // S/O/C 外で bracket 欠落 → adv 補完、さらに単語番号らしき範囲外 modifies: 31 → 除去
          { startWord: idx('well'), endWord: idx('well'), role: 'modifier', modifies: 31 },
          { startWord: idx('in'), endWord: idx('practice'), role: 'modifier', bracket: 'adv' },
        ],
        constructs: [],
        difficulty: 2,
      },
    );

    expect(repaired).toHaveLength(4);
    expect(analysis.spans[1].bracket).toBe('adj');
    expect(analysis.spans[1].modifies).toBeUndefined();
    expect(analysis.spans[2].bracket).toBe('adv');
    expect(analysis.spans[2].modifies).toBeUndefined();
  });
});
