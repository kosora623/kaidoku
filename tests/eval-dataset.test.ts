import { describe, expect, it } from 'vitest';
import {
  buildAnalysisInitialPrompts,
  buildClauseSkeletonFewShotTurns,
  buildMainVerbInitialPrompts,
} from '../src/ai/prompt';
import { validateAnalysis } from '../src/ai/schema';
import type { EvalSentenceItem } from '../src/eval/metrics';
import { CONSTRUCT_IDS, detectLongSubject } from '../src/lang/en/constructs';
import { countWords } from '../src/lang/en/difficulty';
import devSentencesRaw from './eval/dev-sentences.json';
import longDevSentencesRaw from './eval/long-dev-sentences.json';
import longSentencesRaw from './eval/long-sentences.json';
import longSyntheticRaw from './eval/long-synthetic.json';
import testSentencesRaw from './eval/sentences.json';

const testSentences = testSentencesRaw as EvalSentenceItem[];
const devSentences = devSentencesRaw as EvalSentenceItem[];
const longSentences = longSentencesRaw as EvalSentenceItem[];
const longDevSentences = longDevSentencesRaw as EvalSentenceItem[];
const longSyntheticSentences = longSyntheticRaw as EvalSentenceItem[];

describe('評価データセットの整合性（全 55 文）', () => {
  it('sentences.json が 30 文・dev-sentences.json が 10 文・long-sentences.json が 10 文・long-dev-sentences.json が 5 文ある', () => {
    expect(testSentences).toHaveLength(30);
    expect(devSentences).toHaveLength(10);
    expect(longSentences).toHaveLength(10);
    expect(longDevSentences).toHaveLength(5);

    const all = [
      ...testSentences,
      ...devSentences,
      ...longSentences,
      ...longDevSentences,
    ];
    const ids = new Set(all.map((s) => s.id));
    expect(ids.size).toBe(55);

    const coveredConstructs = new Set(
      testSentences.flatMap((s) => s.expected.constructs),
    );
    for (const cid of CONSTRUCT_IDS) {
      expect(coveredConstructs.has(cid)).toBe(true);
    }

    // 長文本番 10 文はすべて 30 語以上かつ出典 URL を持つこと
    for (const item of longSentences) {
      expect(countWords(item.text)).toBeGreaterThanOrEqual(30);
      expect(item.sourceUrl).toMatch(/^https:\/\//);
    }

    // 長文調整 5 文もすべて出典 URL を持ち、long-dev-01 以外は 30 語以上であること
    for (const item of longDevSentences) {
      expect(item.sourceUrl).toMatch(/^https:\/\//);
      if (item.id !== 'long-dev-01') {
        expect(countWords(item.text)).toBeGreaterThanOrEqual(30);
      }
    }

    // 参考用の生成長文セット（long-synthetic.json）も 14 文保持されていること
    expect(longSyntheticSentences).toHaveLength(14);
  });

  it('全 55 文および参考用 long-synthetic.json の expected が validateAnalysis を通過する', () => {
    const all = [
      ...testSentences,
      ...devSentences,
      ...longSentences,
      ...longDevSentences,
      ...longSyntheticSentences,
    ];
    for (const item of all) {
      expect(() => validateAnalysis(item.text, item.expected)).not.toThrow();
    }
  });

  it('本番テストセット（sentences.json / long-sentences.json）が調整セットおよび Few-shot 例と一切重複していない', () => {
    const prodTexts = new Set([
      ...testSentences.map((s) => s.text),
      ...longSentences.map((s) => s.text),
    ]);
    for (const dev of [...devSentences, ...longDevSentences]) {
      expect(prodTexts.has(dev.text)).toBe(false);
    }

    const promptBlob = [
      ...buildAnalysisInitialPrompts().map((m) => m.content),
      ...buildMainVerbInitialPrompts().map((m) => m.content),
      ...buildClauseSkeletonFewShotTurns().map((m) => m.parts[0].text),
    ].join('\n');

    for (const text of prodTexts) {
      expect(promptBlob.includes(text)).toBe(false);
    }
  });

  it('全 55 文および参考用 long-synthetic.json の正解ラベルの long_subject がコード判定ルール（detectLongSubject）と完全一致する', () => {
    const all = [
      ...testSentences,
      ...devSentences,
      ...longSentences,
      ...longDevSentences,
      ...longSyntheticSentences,
    ];
    const mismatches: string[] = [];
    for (const item of all) {
      const expectedLong = item.expected.constructs.includes('long_subject');
      const detected = detectLongSubject(item.text, item.expected.spans);
      if (expectedLong !== detected) {
        mismatches.push(
          `${item.id}: expected=${expectedLong}, detected=${detected}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
