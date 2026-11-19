/**
 * npm run eval:labels 実行スクリプト
 * tests/eval/sentences.json と tests/eval/dev-sentences.json の expected を
 * 英文解釈の複数行記法と constructs 一覧に変換し、tests/eval/labels-review.md へ出力する。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT_DIR = process.cwd();
const TEST_JSON_PATH = path.join(ROOT_DIR, 'tests', 'eval', 'sentences.json');
const DEV_JSON_PATH = path.join(ROOT_DIR, 'tests', 'eval', 'dev-sentences.json');
const OUT_MD_PATH = path.join(ROOT_DIR, 'tests', 'eval', 'labels-review.md');

async function loadFormatter() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaidoku-labels-'));
  const outFile = path.join(tmpDir, 'labels-review.mjs');

  await esbuild.build({
    entryPoints: [path.join(ROOT_DIR, 'src', 'eval', 'labels-review.ts')],
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

async function main() {
  const testItems = JSON.parse(fs.readFileSync(TEST_JSON_PATH, 'utf8'));
  const devItems = JSON.parse(fs.readFileSync(DEV_JSON_PATH, 'utf8'));

  const { mod, cleanup } = await loadFormatter();
  try {
    const markdown = mod.formatLabelsReviewMarkdown([
      {
        title: '本番評価セット（sentences.json）',
        sourcePath: 'tests/eval/sentences.json',
        items: testItems,
      },
      {
        title: 'プロンプト調整セット（dev-sentences.json）',
        sourcePath: 'tests/eval/dev-sentences.json',
        items: devItems,
      },
    ]);

    fs.writeFileSync(OUT_MD_PATH, markdown, 'utf8');
    console.log(
      `正解ラベル確認シートを出力しました: ${path.relative(ROOT_DIR, OUT_MD_PATH)}（計 ${testItems.length + devItems.length} 文）`,
    );
  } finally {
    cleanup();
  }
}

await main();
