import { describe, expect, it } from 'vitest';
import {
  buildNotationTree,
  formatNotationText,
  renderNotationHtml,
} from '../src/notation';
import type { Analysis } from '../src/types';

const SPEC_SENTENCE =
  'The method that we propose achieves higher accuracy than existing approaches trained on larger datasets.';

const SPEC_ANALYSIS: Analysis = {
  spans: [
    { start: 0, end: 26, role: 'S', bracket: 'noun' },
    { start: 11, end: 26, role: 'modifier', bracket: 'adj', modifies: 0 },
    { start: 27, end: 35, role: 'V' },
    { start: 36, end: 51, role: 'O', bracket: 'noun' },
    { start: 52, end: 103, role: 'modifier', bracket: 'adv', modifies: 3 },
    { start: 77, end: 103, role: 'modifier', bracket: 'adj', modifies: 4 },
  ],
  constructs: ['relative_clause', 'comparative', 'participle_modifier'],
  difficulty: 3,
};

describe('notation', () => {
  it('buildNotationTree が入れ子構造を正しく構築する', () => {
    const tree = buildNotationTree(SPEC_SENTENCE, SPEC_ANALYSIS);

    const spanNodes = tree.filter((n) => n.type === 'span');
    expect(spanNodes).toHaveLength(4);

    // 1つ目: [The method (that we propose)] S の中に (that we propose) が入れ子になっている
    const subjectNode = spanNodes[0];
    expect(subjectNode.type).toBe('span');
    if (subjectNode.type === 'span') {
      expect(subjectNode.span.role).toBe('S');
      expect(subjectNode.children).toHaveLength(2);
      expect(subjectNode.children[0]).toMatchObject({
        type: 'text',
        text: 'The method ',
      });
      expect(subjectNode.children[1]).toMatchObject({
        type: 'span',
        spanIndex: 1,
      });
    }
  });

  it('formatNotationText が 1 行形式で [ ] ( ) < > と S・V・O・C を出力する', () => {
    const text = formatNotationText(SPEC_SENTENCE, SPEC_ANALYSIS);
    expect(text).toBe(
      '[The method (that we propose)] S achieves V [higher accuracy] O <than existing approaches (trained on larger datasets)>.',
    );
  });

  it('formatNotationText({ multiline: true }) が SPEC.md と一致する複数行記法を出力する', () => {
    const text = formatNotationText(SPEC_SENTENCE, SPEC_ANALYSIS, {
      multiline: true,
    });
    expect(text).toBe(
      [
        '[The method (that we propose)] S',
        '  achieves V',
        '  [higher accuracy] O',
        '  <than existing approaches (trained on larger datasets)>.',
      ].join('\n'),
    );
  });

  it('spans が逆順で渡されても正しく入れ子を展開する', () => {
    const reversed: Analysis = {
      ...SPEC_ANALYSIS,
      spans: [...SPEC_ANALYSIS.spans].reverse().map((span) => ({
        start: span.start,
        end: span.end,
        role: span.role,
        ...(span.bracket ? { bracket: span.bracket } : {}),
      })),
    };

    expect(formatNotationText(SPEC_SENTENCE, reversed)).toBe(
      '[The method (that we propose)] S achieves V [higher accuracy] O <than existing approaches (trained on larger datasets)>.',
    );
  });

  it('C（補語）や括弧なしスパンを正しく表示する', () => {
    const sentence = 'The result seems important.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 10, role: 'S', bracket: 'noun' },
        { start: 11, end: 16, role: 'V' },
        { start: 17, end: 26, role: 'C' },
      ],
      constructs: [],
      difficulty: 1,
    };

    expect(formatNotationText(sentence, analysis)).toBe(
      '[The result] S seems V important C.',
    );
  });

  it('renderNotationHtml が括弧・役割バッジ・data-modifies を生成し HTML をエスケープする', () => {
    const html = renderNotationHtml(SPEC_SENTENCE, SPEC_ANALYSIS);

    expect(html).toContain('kaidoku-bracket-noun');
    expect(html).toContain('kaidoku-bracket-adj');
    expect(html).toContain('kaidoku-bracket-adv');
    expect(html).toContain('kaidoku-role-badge-S');
    expect(html).toContain('kaidoku-role-badge-V');
    expect(html).toContain('kaidoku-role-badge-O');
    expect(html).toContain('data-modifies="0"');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');

    // XSS になりうる特殊文字が確実にエスケープされること
    const xssSentence = 'A <script> works.';
    const xssAnalysis: Analysis = {
      spans: [
        { start: 0, end: 10, role: 'S', bracket: 'noun' },
        { start: 11, end: 16, role: 'V' },
      ],
      constructs: [],
      difficulty: 1,
    };
    const xssHtml = renderNotationHtml(xssSentence, xssAnalysis);
    expect(xssHtml).not.toContain('<script>');
    expect(xssHtml).toContain('&lt;script&gt;');
  });

  it('同格の that 節（role: modifier, bracket: noun）を [ ] で入れ子表示し、役割バッジを付けない', () => {
    const sentence =
      'The assumption that input tokens are independent breaks down in long documents.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 48, role: 'S', bracket: 'noun' },
        { start: 15, end: 48, role: 'modifier', bracket: 'noun', modifies: 0 },
        { start: 49, end: 60, role: 'V' },
        { start: 61, end: 78, role: 'modifier', bracket: 'adv', modifies: 2 },
      ],
      constructs: ['apposition', 'long_subject'],
      difficulty: 4,
    };

    expect(formatNotationText(sentence, analysis)).toBe(
      '[The assumption [that input tokens are independent]] S breaks down V <in long documents>.',
    );
    const html = renderNotationHtml(sentence, analysis);
    expect(html).toContain('kaidoku-role-modifier kaidoku-bracket-noun');
    expect(html).toContain('data-modifies="0"');
  });

  it('受け身の V の内側に副詞 < > を入れ子表示できる（is <well> established V）', () => {
    const sentence =
      'It is well established that deeper networks require residual connections.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 2, role: 'S' },
        { start: 3, end: 22, role: 'V' },
        { start: 6, end: 10, role: 'modifier', bracket: 'adv', modifies: 1 },
        { start: 23, end: 72, role: 'S', bracket: 'noun' },
      ],
      constructs: ['formal_it'],
      difficulty: 3,
    };

    expect(formatNotationText(sentence, analysis)).toBe(
      'It S is <well> established V [that deeper networks require residual connections] S.',
    );
  });

  it('非制限用法の関係詞節（カンマ付き）を正しく展開できる', () => {
    const sentence =
      'The results reported in Table 3, which were obtained without any task-specific tuning, suggest that the proposed objective is robust to label noise.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 86, role: 'S', bracket: 'noun' },
        { start: 12, end: 31, role: 'modifier', bracket: 'adj', modifies: 0 },
        { start: 33, end: 85, role: 'modifier', bracket: 'adj', modifies: 0 },
        { start: 87, end: 94, role: 'V' },
        { start: 95, end: 147, role: 'O', bracket: 'noun' },
      ],
      constructs: ['participle_modifier', 'relative_clause', 'long_subject'],
      difficulty: 5,
    };

    expect(formatNotationText(sentence, analysis)).toBe(
      '[The results (reported in Table 3), (which were obtained without any task-specific tuning),] S suggest V [that the proposed objective is robust to label noise] O.',
    );
  });

  it('主節が 2 つある文（倒置＋並列）を 1 行・複数行の両方で崩れず展開する（", but" のカンマを前行末に接続）', () => {
    const sentence =
      'Not only does the proposed method reduce memory usage, but it also improves the stability of training on long sequences.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 8, role: 'modifier', bracket: 'adv', modifies: 2 },
        { start: 14, end: 33, role: 'S', bracket: 'noun' },
        { start: 34, end: 40, role: 'V' },
        { start: 41, end: 53, role: 'O', bracket: 'noun' },
        { start: 59, end: 61, role: 'S', bracket: 'noun' },
        { start: 62, end: 66, role: 'modifier', bracket: 'adv', modifies: 6 },
        { start: 67, end: 75, role: 'V' },
        { start: 76, end: 119, role: 'O', bracket: 'noun' },
      ],
      constructs: ['inversion', 'coordination'],
      difficulty: 5,
    };

    expect(formatNotationText(sentence, analysis)).toBe(
      '<Not only> does [the proposed method] S reduce V [memory usage] O, but it S <also> improves V [the stability of training on long sequences] O.',
    );

    const multiline = formatNotationText(sentence, analysis, {
      multiline: true,
    });
    expect(multiline).toContain('  [memory usage] O,\n  but\n  it S');
  });

  it('renderNotationHtml({ clickableWords: true }) が単語をクリック可能スパンで包み、[MATH] はラップしない', () => {
    const sentence = 'We compute [MATH] quickly.';
    const analysis: Analysis = {
      spans: [
        { start: 0, end: 2, role: 'S' },
        { start: 3, end: 10, role: 'V' },
        { start: 11, end: 17, role: 'O' },
        { start: 18, end: 25, role: 'modifier', bracket: 'adv', modifies: 1 },
      ],
      constructs: [],
      difficulty: 1,
    };

    const html = renderNotationHtml(sentence, analysis, { clickableWords: true });
    expect(html).toContain('class="kaidoku-word" data-word="compute"');
    expect(html).toContain('class="kaidoku-word" data-word="quickly"');
    expect(html).not.toContain('data-word="MATH"');
    expect(html).toContain('[MATH]');
  });
});
