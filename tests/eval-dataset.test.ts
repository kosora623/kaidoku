import { describe, expect, it } from 'vitest';
import {
  buildAnalysisInitialPrompts,
  buildMainVerbInitialPrompts,
} from '../src/ai/prompt';
import { validateAnalysis } from '../src/ai/schema';
import type { EvalSentenceItem } from '../src/eval/metrics';
import { CONSTRUCT_IDS, detectLongSubject } from '../src/lang/en/constructs';
import devSentencesRaw from './eval/dev-sentences.json';
import testSentencesRaw from './eval/sentences.json';

const testSentences = testSentencesRaw as EvalSentenceItem[];
const devSentences = devSentencesRaw as EvalSentenceItem[];

describe('評価データセットの整合性（sentences.json / dev-sentences.json）', () => {
  it('sentences.json がちょうど 30 文あり、ID が一意で、10 構文すべてを含む', () => {
    expect(testSentences).toHaveLength(30);

    const ids = new Set(testSentences.map((s) => s.id));
    expect(ids.size).toBe(30);

    const coveredConstructs = new Set(
      testSentences.flatMap((s) => s.expected.constructs),
    );
    for (const cid of CONSTRUCT_IDS) {
      expect(coveredConstructs.has(cid)).toBe(true);
    }
  });

  it('sentences.json の全 30 文の expected が validateAnalysis を通過する', () => {
    for (const item of testSentences) {
      expect(() => validateAnalysis(item.text, item.expected)).not.toThrow();
    }
  });

  it('dev-sentences.json が 10 文あり、全件 validateAnalysis を通過する', () => {
    expect(devSentences).toHaveLength(10);
    for (const item of devSentences) {
      expect(() => validateAnalysis(item.text, item.expected)).not.toThrow();
    }
  });

  it('本番テスト用（sentences.json）が調整用（dev-sentences.json）および Few-shot 例と一切重複していない', () => {
    const testTexts = new Set(testSentences.map((s) => s.text));
    for (const dev of devSentences) {
      expect(testTexts.has(dev.text)).toBe(false);
    }

    const promptBlob = [
      ...buildAnalysisInitialPrompts(),
      ...buildMainVerbInitialPrompts(),
    ]
      .map((m) => m.content)
      .join('\n');
    for (const item of testSentences) {
      expect(promptBlob.includes(item.text)).toBe(false);
    }
  });

  it('全 40 文の正解ラベルの long_subject がコード判定ルール（detectLongSubject）と完全一致する', () => {
    const all = [...testSentences, ...devSentences];
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
