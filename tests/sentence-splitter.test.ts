// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  extractPageSentences,
  splitParagraphSentences,
} from '../src/lang/en/sentence-splitter';

describe('lang/en/sentence-splitter.ts', () => {
  it('略語（e.g., et al., Fig. 3）や小数点（3.14）で誤分割せず英文を文単位に分割する', () => {
    const paragraph =
      'Recent work (e.g., Smith et al., 2025) shows a 3.14x speedup in Fig. 2. However, models trained on noisy labels still fail! Does pruning help?';
    const slices = splitParagraphSentences(paragraph);

    expect(slices.map((s) => s.text)).toEqual([
      'Recent work (e.g., Smith et al., 2025) shows a 3.14x speedup in Fig. 2.',
      'However, models trained on noisy labels still fail!',
      'Does pruning help?',
    ]);

    for (const slice of slices) {
      expect(paragraph.slice(slice.start, slice.end)).toBe(slice.text);
    }
  });

  it('arXiv HTML で文中数式 (.ltx_Math) を [MATH] に置換しつつ DOM Range は元のまま保ち、数式行・コード・参考文献を除外する', () => {
    document.body.innerHTML = `
      <div class="ltx_document">
        <nav><p class="ltx_p">Navigation text that should be ignored completely by the splitter.</p></nav>
        <p class="ltx_p">
          When the parameter <math class="ltx_Math"><mi>x</mi><mo>=</mo><mn>1</mn></math> increases, the model achieves better convergence.
        </p>
        <div class="ltx_equation">
          <p class="ltx_p">E = mc^2 equation block that must be skipped completely.</p>
        </div>
        <pre><code>const x = 1; // code block must be ignored completely here.</code></pre>
        <section class="ltx_bibliography">
          <p class="ltx_p">Reference entry that should not be extracted for marking.</p>
        </section>
      </div>
    `;

    const extracted = extractPageSentences(document, window);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].text).toBe(
      'When the parameter [MATH] increases, the model achieves better convergence.',
    );

    // DOM は書き換えられておらず、Range には元の <math class="ltx_Math"> が含まれていること
    const mathEl = document.querySelector('.ltx_Math');
    expect(mathEl).not.toBeNull();
    expect(extracted[0].range.intersectsNode(mathEl!)).toBe(true);
    expect(document.querySelectorAll('mark')).toHaveLength(0);
  });
});
