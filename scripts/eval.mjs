/**
 * npm run eval 実行スクリプト
 *
 * - .env.local の GEMINI_API_KEY からクラウド評価（gemini-3.1-flash-lite）を実行する
 *   （キーがない場合はクラウド評価のみスキップし、キーの値は一切ログや出力に残さない）
 * - 拡張内ページ eval.html で書き出した Nano 結果 JSON を読み込み、
 *   正解率・所要時間（土台作成 / 初回 / 2回目以降）の比較表を出力する
 *
 * 使い方:
 *   npm run eval
 *   npm run eval -- --dataset dev
 *   npm run eval -- --nano path/to/nano-results.json
 *   npm run eval -- --skip-cloud
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT_DIR = process.cwd();
const RESULTS_DIR = path.join(ROOT_DIR, 'tests', 'eval', 'results');

function parseArgs(argv) {
  let dataset = 'test';
  let mode = 'single';
  let cloudMode = 'auto';
  let compareStages = false;
  let nanoPath = null;
  let skipCloud = false;
  let reuseCloud = false;
  let cloudDelayMs = 4500;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset' && argv[i + 1]) {
      const val = argv[++i];
      if (val === 'dev' || val === 'long' || val === 'long-dev') {
        dataset = val;
      } else {
        dataset = 'test';
      }
    } else if (arg === '--mode' && argv[i + 1]) {
      mode = argv[++i] === 'batch' ? 'batch' : 'single';
    } else if (arg === '--cloud-mode' && argv[i + 1]) {
      const val = argv[++i];
      if (val === 'two-stage' || val === 'auto') {
        cloudMode = val;
      } else {
        cloudMode = 'one-stage';
      }
    } else if (arg === '--compare-stages') {
      compareStages = true;
    } else if (arg === '--nano' && argv[i + 1]) {
      nanoPath = path.resolve(argv[++i]);
    } else if (arg === '--skip-cloud') {
      skipCloud = true;
    } else if (arg === '--reuse-cloud') {
      reuseCloud = true;
    } else if (arg === '--cloud-delay-ms' && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed >= 0) {
        cloudDelayMs = parsed;
      }
    }
  }
  return {
    dataset,
    mode,
    cloudMode,
    compareStages,
    nanoPath,
    skipCloud,
    reuseCloud,
    cloudDelayMs,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP 429 メッセージから待機秒数を抽出する（取得できなければ 30 秒） */
function extractRateLimitWaitMs(message) {
  const match = message.match(/retry in\s+([0-9.]+)s/i);
  if (match) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.ceil((sec + 1) * 1000);
    }
  }
  return 30000;
}

/** TypeScript の拡張本体ロジックをメモリ/一時ファイル経由で読み込み、コード重複を防ぐ */
async function loadSharedModules() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaidoku-eval-bundle-'));
  const entryCode = `
    export { analyzeWithCloud, classifyBatchConstructsWithCloud, DEFAULT_CLOUD_MODEL } from './src/ai/cloud.ts';
    export { AnalysisValidationError } from './src/ai/schema.ts';
    export { convertWordAnalysisToCharAnalysis, convertWordAnalysisToCharAnalysisWithRepairs } from './src/ai/tokenizer.ts';
    export { calculateDifficultyAndMarkLevel } from './src/lang/en/difficulty.ts';
    export { scoreItem, aggregateEvalReport, formatComparisonMarkdown, formatErrorAnalysisMarkdown } from './src/eval/metrics.ts';
  `;
  const outFile = path.join(tmpDir, 'shared.mjs');

  await esbuild.build({
    stdin: {
      contents: entryCode,
      resolveDir: ROOT_DIR,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: outFile,
  });

  const mod = await import(pathToFileURL(outFile).href);
  return {
    mod,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** 保存済みの結果 JSON を読み込み、現在のトークナイザ・正規化・正解ラベルで最新スコアを再計算する */
function loadAndRescoreReport(filePath, provider, fallbackModel, dataset, datasetName, shared) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const byId = new Map(dataset.map((item) => [item.id, item]));
  const rescoredItems = (raw.items ?? []).map((item) => {
    const ref = byId.get(item.id);
    let analysis = item.analysis;
    let attempts = item.attempts;
    let firstAttemptError = item.firstAttemptError;
    let repaired = item.repaired;

    if (item.ok && ref) {
      let resolvedFromFirstAttempt = false;
      // 再試行が起きていた文について、初回 AI 生出力が自動修復で 1 回目通過できるかを再検証する
      if (item.firstAttemptError?.rawText) {
        try {
          const parsedFirst = JSON.parse(item.firstAttemptError.rawText);
          if (
            parsedFirst &&
            typeof parsedFirst === 'object' &&
            Array.isArray(parsedFirst.mainVerbs)
          ) {
            const converted = shared.convertWordAnalysisToCharAnalysisWithRepairs(
              ref.text,
              parsedFirst,
            );
            analysis = converted.analysis;
            attempts = 1;
            firstAttemptError = undefined;
            repaired = converted.repaired;
            resolvedFromFirstAttempt = true;
          }
        } catch {
          // 自動修復で直らないエラーは 2 回目出力の検証へ進む
        }
      }

      if (!resolvedFromFirstAttempt && item.rawText) {
        try {
          const parsed = JSON.parse(item.rawText);
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.mainVerbs)) {
            const converted = shared.convertWordAnalysisToCharAnalysisWithRepairs(
              ref.text,
              parsed,
            );
            analysis = converted.analysis;
            repaired = converted.repaired;
          }
        } catch {
          // 再変換に失敗した場合は保存済みの analysis をそのまま使う
        }
      }
    }

    const nextItem = {
      ...item,
      attempts,
      analysis,
      ...(repaired && repaired.length > 0 ? { repaired } : {}),
      scores: ref
        ? shared.scoreItem(ref.expected, analysis, ref.text)
        : item.scores,
    };
    if (!firstAttemptError) {
      delete nextItem.firstAttemptError;
    }
    return nextItem;
  });

  return shared.aggregateEvalReport(
    {
      provider,
      modelName: raw.modelName ?? fallbackModel,
      datasetName,
      executedAt: raw.executedAt,
    },
    rescoredItems,
  );
}

async function runCloudEval(
  dataset,
  datasetName,
  apiKey,
  shared,
  cloudDelayMs,
  cloudPromptMode = 'auto',
) {
  const items = [];
  const modeSuffix =
    cloudPromptMode === 'one-stage'
      ? ''
      : cloudPromptMode === 'two-stage'
        ? ' / 2段階'
        : ' / auto(25語+2段階)';
  console.log(
    `[Cloud] ${shared.DEFAULT_CLOUD_MODEL}${modeSuffix} で ${dataset.length} 文の評価を開始します（RPM 制御間隔: ${cloudDelayMs}ms）...`,
  );

  for (let i = 0; i < dataset.length; i++) {
    if (i > 0 && cloudDelayMs > 0) {
      await sleep(cloudDelayMs);
    }

    const entry = dataset[i];
    let done = false;
    let rateLimitRetries = 0;

    while (!done) {
      const startedAt = performance.now();
      try {
        const res = await shared.analyzeWithCloud(entry.text, apiKey, {
          cloudPromptMode,
        });
        const scores = shared.scoreItem(entry.expected, res.analysis, entry.text);
        items.push({
          id: entry.id,
          category: entry.category,
          text: entry.text,
          ok: true,
          attempts: res.attempts,
          timing: res.timing,
          analysis: res.analysis,
          rawText: res.rawText,
          ...(res.firstAttemptError
            ? { firstAttemptError: res.firstAttemptError }
            : {}),
          scores,
        });
        console.log(
          `  [${i + 1}/${dataset.length}] ${entry.id}: OK (S:${scores.sExact ? '○' : '×'} V:${scores.vExact ? '○' : '×'} F1:${(scores.spanStrictF1 * 100).toFixed(0)}% / ${res.timing.analyzeMs}ms${res.attempts > 1 ? ' / retry' : ''})`,
        );
        done = true;
      } catch (err) {
        const elapsed = Math.round(performance.now() - startedAt);
        const isVal = err instanceof shared.AnalysisValidationError;
        // 万一エラー文に API キーが含まれていてもマスクする
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = apiKey ? rawMsg.replaceAll(apiKey, '***') : rawMsg;

        // 無料枠の HTTP 429 レート制限・一時的な 503 過負荷時は待機して再試行する（最大2回）
        if (
          !isVal &&
          (safeMsg.includes('429') || safeMsg.includes('503')) &&
          rateLimitRetries < 2
        ) {
          rateLimitRetries += 1;
          const is503 = safeMsg.includes('503') && !safeMsg.includes('429');
          const waitMs = is503 ? 10000 : extractRateLimitWaitMs(safeMsg);
          console.log(
            `  [${i + 1}/${dataset.length}] ${entry.id}: 一時エラー (${is503 ? '503' : '429'}) のため ${Math.round(waitMs / 1000)} 秒待機して再試行します...`,
          );
          await sleep(waitMs);
          continue;
        }

        items.push({
          id: entry.id,
          category: entry.category,
          text: entry.text,
          ok: false,
          attempts: isVal && err.attempts ? err.attempts : 1,
          timing:
            isVal && err.timing
              ? err.timing
              : { sessionCreateMs: 0, analyzeMs: elapsed, totalMs: elapsed },
          rawText: isVal ? err.rawText : undefined,
          validationError: {
            code: isVal ? err.code : 'ERROR',
            message: safeMsg,
            rawOutput: isVal ? err.rawOutput : undefined,
          },
          ...(isVal && err.firstAttemptError
            ? { firstAttemptError: err.firstAttemptError }
            : {}),
          scores: shared.scoreItem(entry.expected, undefined),
        });
        console.log(
          `  [${i + 1}/${dataset.length}] ${entry.id}: NG (${isVal ? err.code : 'ERROR'} / ${elapsed}ms)`,
        );
        done = true;
      }
    }
  }

  return shared.aggregateEvalReport(
    {
      provider: 'cloud',
      modelName: `${shared.DEFAULT_CLOUD_MODEL}${modeSuffix}`,
      datasetName,
    },
    items,
  );
}

function calcConstructPrf(expected, predicted) {
  const expSet = new Set(expected);
  const predSet = new Set(predicted);
  if (expSet.size === 0 && predSet.size === 0) {
    return { precision: 1, recall: 1, f1: 1, exact: true };
  }
  if (expSet.size === 0 || predSet.size === 0) {
    return { precision: 0, recall: 0, f1: 0, exact: false };
  }
  let tp = 0;
  for (const c of predSet) {
    if (expSet.has(c)) tp += 1;
  }
  const precision = tp / predSet.size;
  const recall = tp / expSet.size;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    exact: tp === expSet.size && tp === predSet.size,
  };
}

/** --mode batch: 全文を 1 回のクラウド呼び出しで構文判定し、constructs 検出 F1 を計測する */
async function runBatchEvalMode(dataset, datasetName, apiKey, shared) {
  if (!apiKey) {
    console.log(
      '[Batch] .env.local に GEMINI_API_KEY が未設定のため、バッチ評価をスキップします。',
    );
    return;
  }

  console.log(
    `[Batch] ${shared.DEFAULT_CLOUD_MODEL} で ${dataset.length} 文を 1 回のバッチ呼び出しで構文判定します...`,
  );

  const batchInput = dataset.map((entry, idx) => ({
    id: idx,
    text: entry.text,
  }));

  const res = await shared.classifyBatchConstructsWithCloud(batchInput, apiKey);

  const items = dataset.map((entry, idx) => {
    const aiConstructs = res.constructsById.get(idx) ?? [];
    const computed = shared.calculateDifficultyAndMarkLevel(
      entry.text,
      aiConstructs,
    );
    const full = calcConstructPrf(entry.expected.constructs, computed.constructs);
    const aiOnly = calcConstructPrf(
      entry.expected.constructs.filter((c) => c !== 'long_subject'),
      aiConstructs,
    );

    return {
      id: entry.id,
      category: entry.category,
      text: entry.text,
      expectedConstructs: entry.expected.constructs,
      predictedAiConstructs: aiConstructs,
      predictedConstructs: computed.constructs,
      computedDifficulty: computed.difficulty,
      computedMarkLevel: computed.markLevel,
      precision: full.precision,
      recall: full.recall,
      f1: full.f1,
      exact: full.exact,
      aiOnlyF1: aiOnly.f1,
    };
  });

  const avg = (arr) =>
    arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  const summary = {
    mode: 'batch',
    modelName: res.modelName,
    datasetName,
    executedAt: new Date().toISOString(),
    totalCount: items.length,
    batchCallCount: 1,
    elapsedMs: res.elapsedMs,
    msPerSentence: Math.round(res.elapsedMs / Math.max(1, items.length)),
    constructPrecision: avg(items.map((i) => i.precision)),
    constructRecall: avg(items.map((i) => i.recall)),
    constructF1: avg(items.map((i) => i.f1)),
    constructExactRate: avg(items.map((i) => (i.exact ? 1 : 0))),
    aiOnlyConstructF1: avg(items.map((i) => i.aiOnlyF1)),
    rawText: res.rawText,
    items,
  };

  const outFile = path.join(
    RESULTS_DIR,
    datasetName === 'dev' ? 'batch-dev-results.json' : 'batch-results.json',
  );
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`[Batch] 結果を保存しました: ${path.relative(ROOT_DIR, outFile)}`);

  // 保存済みの 1文ずつ解析結果があれば横並び比較する
  const singleFile = path.join(
    RESULTS_DIR,
    datasetName === 'dev' ? 'cloud-dev-results.json' : 'cloud-results.json',
  );
  const singleReport = loadAndRescoreReport(
    singleFile,
    'cloud',
    shared.DEFAULT_CLOUD_MODEL,
    dataset,
    datasetName,
    shared,
  );

  const lines = [
    '| 指標 | 一括バッチ判定（1回呼び出し）' +
      (singleReport ? ' | 1文ずつ構造解析（30回呼び出し）' : '') +
      ' |',
    '| --- | ---' + (singleReport ? ' | ---' : '') + ' |',
    `| 対象文数 | ${summary.totalCount} 文 (${datasetName})` +
      (singleReport ? ` | ${singleReport.totalCount} 文 (${datasetName})` : '') +
      ' |',
    `| API 呼び出し回数 | 1 回` +
      (singleReport ? ` | ${singleReport.totalCount} 回` : '') +
      ' |',
    `| 構文検出 Precision | ${pct(summary.constructPrecision)}` +
      (singleReport ? ' | —' : '') +
      ' |',
    `| 構文検出 Recall | ${pct(summary.constructRecall)}` +
      (singleReport ? ' | —' : '') +
      ' |',
    `| 構文検出 F1（全10構文・long_subjectコード判定込み） | **${pct(summary.constructF1)}**` +
      (singleReport ? ` | **${pct(singleReport.constructF1)}**` : '') +
      ' |',
    `| 構文検出 F1（AI担当 9 構文のみ） | ${pct(summary.aiOnlyConstructF1)}` +
      (singleReport ? ' | —' : '') +
      ' |',
    `| 構文完全一致率 | ${pct(summary.constructExactRate)}` +
      (singleReport ? ` | ${pct(singleReport.constructExactRate)}` : '') +
      ' |',
    `| 合計所要時間 | ${summary.elapsedMs} ms（${summary.msPerSentence} ms/文）` +
      (singleReport
        ? ` | 中央値 ${singleReport.timingSummary.subsequentMedianMs} ms/文`
        : '') +
      ' |',
  ];

  console.log('\n=== バッチ構文判定 評価結果 ===\n');
  console.log(lines.join('\n'));

  const mismatches = items.filter((i) => !i.exact);
  if (mismatches.length > 0) {
    console.log(`\n不一致文 (${mismatches.length}/${items.length}):`);
    for (const m of mismatches) {
      console.log(
        `  - ${m.id}: 正解=[${m.expectedConstructs.join(', ')}] / 予測=[${m.predictedConstructs.join(', ')}]`,
      );
    }
  }
}

async function main() {
  const {
    dataset: datasetName,
    mode,
    cloudMode,
    compareStages,
    nanoPath,
    skipCloud,
    reuseCloud,
    cloudDelayMs,
  } = parseArgs(process.argv.slice(2));

  const datasetFileMap = {
    test: path.join(ROOT_DIR, 'tests', 'eval', 'sentences.json'),
    dev: path.join(ROOT_DIR, 'tests', 'eval', 'dev-sentences.json'),
    long: path.join(ROOT_DIR, 'tests', 'eval', 'long-sentences.json'),
    'long-dev': path.join(ROOT_DIR, 'tests', 'eval', 'long-dev-sentences.json'),
  };
  const datasetFile = datasetFileMap[datasetName] ?? datasetFileMap.test;

  const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const { mod: shared, cleanup } = await loadSharedModules();

  try {
    if (mode === 'batch') {
      const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
      await runBatchEvalMode(dataset, datasetName, apiKey, shared);
      return;
    }

    if (compareStages) {
      const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();
      if (!apiKey) {
        console.log(
          '[Cloud] .env.local に GEMINI_API_KEY が未設定のため、1段階 vs 2段階 比較をスキップします。',
        );
        return;
      }

      const report1 = await runCloudEval(
        dataset,
        datasetName,
        apiKey,
        shared,
        cloudDelayMs,
        'one-stage',
      );
      await sleep(cloudDelayMs);
      const report2 = await runCloudEval(
        dataset,
        datasetName,
        apiKey,
        shared,
        cloudDelayMs,
        'two-stage',
      );

      const reports = [report1, report2];
      fs.writeFileSync(
        path.join(RESULTS_DIR, `cloud-${datasetName}-1stage.json`),
        JSON.stringify(report1, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(RESULTS_DIR, `cloud-${datasetName}-2stage.json`),
        JSON.stringify(report2, null, 2) + '\n',
        'utf8',
      );

      const table = shared.formatComparisonMarkdown(reports);
      console.log(`\n=== 1段階 vs 2段階 比較表 (${datasetName}) ===\n`);
      console.log(table);

      const reportFile = path.join(RESULTS_DIR, `report-${datasetName}.md`);
      fs.writeFileSync(
        reportFile,
        `# χ読 1段階 vs 2段階 評価レポート (${datasetName})\n\n${table}\n`,
        'utf8',
      );

      const errorsFile = path.join(RESULTS_DIR, `errors-${datasetName}.md`);
      fs.writeFileSync(
        errorsFile,
        shared.formatErrorAnalysisMarkdown(reports, dataset),
        'utf8',
      );
      console.log(
        `\nレポートを保存しました: ${path.relative(ROOT_DIR, reportFile)}`,
      );
      console.log(
        `誤り分析レポートを保存しました: ${path.relative(ROOT_DIR, errorsFile)}`,
      );
      return;
    }

    const reports = [];

    // 1. Nano 評価結果（eval.html から書き出した JSON）を読み込む
    const candidateNanoFiles = nanoPath
      ? [nanoPath]
      : datasetName === 'dev'
        ? [
            path.join(RESULTS_DIR, 'nano-dev-1stage-results.json'),
            path.join(RESULTS_DIR, 'nano-dev-2stage-results.json'),
            path.join(RESULTS_DIR, 'nano-dev-results.json'),
          ]
        : datasetName === 'test'
          ? [path.join(RESULTS_DIR, 'nano-results.json')]
          : [];

    let loadedNanoCount = 0;
    for (const filePath of candidateNanoFiles) {
      const nanoReport = loadAndRescoreReport(
        filePath,
        'nano',
        'Gemini Nano (Prompt API)',
        dataset,
        datasetName,
        shared,
      );
      if (nanoReport) {
        console.log(
          `[Nano] 評価結果を読み込みました: ${path.relative(ROOT_DIR, filePath)} (${nanoReport.modelName} / ${nanoReport.totalCount} 文)`,
        );
        reports.push(nanoReport);
        loadedNanoCount += 1;
      }
    }

    if (loadedNanoCount === 0 && candidateNanoFiles.length > 0) {
      console.log(
        `[Nano] 結果ファイルが未配置です（${path.relative(ROOT_DIR, candidateNanoFiles[0])}）。`,
      );
      console.log(
        '       Chrome 拡張の eval.html で評価を実行し、「結果 JSON を書き出す」で上記パスに保存すると比較表に含まれます。',
      );
    }

    // 2. クラウド評価（.env.local の GEMINI_API_KEY がある場合のみ実行、--reuse-cloud 時は保存済み JSON を再利用）
    const cloudOutFile = path.join(
      RESULTS_DIR,
      datasetName === 'dev' ? 'cloud-dev-results.json' : 'cloud-results.json',
    );
    const apiKey = (process.env.GEMINI_API_KEY ?? '').trim();

    if (reuseCloud) {
      const savedCloud = loadAndRescoreReport(
        cloudOutFile,
        'cloud',
        shared.DEFAULT_CLOUD_MODEL,
        dataset,
        datasetName,
        shared,
      );
      if (savedCloud) {
        console.log(
          `[Cloud] 保存済み結果を読み込みました: ${path.relative(ROOT_DIR, cloudOutFile)} (${savedCloud.totalCount} 文)`,
        );
        reports.push(savedCloud);
      } else {
        console.log(
          `[Cloud] 保存済み結果が見つかりません（${path.relative(ROOT_DIR, cloudOutFile)}）。`,
        );
      }
    } else if (skipCloud) {
      console.log('[Cloud] --skip-cloud 指定のためクラウド評価をスキップしました。');
    } else if (!apiKey) {
      console.log(
        '[Cloud] .env.local に GEMINI_API_KEY が未設定のため、クラウド評価をスキップします。',
      );
    } else {
      const cloudReport = await runCloudEval(
        dataset,
        datasetName,
        apiKey,
        shared,
        cloudDelayMs,
        cloudMode,
      );
      fs.writeFileSync(
        cloudOutFile,
        JSON.stringify(cloudReport, null, 2) + '\n',
        'utf8',
      );
      console.log(
        `[Cloud] 評価結果を保存しました: ${path.relative(ROOT_DIR, cloudOutFile)}`,
      );
      reports.push(cloudReport);
    }

    // 3. 比較テーブルと誤り分析レポート（errors.md）を出力・保存
    if (reports.length > 0) {
      const table = shared.formatComparisonMarkdown(reports);
      console.log('\n=== 評価結果比較表 ===\n');
      console.log(table);

      const reportFile = path.join(
        RESULTS_DIR,
        datasetName === 'dev' ? 'report-dev.md' : 'report.md',
      );
      fs.writeFileSync(
        reportFile,
        `# χ読 評価レポート (${datasetName})\n\n${table}\n`,
        'utf8',
      );
      console.log(
        `\nレポートを保存しました: ${path.relative(ROOT_DIR, reportFile)}`,
      );

      const errorsFile = path.join(
        RESULTS_DIR,
        datasetName === 'dev' ? 'errors-dev.md' : 'errors.md',
      );
      const errorsMd = shared.formatErrorAnalysisMarkdown(reports, dataset);
      fs.writeFileSync(errorsFile, errorsMd, 'utf8');
      console.log(
        `誤り分析レポートを保存しました: ${path.relative(ROOT_DIR, errorsFile)}`,
      );
    } else {
      console.log(
        '\n集計対象の結果がまだありません（Nano 結果 JSON または .env.local の GEMINI_API_KEY を用意してください）。',
      );
    }
  } finally {
    cleanup();
  }
}

await main();
