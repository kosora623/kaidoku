// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  extractPageBodyText,
  findAcronymDefinition,
  findAcronymsInSentence,
  isAcronymWord,
  normalizeAcronymBase,
} from '../src/lang/en/acronym';

describe('lang/en/acronym.ts（略語判定・ページ内定義探索）', () => {
  describe('isAcronymWord / normalizeAcronymBase', () => {
    it('2文字以上の大文字を含む語（複数形 s 付きを含む）を略語と判定し、基本形を正規化する', () => {
      expect(isAcronymWord('MRAS')).toBe(true);
      expect(isAcronymWord('MRASs')).toBe(true);
      expect(isAcronymWord('LLMs')).toBe(true);
      expect(isAcronymWord('CNN')).toBe(true);
      expect(isAcronymWord('CNNs')).toBe(true);
      expect(isAcronymWord('IoT')).toBe(true);
      expect(isAcronymWord('LoRA')).toBe(true);
      expect(isAcronymWord('LoRAs')).toBe(true);
      expect(isAcronymWord('R-CNN')).toBe(true);
      expect(isAcronymWord('AI')).toBe(true);

      // 通常の単語やプレースホルダは略語とみなさない
      expect(isAcronymWord('Model')).toBe(false);
      expect(isAcronymWord('adaptive')).toBe(false);
      expect(isAcronymWord('I')).toBe(false);
      expect(isAcronymWord('[MATH]')).toBe(false);
      expect(isAcronymWord('2026')).toBe(false);
      expect(isAcronymWord('')).toBe(false);

      // 複数形の小文字 s・所有格のみ除去し、大文字 S は削らない
      expect(normalizeAcronymBase('MRAS')).toBe('MRAS');
      expect(normalizeAcronymBase('MRASs')).toBe('MRAS');
      expect(normalizeAcronymBase("MRAS's")).toBe('MRAS');
      expect(normalizeAcronymBase('LLMs')).toBe('LLM');
      expect(normalizeAcronymBase('LoRAs')).toBe('LoRA');
      expect(normalizeAcronymBase('OS')).toBe('OS');
      expect(normalizeAcronymBase('OSs')).toBe('OS');
    });
  });

  describe('形式 1: 正式名称 (略語)', () => {
    it('arXiv 論文の "Model reference adaptive systems (MRAS)" を前の動詞や冠詞を巻き込まず抽出する', () => {
      const pageText =
        'In this paper, we investigate Model reference adaptive systems (MRAS) for uncertain nonlinear plants. Later, MRAS is evaluated in simulation.';

      const match = findAcronymDefinition('MRAS', pageText);
      expect(match).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'full-then-acronym',
      });
    });

    it('複数形 s 付き（MRASs / LLMs）のタップや定義でも双方向に一致する', () => {
      const page1 =
        'We introduce Model reference adaptive systems (MRAS) in Section 1.';
      expect(findAcronymDefinition('MRASs', page1)).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'full-then-acronym',
      });

      const page2 =
        'Recent advances in large language models (LLMs) enable strong zero-shot reasoning.';
      expect(findAcronymDefinition('LLMs', page2)).toEqual({
        acronym: 'LLM',
        fullForm: 'large language models',
        pattern: 'full-then-acronym',
      });
      expect(findAcronymDefinition('LLM', page2)).toEqual({
        acronym: 'LLM',
        fullForm: 'large language models',
        pattern: 'full-then-acronym',
      });
    });

    it('ハイフン付き・ストップワード含有・複合語略語にも対応する', () => {
      expect(
        findAcronymDefinition(
          'LoRA',
          'We fine-tune models with Low-Rank Adaptation (LoRA) on downstream tasks.',
        ),
      ).toEqual({
        acronym: 'LoRA',
        fullForm: 'Low-Rank Adaptation',
        pattern: 'full-then-acronym',
      });

      expect(
        findAcronymDefinition(
          'IoT',
          'Many Internet of Things (IoT) sensors operate on limited battery power.',
        ),
      ).toEqual({
        acronym: 'IoT',
        fullForm: 'Internet of Things',
        pattern: 'full-then-acronym',
      });

      expect(
        findAcronymDefinition(
          'AUC',
          'We report an Area Under the Curve (AUC) score of 0.94.',
        ),
      ).toEqual({
        acronym: 'AUC',
        fullForm: 'Area Under the Curve',
        pattern: 'full-then-acronym',
      });

      expect(
        findAcronymDefinition(
          'GPT',
          'A Generative Pre-trained Transformer (GPT) processes text autoregressively.',
        ),
      ).toEqual({
        acronym: 'GPT',
        fullForm: 'Generative Pre-trained Transformer',
        pattern: 'full-then-acronym',
      });

      expect(
        findAcronymDefinition(
          'BERT',
          'Bidirectional Encoder Representations from Transformers (BERT) uses masked language modeling.',
        ),
      ).toEqual({
        acronym: 'BERT',
        fullForm: 'Bidirectional Encoder Representations from Transformers',
        pattern: 'full-then-acronym',
      });

      expect(
        findAcronymDefinition(
          'MRAS',
          'We study Model reference adaptive systems (hereafter MRAS; Smith et al., 2020) for control.',
        ),
      ).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'full-then-acronym',
      });
    });
  });

  describe('形式 2: 略語 (正式名称)', () => {
    it('"MRAS (Model reference adaptive systems)" の形から正式名称を抽出する', () => {
      const pageText =
        'Section 2 reviews MRAS (Model reference adaptive systems) and establishes stability bounds.';

      const match = findAcronymDefinition('MRAS', pageText);
      expect(match).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'acronym-then-full',
      });
    });

    it('複数形や括弧内の注記・導入語付き（short for ...）でも抽出できる', () => {
      const pageText =
        'LLMs (Large Language Models) and MRAS (short for Model reference adaptive systems, see Section 2) are compared.';

      expect(findAcronymDefinition('LLMs', pageText)).toEqual({
        acronym: 'LLM',
        fullForm: 'Large Language Models',
        pattern: 'acronym-then-full',
      });
      expect(findAcronymDefinition('MRASs', pageText)).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'acronym-then-full',
      });
    });
  });

  describe('誤検出の防止と定義なしケース', () => {
    it('括弧内の参照や注記を正式名称と誤認しない', () => {
      const noDefPage = [
        'We evaluate the controller (MRAS) on two benchmarks.',
        'As shown in MRAS (see Fig. 2), tracking error decreases.',
        'MRAS (ours) outperforms the baseline (2024).',
      ].join('\n');

      expect(findAcronymDefinition('MRAS', noDefPage)).toBeNull();
    });

    it('手前に注記括弧があっても、後続の正しい定義を見落とさない', () => {
      const pageText = [
        'In MRAS (see Section 2), stability is proved.',
        'Specifically, Model reference adaptive systems (MRAS) track a reference trajectory.',
      ].join('\n');

      expect(findAcronymDefinition('MRAS', pageText)).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'full-then-acronym',
      });
    });
  });

  describe('findAcronymsInSentence / extractPageBodyText', () => {
    it('1文内の略語を「定義あり」と「定義なし」に分類する', () => {
      const pageText =
        'We introduce Model reference adaptive systems (MRAS) and compare them against PID controllers.';
      const sentence =
        'The proposed MRAS controller improves over classical PID under [MATH] disturbances.';

      const resolved = findAcronymsInSentence(sentence, pageText);
      expect(resolved.defined).toEqual([
        {
          acronym: 'MRAS',
          fullForm: 'Model reference adaptive systems',
          pattern: 'full-then-acronym',
        },
      ]);
      expect(resolved.undefinedAcronyms).toEqual(['PID']);
    });

    it('DOM から script / Shadow DOM ホストを除外して本文テキストを抽出し、定義を見つけられる', () => {
      document.body.innerHTML = `
        <div class="ltx_document">
          <div class="ltx_abstract">
            <p class="ltx_p">Model reference adaptive systems (MRAS) guarantee tracking.</p>
          </div>
          <script>const fake = "Wrong Name (MRAS)";</script>
        </div>
        <div id="kaidoku-shadow-host">Ignored Panel Text (MRAS)</div>
      `;

      const bodyText = extractPageBodyText(document);
      expect(bodyText).not.toContain('Wrong Name');
      expect(bodyText).not.toContain('Ignored Panel Text');
      expect(findAcronymDefinition('MRAS', bodyText)).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model reference adaptive systems',
        pattern: 'full-then-acronym',
      });
    });

    it('本文に定義がなく <title> にのみ正式名称がある場合も探索できる', () => {
      document.title = 'Model Reference Adaptive Systems (MRAS) — Survey';
      document.body.innerHTML = `<article><p>We compare MRAS against classic controllers.</p></article>`;

      const bodyText = extractPageBodyText(document);
      expect(findAcronymDefinition('MRAS', bodyText)).toEqual({
        acronym: 'MRAS',
        fullForm: 'Model Reference Adaptive Systems',
        pattern: 'full-then-acronym',
      });
      document.title = '';
    });
  });
});
