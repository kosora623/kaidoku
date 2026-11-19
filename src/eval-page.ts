import devSentencesRaw from '../tests/eval/dev-sentences.json';
import testSentencesRaw from '../tests/eval/sentences.json';
import {
  aggregateEvalReport,
  formatComparisonMarkdown,
  scoreItem,
  type EvalItemResult,
  type EvalProviderReport,
  type EvalSentenceItem,
} from './eval/metrics';
import type {
  AnalyzeResult,
  AnalyzeTiming,
  NanoPromptMode,
  RetryErrorRecord,
} from './types';

const TEST_DATASET = testSentencesRaw as EvalSentenceItem[];
const DEV_DATASET = devSentencesRaw as EvalSentenceItem[];

const datasetSelect = document.getElementById('dataset-select') as HTMLSelectElement;
const nanoModeSelect = document.getElementById('nano-mode-select') as HTMLSelectElement;
const startBtn = document.getElementById('start-eval-btn') as HTMLButtonElement;
const compareDevBtn = document.getElementById('compare-dev-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-eval-btn') as HTMLButtonElement;
const downloadBtn = document.getElementById('download-json-btn') as HTMLButtonElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLDivElement;
const summarySection = document.getElementById('summary-section') as HTMLElement;
const summaryGrid = document.getElementById('summary-grid') as HTMLDivElement;
const markdownOutput = document.getElementById('markdown-output') as HTMLPreElement;
const resultsTbody = document.getElementById('results-tbody') as HTMLTableSectionElement;

let abortRequested = false;
let latestReports: Array<{ filename: string; report: EvalProviderReport }> = [];

interface SwAnalyzeResponse {
  ok: boolean;
  data?: AnalyzeResult;
  error?: string;
  errorCode?: string;
  rawOutput?: unknown;
  rawText?: string;
  attempts?: number;
  firstAttemptError?: RetryErrorRecord;
  timing?: AnalyzeTiming;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function appendRow(modeLabel: string, item: EvalItemResult): void {
  const tr = document.createElement('tr');

  const statusHtml = item.ok
    ? `<span class="tag-ok">OK</span> (${item.attempts}回)`
    : `<span class="tag-ng">NG</span> (${item.attempts}回)`;

  const svHtml = item.ok
    ? `${item.scores.sExact ? '<span class="tag-ok">S○</span>' : '<span class="tag-ng">S×</span>'} / ${item.scores.vExact ? '<span class="tag-ok">V○</span>' : '<span class="tag-ng">V×</span>'}`
    : '—';

  const note = item.validationError
    ? `${item.validationError.code}: ${item.validationError.message}`
    : item.firstAttemptError
      ? `初回失敗(${item.firstAttemptError.code}) → 再試行で回復`
      : '';

  const cells = [
    modeLabel,
    item.id,
    item.category,
    statusHtml,
    svHtml,
    item.ok ? pct(item.scores.spanStrictF1) : '0.0%',
    item.ok ? pct(item.scores.constructF1) : '0.0%',
    `${item.timing.sessionCreateMs} ms`,
    `${item.timing.analyzeMs} ms`,
    note,
  ];

  for (let i = 0; i < cells.length; i++) {
    const td = document.createElement('td');
    if (i === 3 || i === 4) {
      td.innerHTML = cells[i];
    } else {
      td.textContent = cells[i];
      if (i === 9) td.className = 'mono-small';
    }
    tr.appendChild(td);
  }

  resultsTbody.appendChild(tr);
}

function renderSummary(reports: EvalProviderReport[]): void {
  summarySection.classList.remove('hidden');
  summaryGrid.innerHTML = '';

  const primary = reports[reports.length - 1];
  if (primary) {
    const boxes: Array<[string, string]> = [
      ['検証通過率', `${pct(primary.validRate)} (${primary.validCount}/${primary.totalCount})`],
      ['S 一致率', pct(primary.sExactRate)],
      ['主節 V 一致率', pct(primary.vExactRate)],
      ['S・V 両方一致率', pct(primary.svExactRate)],
      ['スパン F1（厳密）', pct(primary.spanStrictF1)],
      ['構文検出 F1', pct(primary.constructF1)],
      ['土台セッション作成', `${primary.timingSummary.sessionCreateMs} ms`],
      ['初回（1文目）解析', `${primary.timingSummary.firstAnalyzeMs ?? '—'} ms`],
      ['2回目以降 平均解析', `${primary.timingSummary.subsequentAvgMs ?? '—'} ms`],
    ];

    for (const [label, value] of boxes) {
      const box = document.createElement('div');
      box.className = 'summary-box';
      const l = document.createElement('div');
      l.className = 'summary-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'summary-val';
      v.textContent = value;
      box.appendChild(l);
      box.appendChild(v);
      summaryGrid.appendChild(box);
    }
  }

  markdownOutput.textContent = formatComparisonMarkdown(reports);
}

async function runSinglePass(
  dataset: EvalSentenceItem[],
  datasetName: 'test' | 'dev',
  nanoPromptMode: NanoPromptMode,
  progressOffset: number,
  totalSteps: number,
): Promise<EvalProviderReport> {
  const modeLabel = nanoPromptMode === 'two-stage' ? '2段階' : '1段階';

  // 初回土台作成時間を正確に測るため Service Worker のキャッシュ済み土台セッションをリセット
  await chrome.runtime.sendMessage({ type: 'RESET_NANO_SESSION' });

  const items: EvalItemResult[] = [];

  for (let idx = 0; idx < dataset.length; idx++) {
    if (abortRequested) break;

    const entry = dataset[idx];
    const stepNo = progressOffset + idx + 1;
    progressText.textContent = `[${modeLabel}] 解析中 (${stepNo}/${totalSteps}): ${entry.id} — ${entry.text.slice(0, 55)}...`;

    const startedAt = performance.now();
    let res: SwAnalyzeResponse;
    try {
      res = (await chrome.runtime.sendMessage({
        type: 'ANALYZE_SENTENCE',
        sentence: entry.text,
        preferredProvider: 'nano',
        nanoPromptMode,
        allowNanoDownload: true,
      })) as SwAnalyzeResponse;
    } catch (err) {
      res = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: 'RUNTIME_ERROR',
      };
    }

    const fallbackElapsed = Math.round(performance.now() - startedAt);
    let itemResult: EvalItemResult;

    if (res?.ok && res.data) {
      const scores = scoreItem(entry.expected, res.data.analysis, entry.text);
      itemResult = {
        id: entry.id,
        category: entry.category,
        text: entry.text,
        ok: true,
        attempts: res.data.attempts,
        timing: res.data.timing,
        analysis: res.data.analysis,
        rawText: res.data.rawText,
        ...(res.data.firstAttemptError
          ? { firstAttemptError: res.data.firstAttemptError }
          : {}),
        scores,
      };
    } else {
      const timing: AnalyzeTiming = res?.timing ?? {
        sessionCreateMs: 0,
        analyzeMs: fallbackElapsed,
        totalMs: fallbackElapsed,
      };
      itemResult = {
        id: entry.id,
        category: entry.category,
        text: entry.text,
        ok: false,
        attempts: res?.attempts ?? 1,
        timing,
        rawText: res?.rawText,
        validationError: {
          code: res?.errorCode ?? 'ERROR',
          message: res?.error ?? '不明なエラー',
          rawOutput: res?.rawOutput,
        },
        ...(res?.firstAttemptError
          ? { firstAttemptError: res.firstAttemptError }
          : {}),
        scores: scoreItem(entry.expected, undefined, entry.text),
      };
    }

    items.push(itemResult);
    appendRow(modeLabel, itemResult);

    const progressPct = Math.round((stepNo / totalSteps) * 100);
    progressFill.style.width = `${progressPct}%`;
  }

  return aggregateEvalReport(
    {
      provider: 'nano',
      modelName:
        nanoPromptMode === 'two-stage'
          ? 'Gemini Nano (2段階)'
          : 'Gemini Nano (1段階)',
      datasetName,
    },
    items,
  );
}

function setRunningUi(running: boolean): void {
  startBtn.disabled = running;
  compareDevBtn.disabled = running;
  datasetSelect.disabled = running;
  nanoModeSelect.disabled = running;
  stopBtn.classList.toggle('hidden', !running);
  if (running) {
    downloadBtn.disabled = true;
    summarySection.classList.add('hidden');
    resultsTbody.innerHTML = '';
    progressFill.style.width = '0%';
  }
}

async function runEvaluation(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    progressText.textContent =
      '拡張機能コンテキスト外では実行できません。dist/ を Chrome に読み込んで開いてください。';
    return;
  }

  const datasetName = datasetSelect.value === 'dev' ? 'dev' : 'test';
  const nanoPromptMode: NanoPromptMode =
    nanoModeSelect.value === 'two-stage' ? 'two-stage' : 'one-stage';
  const dataset = datasetName === 'dev' ? DEV_DATASET : TEST_DATASET;

  abortRequested = false;
  latestReports = [];
  setRunningUi(true);
  progressText.textContent = '土台セッションを初期化しています...';

  const report = await runSinglePass(
    dataset,
    datasetName,
    nanoPromptMode,
    0,
    dataset.length,
  );

  const filename =
    datasetName === 'dev'
      ? nanoPromptMode === 'two-stage'
        ? 'nano-dev-2stage-results.json'
        : 'nano-dev-1stage-results.json'
      : 'nano-results.json';

  latestReports = [{ filename, report }];
  renderSummary([report]);

  progressText.textContent = abortRequested
    ? `中断しました（${report.totalCount}/${dataset.length} 文まで集計済み）`
    : `完了しました（${report.totalCount}/${dataset.length} 文）。「結果 JSON を書き出す」から保存できます。`;

  setRunningUi(false);
  downloadBtn.disabled = report.totalCount === 0;
}

/** dev-sentences.json（10文）だけで 1段階 vs 2段階 を連続比較実行する */
async function runDevComparison(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    progressText.textContent =
      '拡張機能コンテキスト外では実行できません。dist/ を Chrome に読み込んで開いてください。';
    return;
  }

  datasetSelect.value = 'dev';
  abortRequested = false;
  latestReports = [];
  setRunningUi(true);

  const totalSteps = DEV_DATASET.length * 2;
  progressText.textContent =
    'dev-sentences.json（10文）で 1段階 vs 2段階 比較を開始します...';

  const report1 = await runSinglePass(
    DEV_DATASET,
    'dev',
    'one-stage',
    0,
    totalSteps,
  );
  latestReports.push({
    filename: 'nano-dev-1stage-results.json',
    report: report1,
  });

  if (!abortRequested) {
    const report2 = await runSinglePass(
      DEV_DATASET,
      'dev',
      'two-stage',
      DEV_DATASET.length,
      totalSteps,
    );
    latestReports.push({
      filename: 'nano-dev-2stage-results.json',
      report: report2,
    });
  }

  renderSummary(latestReports.map((r) => r.report));
  progressText.textContent = abortRequested
    ? '比較実行を中断しました。'
    : 'dev 10文の 1段階 vs 2段階 比較が完了しました。「結果 JSON を書き出す」で両結果を保存できます。';

  setRunningUi(false);
  downloadBtn.disabled = latestReports.length === 0;
}

function downloadReportJson(): void {
  if (latestReports.length === 0) return;
  for (const { filename, report } of latestReports) {
    const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

startBtn.addEventListener('click', () => {
  void runEvaluation();
});

compareDevBtn.addEventListener('click', () => {
  void runDevComparison();
});

stopBtn.addEventListener('click', () => {
  abortRequested = true;
  progressText.textContent = '現在の文が完了次第、中断します...';
});

downloadBtn.addEventListener('click', downloadReportJson);
