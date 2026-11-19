/**
 * マークした英文の左余白ガター（縦線）の座標計算ロジック（純粋関数）。
 * Range.getClientRects() の矩形群から、本文左側の余白（余白がない場合は本文左端）に
 * 各文の行の高さに合わせた縦線配置を計算する。
 */

import type { MarkLevel } from './types';

export interface SimpleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GutterSourceItem {
  id: string;
  markLevel: Exclude<MarkLevel, 0>;
  rects: readonly SimpleRect[];
  /** 所属する本文ブロック要素の左端 X 座標（行途中始まりの文も左余白へ揃えるため） */
  blockLeft?: number;
}

export interface ComputedGutterBar {
  id: string;
  markLevel: Exclude<MarkLevel, 0>;
  /** ビューポート基準の X 座標（px） */
  left: number;
  /** ビューポート基準の上端 Y 座標（px） */
  top: number;
  /** 縦線の高さ（px） */
  height: number;
}

export interface GutterLayoutOptions {
  viewportHeight: number;
  /** 画面外の描画を省くマージン（px、既定 120） */
  cullMargin?: number;
  /** 本文左端から縦線までの距離（px、既定 10） */
  marginGap?: number;
  /** 余白がないページで左端に重ねるときの最小 X 座標（px、既定 2） */
  minEdgeLeft?: number;
}

/**
 * マーク対象の文リストから、現在ビューポートに表示すべき左ガター縦線の座標一覧を計算する。
 * - 余白があるページ：本文ブロック左端の少し左（anchorLeft - marginGap）へ揃える
 * - 余白がないページ：本文のすぐ左（minEdgeLeft 以上）に重ねて表示する
 * - 同じ行で 2 文が縦に重なる場合は横にわずかにずらして両方クリック可能にする
 */
export function computeGutterBars(
  items: readonly GutterSourceItem[],
  options: GutterLayoutOptions,
): ComputedGutterBar[] {
  const cullMargin = options.cullMargin ?? 120;
  const marginGap = options.marginGap ?? 10;
  const minEdgeLeft = options.minEdgeLeft ?? 2;
  const vpHeight = options.viewportHeight;

  const rawBars: ComputedGutterBar[] = [];

  for (const item of items) {
    const validRects = item.rects.filter((r) => r.width > 0 && r.height > 0);
    if (validRects.length === 0) continue;

    let top = Infinity;
    let bottom = -Infinity;
    let minRectLeft = Infinity;

    for (const r of validRects) {
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.left < minRectLeft) minRectLeft = r.left;
    }

    // ビューポート外の文はスキップしてスクロール性能を保つ
    if (bottom < -cullMargin || top > vpHeight + cullMargin) {
      continue;
    }

    // 連続する文の縦線が繋がって見えないよう上下に 2px の余白を入れる
    const inset = bottom - top > 12 ? 2 : 0;
    const barTop = Math.round(top + inset);
    const barHeight = Math.max(6, Math.round(bottom - top - inset * 2));

    // 行の途中から始まる文も、所属ブロックの左端（余白）に揃える
    const anchorLeft =
      item.blockLeft !== undefined && Number.isFinite(item.blockLeft)
        ? Math.min(item.blockLeft, minRectLeft)
        : minRectLeft;

    // 左余白が十分にあれば余白側へ、余白がないページでは本文のすぐ左端に重ねて配置
    const hasLeftMargin = anchorLeft >= marginGap + minEdgeLeft + 4;
    const baseLeft = hasLeftMargin
      ? Math.round(anchorLeft - marginGap)
      : Math.max(minEdgeLeft, Math.round(anchorLeft));

    rawBars.push({
      id: item.id,
      markLevel: item.markLevel,
      left: baseLeft,
      top: barTop,
      height: barHeight,
    });
  }

  // 上から順に並べ、同一 X 付近で縦に重なるバーがあれば横にずらす
  rawBars.sort((a, b) => a.top - b.top || a.left - b.left);

  const placed: ComputedGutterBar[] = [];
  for (const bar of rawBars) {
    let adjustedLeft = bar.left;
    let lane = 0;
    while (
      lane < 3 &&
      placed.some(
        (prev) =>
          Math.abs(prev.left - adjustedLeft) < 5 &&
          prev.top < bar.top + bar.height &&
          bar.top < prev.top + prev.height,
      )
    ) {
      lane += 1;
      // 左余白に余裕があればさらに左へ、なければ右へずらす
      adjustedLeft =
        bar.left - lane * 7 >= minEdgeLeft
          ? bar.left - lane * 7
          : bar.left + lane * 7;
    }
    placed.push({
      ...bar,
      left: adjustedLeft,
    });
  }

  return placed;
}
