import { describe, expect, it } from 'vitest';
import { formatLabelsReviewMarkdown } from '../src/eval/labels-review';
import type { EvalSentenceItem } from '../src/eval/metrics';
import devSentencesRaw from './eval/dev-sentences.json';
import testSentencesRaw from './eval/sentences.json';

const testSentences = testSentencesRaw as EvalSentenceItem[];
const devSentences = devSentencesRaw as EvalSentenceItem[];

describe('eval/labels-review.ts', () => {
  it('各文の ID・英文解釈の複数行記法・constructs を含む Markdown を生成する', () => {
    const md = formatLabelsReviewMarkdown([
      {
        title: '本番評価セット',
        sourcePath: 'tests/eval/sentences.json',
        items: testSentences.slice(0, 1),
      },
      {
        title: 'プロンプト調整セット',
        sourcePath: 'tests/eval/dev-sentences.json',
        items: devSentences.slice(0, 1),
      },
    ]);

    expect(md).toContain('### eval-01');
    expect(md).toContain('[The experiment] S\n  confirms V\n  [our initial hypothesis] O.');
    expect(md).toContain('なし（`[]`）');

    expect(md).toContain('### dev-01');
    expect(md).toContain(
      [
        '[The method (that we propose)] S',
        '  achieves V',
        '  [higher accuracy] O',
        '  <than existing approaches (trained on larger datasets)>.',
      ].join('\n'),
    );
    expect(md).toContain('`relative_clause`（関係詞節）');
    expect(md).toContain('`comparative`（比較構文）');
    expect(md).toContain('`participle_modifier`（分詞の後置修飾）');
  });
});
