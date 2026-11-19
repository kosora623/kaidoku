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
  let nanoPath = null;
  let skipCloud = false;
  let reuseCloud = false;
  let cloudDelayMs = 4500;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset' && argv[i + 1]) {
      dataset = argv[++i] === 'dev' ? 'dev' : 'test';
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
  return { dataset, nanoPath, skipCloud, reuseCloud, cloudDelayMs };
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
    export { analyzeWithCloud, DEFAULT_CLOUD_MODEL } from './src/ai/cloud.ts';
    export { AnalysisValidationError } from './src/ai/schema.ts';
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

/** 保存済みの結果 JSON を読み込み、現在の正解ラベル（sentences.json）で最新スコアを再計算する */
function loadAndRescoreReport(filePath, provider, fallbackModel, dataset, datasetName, shared) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const byId = new Map(dataset.map((item) => [item.id, item]));
  const rescoredItems = (raw.items ?? []).map((item) => {
    const ref = byId.get(item.id);
    return {
      ...item,
      scores: ref
        ? shared.scoreItem(ref.expected, item.analysis, ref.text)
        : item.scores,
    };
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
) {
  const items = [];
  console.log(
    `[Cloud] ${shared.DEFAULT_CLOUD_MODEL} で ${dataset.length} 文の評価を開始します（RPM 制御間隔: ${cloudDelayMs}ms）...`,
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
        const res = await shared.analyzeWithCloud(entry.text, apiKey);
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

        // 無料枠の HTTP 429 レート制限時は指定秒数待機して再試行する（最大2回）
        if (!isVal && safeMsg.includes('429') && rateLimitRetries < 2) {
          rateLimitRetries += 1;
          const waitMs = extractRateLimitWaitMs(safeMsg);
          console.log(
            `  [${i + 1}/${dataset.length}] ${entry.id}: レート制限 (429) のため ${Math.round(waitMs / 1000)} 秒待機して再試行します...`,
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
      modelName: shared.DEFAULT_CLOUD_MODEL,
      datasetName,
    },
    items,
  );
}

async function main() {
  const { dataset: datasetName, nanoPath, skipCloud, reuseCloud, cloudDelayMs } =
    parseArgs(process.argv.slice(2));

  const datasetFile =
    datasetName === 'dev'
      ? path.join(ROOT_DIR, 'tests', 'eval', 'dev-sentences.json')
      : path.join(ROOT_DIR, 'tests', 'eval', 'sentences.json');

  const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const { mod: shared, cleanup } = await loadSharedModules();

  try {
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
        : [path.join(RESULTS_DIR, 'nano-results.json')];

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

    if (loadedNanoCount === 0) {
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
