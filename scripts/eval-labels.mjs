/**
 * npm run eval:labels 実行スクリプト
 * tests/eval/ 配下の各データセット（sentences.json / dev-sentences.json /
 * long-sentences.json / long-dev-sentences.json）の expected を
 * 英文解釈の複数行記法と constructs 一覧に変換し、tests/eval/labels-review.md へ出力する。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT_DIR = process.cwd();
const EVAL_DIR = path.join(ROOT_DIR, 'tests', 'eval');
const OUT_MD_PATH = path.join(EVAL_DIR, 'labels-review.md');

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
  const testItems = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'sentences.json'), 'utf8'),
  );
  const devItems = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'dev-sentences.json'), 'utf8'),
  );
  const longTestItems = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'long-sentences.json'), 'utf8'),
  );
  const longDevItems = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'long-dev-sentences.json'), 'utf8'),
  );

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
      {
        title: '長文 本番評価セット（long-sentences.json）',
        sourcePath: 'tests/eval/long-sentences.json',
        items: longTestItems,
      },
      {
        title: '長文 プロンプト調整セット（long-dev-sentences.json）',
        sourcePath: 'tests/eval/long-dev-sentences.json',
        items: longDevItems,
      },
    ]);

    const total =
      testItems.length +
      devItems.length +
      longTestItems.length +
      longDevItems.length;
    fs.writeFileSync(OUT_MD_PATH, markdown, 'utf8');
    console.log(
      `正解ラベル確認シートを出力しました: ${path.relative(ROOT_DIR, OUT_MD_PATH)}（計 ${total} 文）`,
    );
  } finally {
    cleanup();
  }
}

await main();
