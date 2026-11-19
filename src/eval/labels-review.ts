import { getConstructLabelJa } from '../lang/en/constructs';
import { formatNotationText } from '../notation';
import type { EvalSentenceItem } from './metrics';

export interface LabelReviewSection {
  title: string;
  sourcePath: string;
  items: EvalSentenceItem[];
}

/**
 * 評価データセットの正解ラベルを、人間がレビューしやすい Markdown 形式に変換する。
 * 各文に ID・カテゴリ・原文・英文解釈の複数行記法・constructs・修飾先対応を出力する。
 */
export function formatLabelsReviewMarkdown(
  sections: LabelReviewSection[],
): string {
  const lines: string[] = [
    '# χ読 評価データ正解ラベル確認シート',
    '',
    'このファイルは `npm run eval:labels` で自動生成されています。',
    '正解ラベルを修正する場合は `tests/eval/sentences.json` または `tests/eval/dev-sentences.json` を編集し、`npm run eval:labels` と `npm test` を再実行してください。',
    '',
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}（${section.items.length} 文）`);
    lines.push('');
    lines.push(`元ファイル: \`${section.sourcePath}\``);
    lines.push('');

    for (const item of section.items) {
      const notation = formatNotationText(item.text, item.expected, {
        multiline: true,
      });

      const constructsText =
        item.expected.constructs.length === 0
          ? 'なし（`[]`）'
          : item.expected.constructs
              .map((cid) => `\`${cid}\`（${getConstructLabelJa(cid)}）`)
              .join(', ');

      lines.push(
        `### ${item.id}（カテゴリ: \`${item.category}\` / 難易度: ${item.expected.difficulty}）`,
      );
      lines.push('');
      lines.push(`> ${item.text}`);
      lines.push('');
      lines.push('```text');
      lines.push(notation);
      lines.push('```');
      lines.push('');
      lines.push(`- **constructs**: ${constructsText}`);

      // 修飾スパンの modifies 先もテキストで確認できるように併記する
      const modPairs: string[] = [];
      for (let i = 0; i < item.expected.spans.length; i++) {
        const span = item.expected.spans[i];
        if (span.modifies !== undefined) {
          const target = item.expected.spans[span.modifies];
          const srcText = item.text.slice(span.start, span.end);
          const dstText = target
            ? item.text.slice(target.start, target.end)
            : `spans[${span.modifies}]`;
          modPairs.push(`\`${srcText}\` → \`${dstText}\``);
        }
      }
      if (modPairs.length > 0) {
        lines.push(`- **modifies**: ${modPairs.join(' / ')}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}
