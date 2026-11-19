import { describe, expect, it } from 'vitest';
import { computeGutterBars } from '../src/gutter';

describe('gutter.ts（左余白ガター縦線の座標計算）', () => {
  it('左余白があるページでは複数行の文の高さをまとめ、ブロック左端の余白に揃える', () => {
    const bars = computeGutterBars(
      [
        {
          id: 's-1',
          markLevel: 2,
          blockLeft: 120,
          rects: [
            // 1行目は行の途中（x=300）から始まり、2行目はブロック左端（x=120）から続く
            { left: 300, top: 100, right: 700, bottom: 124, width: 400, height: 24 },
            { left: 120, top: 128, right: 640, bottom: 152, width: 520, height: 24 },
          ],
        },
      ],
      { viewportHeight: 800 },
    );

    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({
      id: 's-1',
      markLevel: 2,
      left: 110, // blockLeft(120) - marginGap(10)
      top: 102, // 100 + 2
      height: 48, // (152 - 100) - 4
    });
  });

  it('本文の左に余白がないページでは本文のすぐ左端に重ねて配置する（画面外へはみ出さない）', () => {
    const bars = computeGutterBars(
      [
        {
          id: 's-narrow',
          markLevel: 3,
          blockLeft: 4,
          rects: [
            { left: 4, top: 200, right: 360, bottom: 224, width: 356, height: 24 },
          ],
        },
      ],
      { viewportHeight: 800 },
    );

    expect(bars).toHaveLength(1);
    expect(bars[0].left).toBe(4);
    expect(bars[0].left).toBeGreaterThanOrEqual(2);
  });

  it('同じ行で重なる 2 文のガターは横にずらし、画面外の文は描画対象から省く', () => {
    const bars = computeGutterBars(
      [
        {
          id: 's-a',
          markLevel: 1,
          blockLeft: 100,
          rects: [
            { left: 100, top: 100, right: 320, bottom: 124, width: 220, height: 24 },
          ],
        },
        {
          id: 's-b',
          markLevel: 3,
          blockLeft: 100,
          rects: [
            { left: 330, top: 100, right: 600, bottom: 124, width: 270, height: 24 },
          ],
        },
        {
          id: 's-offscreen',
          markLevel: 2,
          blockLeft: 100,
          rects: [
            { left: 100, top: 2000, right: 500, bottom: 2024, width: 400, height: 24 },
          ],
        },
      ],
      { viewportHeight: 800 },
    );

    expect(bars.map((b) => b.id)).toEqual(['s-a', 's-b']);
    expect(bars[0].left).toBe(90);
    expect(bars[1].left).not.toBe(bars[0].left);
  });
});
