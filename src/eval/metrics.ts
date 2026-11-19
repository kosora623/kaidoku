import {
  findMainVerbSpans,
  normalizeSingleWordSocBrackets,
} from '../ai/schema';
import { getConstructLabelJa } from '../lang/en/constructs';
import { formatNotationText } from '../notation';
import type {
  AiProvider,
  Analysis,
  AnalysisSpan,
  AnalyzeTiming,
  ConstructId,
  RetryErrorRecord,
} from '../types';

/** 評価データセットの 1 文エントリ */
export interface EvalSentenceItem {
  id: string;
  category: string;
  text: string;
  /** 出典 URL（実論文から抽出した長文データセット等で使用） */
  sourceUrl?: string;
  expected: Analysis;
}

/** 1 文ごとの採点結果 */
export interface EvalItemScore {
  sExact: boolean;
  vExact: boolean;
  svExact: boolean;
  spanStrictPrecision: number;
  spanStrictRecall: number;
  spanStrictF1: number;
  spanRoleF1: number;
  spanExactMatch: boolean;
  constructPrecision: number;
  constructRecall: number;
  constructF1: number;
  constructExactMatch: boolean;
}

/** 1 文ごとの実行・採点ログ（生出力と検証エラーを必ず保持） */
export interface EvalItemResult {
  id: string;
  category: string;
  text: string;
  ok: boolean;
  attempts: number;
  timing: AnalyzeTiming;
  analysis?: Analysis;
  /** AI が返した生のテキスト（誤り分析用） */
  rawText?: string;
  /** バリデーションまたは実行エラー詳細 */
  validationError?: {
    code: string;
    message: string;
    rawOutput?: unknown;
  };
  /** 1 回再試行した場合の初回失敗内容 */
  firstAttemptError?: RetryErrorRecord;
  scores: EvalItemScore;
}

/** 所要時間の集計（土台作成・初回・2回目以降を分離） */
export interface EvalTimingSummary {
  /** 初回の土台セッション作成時間（ms） */
  sessionCreateMs: number;
  /** 初回（1文目）の解析時間（ms） */
  firstAnalyzeMs: number | null;
  /** 初回（1文目）の合計時間（ms） */
  firstTotalMs: number | null;
  /** 2文目以降の件数 */
  subsequentCount: number;
  /** 2文目以降の平均解析時間（ms） */
  subsequentAvgMs: number | null;
  /** 2文目以降の中央値解析時間（ms） */
  subsequentMedianMs: number | null;
  /** 2文目以降の最小解析時間（ms） */
  subsequentMinMs: number | null;
  /** 2文目以降の最大解析時間（ms） */
  subsequentMaxMs: number | null;
}

/** 評価対象データセット名 */
export type EvalDatasetName = 'test' | 'dev' | 'long' | 'long-dev';

/** 1 プロバイダ（Nano / Cloud）の評価レポート全体 */
export interface EvalProviderReport {
  provider: AiProvider;
  modelName: string;
  datasetName: EvalDatasetName;
  executedAt: string;
  totalCount: number;
  validCount: number;
  validRate: number;
  retriedCount: number;
  sExactRate: number;
  vExactRate: number;
  svExactRate: number;
  spanStrictF1: number;
  spanRoleF1: number;
  spanExactRate: number;
  constructF1: number;
  constructExactRate: number;
  timingSummary: EvalTimingSummary;
  items: EvalItemResult[];
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function calcSetPrf(
  expected: Set<string>,
  predicted: Set<string>,
): { precision: number; recall: number; f1: number; exact: boolean } {
  if (expected.size === 0 && predicted.size === 0) {
    return { precision: 1, recall: 1, f1: 1, exact: true };
  }
  if (expected.size === 0 || predicted.size === 0) {
    return { precision: 0, recall: 0, f1: 0, exact: false };
  }
  let tp = 0;
  for (const item of predicted) {
    if (expected.has(item)) tp += 1;
  }
  const precision = tp / predicted.size;
  const recall = tp / expected.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    exact: tp === expected.size && tp === predicted.size,
  };
}

/** 比較用にスパン末尾の非制限カンマ（例: ", which ...," の末尾 ","）だけを除いた終了位置を返す */
function normalizedEnd(span: AnalysisSpan, sentence?: string): number {
  if (!sentence) return span.end;
  let end = span.end;
  while (end > span.start && sentence[end - 1] === ',') {
    end -= 1;
  }
  return end;
}

function rangeKey(span: AnalysisSpan, sentence?: string): string {
  return `${span.start}:${normalizedEnd(span, sentence)}`;
}

function roleSpanKey(span: AnalysisSpan, sentence?: string): string {
  return `${span.start}:${normalizedEnd(span, sentence)}:${span.role}`;
}

function strictSpanKey(span: AnalysisSpan, sentence?: string): string {
  return `${span.start}:${normalizedEnd(span, sentence)}:${span.role}:${span.bracket ?? ''}`;
}

const CLAUSE_ELEMENT_ROLES = new Set(['S', 'V', 'O', 'C']);
const SOC_CONTAINER_ROLES = new Set(['S', 'O', 'C']);

/**
 * 採点対象のスパンを抽出する。
 * S・O・C のスパンの内側（厳密包含）にある S・V・O・C は無視し、
 * 外側の主要素と入れ子の修飾（modifier）スパンのみを採点対象にする。
 */
export function filterScoringSpans(spans: AnalysisSpan[]): AnalysisSpan[] {
  return spans.filter((span) => {
    if (!CLAUSE_ELEMENT_ROLES.has(span.role)) {
      return true;
    }
    const insideSoc = spans.some(
      (other) =>
        other !== span &&
        SOC_CONTAINER_ROLES.has(other.role) &&
        other.start <= span.start &&
        span.end <= other.end,
    );
    return !insideSoc;
  });
}

/** 1 文の予測結果と正解を比較採点する */
export function scoreItem(
  expected: Analysis,
  predicted: Analysis | undefined,
  sentence?: string,
): EvalItemScore {
  if (!predicted) {
    return {
      sExact: false,
      vExact: false,
      svExact: false,
      spanStrictPrecision: 0,
      spanStrictRecall: 0,
      spanStrictF1: 0,
      spanRoleF1: 0,
      spanExactMatch: false,
      constructPrecision: 0,
      constructRecall: 0,
      constructF1: 0,
      constructExactMatch: false,
    };
  }

  const rawExpSpans = filterScoringSpans(expected.spans);
  const rawPredSpans = filterScoringSpans(predicted.spans);
  const expSpans = sentence
    ? normalizeSingleWordSocBrackets(sentence, rawExpSpans)
    : rawExpSpans;
  const predSpans = sentence
    ? normalizeSingleWordSocBrackets(sentence, rawPredSpans)
    : rawPredSpans;

  const expS = new Set(
    expSpans
      .filter((s) => s.role === 'S')
      .map((s) => rangeKey(s, sentence)),
  );
  const predS = new Set(
    predSpans
      .filter((s) => s.role === 'S')
      .map((s) => rangeKey(s, sentence)),
  );
  const sExact = setEquals(expS, predS);

  const expV = new Set(
    findMainVerbSpans(expSpans).map((s) => rangeKey(s, sentence)),
  );
  const predV = new Set(
    findMainVerbSpans(predSpans).map((s) => rangeKey(s, sentence)),
  );
  const vExact = setEquals(expV, predV);

  const strict = calcSetPrf(
    new Set(expSpans.map((s) => strictSpanKey(s, sentence))),
    new Set(predSpans.map((s) => strictSpanKey(s, sentence))),
  );
  const roleOnly = calcSetPrf(
    new Set(expSpans.map((s) => roleSpanKey(s, sentence))),
    new Set(predSpans.map((s) => roleSpanKey(s, sentence))),
  );
  const constructs = calcSetPrf(
    new Set(expected.constructs),
    new Set(predicted.constructs),
  );

  return {
    sExact,
    vExact,
    svExact: sExact && vExact,
    spanStrictPrecision: strict.precision,
    spanStrictRecall: strict.recall,
    spanStrictF1: strict.f1,
    spanRoleF1: roleOnly.f1,
    spanExactMatch: strict.exact,
    constructPrecision: constructs.precision,
    constructRecall: constructs.recall,
    constructF1: constructs.f1,
    constructExactMatch: constructs.exact,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 全文の実行結果からプロバイダ単位の評価レポートを集計する */
export function aggregateEvalReport(
  meta: {
    provider: AiProvider;
    modelName: string;
    datasetName: EvalDatasetName;
    executedAt?: string;
  },
  items: EvalItemResult[],
): EvalProviderReport {
  const totalCount = items.length;
  const validCount = items.filter((i) => i.ok).length;
  const retriedCount = items.filter((i) => i.attempts > 1).length;

  const first = items[0];
  const subsequentAnalyze = items.slice(1).map((i) => i.timing.analyzeMs);

  const timingSummary: EvalTimingSummary = {
    sessionCreateMs: first ? first.timing.sessionCreateMs : 0,
    firstAnalyzeMs: first ? first.timing.analyzeMs : null,
    firstTotalMs: first ? first.timing.totalMs : null,
    subsequentCount: subsequentAnalyze.length,
    subsequentAvgMs:
      subsequentAnalyze.length > 0 ? Math.round(avg(subsequentAnalyze)) : null,
    subsequentMedianMs: median(subsequentAnalyze),
    subsequentMinMs:
      subsequentAnalyze.length > 0 ? Math.min(...subsequentAnalyze) : null,
    subsequentMaxMs:
      subsequentAnalyze.length > 0 ? Math.max(...subsequentAnalyze) : null,
  };

  return {
    provider: meta.provider,
    modelName: meta.modelName,
    datasetName: meta.datasetName,
    executedAt: meta.executedAt ?? new Date().toISOString(),
    totalCount,
    validCount,
    validRate: totalCount > 0 ? validCount / totalCount : 0,
    retriedCount,
    sExactRate: avg(items.map((i) => (i.scores.sExact ? 1 : 0))),
    vExactRate: avg(items.map((i) => (i.scores.vExact ? 1 : 0))),
    svExactRate: avg(items.map((i) => (i.scores.svExact ? 1 : 0))),
    spanStrictF1: avg(items.map((i) => i.scores.spanStrictF1)),
    spanRoleF1: avg(items.map((i) => i.scores.spanRoleF1)),
    spanExactRate: avg(items.map((i) => (i.scores.spanExactMatch ? 1 : 0))),
    constructF1: avg(items.map((i) => i.scores.constructF1)),
    constructExactRate: avg(
      items.map((i) => (i.scores.constructExactMatch ? 1 : 0)),
    ),
    timingSummary,
    items,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function msLabel(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

/** 複数プロバイダの評価レポートを Markdown の比較表に整形する */
export function formatComparisonMarkdown(
  reports: EvalProviderReport[],
): string {
  if (reports.length === 0) {
    return '評価レポートがありません。';
  }

  const headers = reports.map((r) => `${r.provider === 'nano' ? 'Gemini Nano' : 'Cloud'} (${r.modelName})`);
  const sep = headers.map(() => '---');

  const rows: Array<[string, ...string[]]> = [
    ['対象文数', ...reports.map((r) => `${r.totalCount} 文 (${r.datasetName})`)],
    [
      '検証通過率（有効出力）',
      ...reports.map(
        (r) => `${pct(r.validRate)} (${r.validCount}/${r.totalCount}, 再試行 ${r.retriedCount}件)`,
      ),
    ],
    ['S 一致率', ...reports.map((r) => pct(r.sExactRate))],
    ['主節 V 一致率', ...reports.map((r) => pct(r.vExactRate))],
    ['S・V 両方一致率', ...reports.map((r) => pct(r.svExactRate))],
    ['スパン一致 F1（括弧含む厳密）', ...reports.map((r) => pct(r.spanStrictF1))],
    ['スパン一致 F1（role 基準）', ...reports.map((r) => pct(r.spanRoleF1))],
    ['スパン完全一致率', ...reports.map((r) => pct(r.spanExactRate))],
    ['構文検出 F1', ...reports.map((r) => pct(r.constructF1))],
    ['構文完全一致率', ...reports.map((r) => pct(r.constructExactRate))],
    [
      '土台セッション作成時間',
      ...reports.map((r) => `${r.timingSummary.sessionCreateMs} ms`),
    ],
    [
      '初回（1文目）解析時間',
      ...reports.map((r) => msLabel(r.timingSummary.firstAnalyzeMs)),
    ],
    [
      '初回（1文目）合計時間',
      ...reports.map((r) => msLabel(r.timingSummary.firstTotalMs)),
    ],
    [
      '2回目以降 平均解析時間',
      ...reports.map((r) => msLabel(r.timingSummary.subsequentAvgMs)),
    ],
    [
      '2回目以降 中央値解析時間',
      ...reports.map((r) => msLabel(r.timingSummary.subsequentMedianMs)),
    ],
  ];

  const lines = [
    `| 指標 | ${headers.join(' | ')} |`,
    `| --- | ${sep.join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];

  return lines.join('\n');
}

function formatConstructList(constructs: ConstructId[]): string {
  if (constructs.length === 0) return 'なし（`[]`）';
  return constructs
    .map((cid) => `\`${cid}\`（${getConstructLabelJa(cid)}）`)
    .join(', ');
}

/**
 * 正解と一致しなかった文ごとに「正解の記法」「予測の記法」「検証エラー」を並べた
 * 誤り分析用 Markdown（tests/eval/results/errors.md）を生成する。
 */
export function formatErrorAnalysisMarkdown(
  reports: EvalProviderReport[],
  dataset: EvalSentenceItem[],
): string {
  const byId = new Map(dataset.map((item) => [item.id, item]));
  // クラウドを先頭に並べて分析しやすくする
  const ordered = [...reports].sort((a, b) => {
    if (a.provider === b.provider) return 0;
    return a.provider === 'cloud' ? -1 : 1;
  });

  const lines: string[] = [
    '# χ読 誤り分析レポート',
    '',
    '正解と完全一致しなかった文（検証エラー・スパン不一致・構文不一致のいずれか）を一覧にしています。',
    '',
  ];

  for (const report of ordered) {
    const providerTitle =
      report.provider === 'cloud'
        ? `Cloud (${report.modelName})`
        : `Gemini Nano (${report.modelName})`;

    const mismatches = report.items.filter(
      (item) =>
        !item.ok ||
        !item.scores.spanExactMatch ||
        !item.scores.constructExactMatch,
    );

    lines.push(
      `## ${providerTitle}（不一致・エラー ${mismatches.length}/${report.totalCount} 文）`,
    );
    lines.push('');

    if (mismatches.length === 0) {
      lines.push('全件が正解と完全一致しました。');
      lines.push('');
      continue;
    }

    for (const item of mismatches) {
      const ref = byId.get(item.id);
      const statusSummary = item.ok
        ? `S:${item.scores.sExact ? '○' : '×'} / V:${item.scores.vExact ? '○' : '×'} / Span F1:${pct(item.scores.spanStrictF1)} / 構文 F1:${pct(item.scores.constructF1)}（試行 ${item.attempts}回）`
        : `検証失敗: \`${item.validationError?.code ?? 'ERROR'}\`（試行 ${item.attempts}回）`;

      lines.push(`### ${item.id}（カテゴリ: \`${item.category}\`）— ${statusSummary}`);
      lines.push('');
      lines.push(`> ${item.text}`);
      lines.push('');

      // 正解の記法
      lines.push('#### 正解の記法');
      if (ref) {
        lines.push('```text');
        lines.push(formatNotationText(ref.text, ref.expected, { multiline: true }));
        lines.push('```');
        lines.push(`- 正解 constructs: ${formatConstructList(ref.expected.constructs)}`);
      } else {
        lines.push('（参照データが見つかりません）');
      }
      lines.push('');

      // 予測の記法
      lines.push('#### 予測の記法');
      if (item.ok && item.analysis) {
        try {
          const predText = formatNotationText(item.text, item.analysis, {
            multiline: true,
          });
          lines.push('```text');
          lines.push(predText);
          lines.push('```');
        } catch (err) {
          lines.push(
            `（予測スパンの記法展開に失敗: ${err instanceof Error ? err.message : String(err)}）`,
          );
        }
        lines.push(`- 予測 constructs: ${formatConstructList(item.analysis.constructs)}`);
      } else {
        lines.push('（検証エラーのため予測記法は生成されませんでした）');
      }
      lines.push('');

      // 検証エラー・再試行情報
      lines.push('#### 検証エラー');
      if (item.validationError) {
        lines.push(
          `- **エラーコード**: \`${item.validationError.code}\``,
        );
        lines.push(`- **メッセージ**: ${item.validationError.message}`);
        if (item.firstAttemptError) {
          lines.push(
            `- **初回失敗**: \`${item.firstAttemptError.code}\` — ${item.firstAttemptError.message}`,
          );
        }
        if (item.rawText) {
          lines.push('- **AI 生出力**:');
          lines.push('```json');
          lines.push(item.rawText);
          lines.push('```');
        }
      } else if (item.firstAttemptError) {
        lines.push(
          `- 最終的には通過（初回 \`${item.firstAttemptError.code}\` で失敗 → 再試行で回復）`,
        );
      } else {
        lines.push('- なし（検証通過）');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
