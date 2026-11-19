/**
 * 間隔反復（SM-2 ベース）の復習スケジュール計算と出題キュー整列。
 * すべての関数は純粋関数として設計し、日付境界・誤答優先順を単体テストで検証可能にする。
 */

import type { ReviewCard } from './types';

/** 復習時の 3 段階評価（again: 忘れた / hard: 少し怪しい / good: 分かった） */
export type ReviewRating = 'again' | 'hard' | 'good';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 忘れたときの再出題待機時間（10分後） */
export const AGAIN_RETRY_DELAY_MS = 10 * MINUTE_MS;

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

function roundEase(value: number): number {
  return Math.round(Math.min(MAX_EASE, Math.max(MIN_EASE, value)) * 100) / 100;
}

/**
 * 新規の復習カードを作成する。
 * 初回は即座に復習対象となるよう interval = 0、dueAt = 現在時刻で初期化する。
 */
export function createInitialReviewCard(
  kind: ReviewCard['kind'],
  refId: string,
  nowMs = Date.now(),
  id: string = crypto.randomUUID(),
): ReviewCard {
  return {
    id,
    kind,
    refId,
    dueAt: new Date(nowMs).toISOString(),
    interval: 0,
    ease: DEFAULT_EASE,
    lapses: 0,
  };
}

/**
 * 回答結果に応じて次の復習日時・間隔（日数）・難易度係数（ease）・誤答回数（lapses）を計算する。
 * - again（忘れた）: lapses + 1、interval = 0、10分後に再出題、ease - 0.20
 * - hard（少し怪しい）: interval = max(1, round(max(1, interval) * 1.2)) 日、ease - 0.15
 * - good（分かった）: 初回 1日 → 2回目 3日 → 3回目以降 round(interval * ease) 日、ease + 0.05
 */
export function scheduleReviewCard(
  card: ReviewCard,
  rating: ReviewRating,
  nowMs = Date.now(),
): ReviewCard {
  if (rating === 'again') {
    return {
      ...card,
      interval: 0,
      ease: roundEase(card.ease - 0.2),
      lapses: card.lapses + 1,
      dueAt: new Date(nowMs + AGAIN_RETRY_DELAY_MS).toISOString(),
    };
  }

  if (rating === 'hard') {
    const baseInterval = Math.max(1, card.interval);
    const nextInterval = Math.max(1, Math.round(baseInterval * 1.2));
    return {
      ...card,
      interval: nextInterval,
      ease: roundEase(card.ease - 0.15),
      dueAt: new Date(nowMs + nextInterval * DAY_MS).toISOString(),
    };
  }

  // rating === 'good'
  let nextInterval: number;
  if (card.interval <= 0) {
    nextInterval = 1;
  } else if (card.interval === 1) {
    nextInterval = 3;
  } else {
    nextInterval = Math.max(card.interval + 1, Math.round(card.interval * card.ease));
  }

  return {
    ...card,
    interval: nextInterval,
    ease: roundEase(card.ease + 0.05),
    dueAt: new Date(nowMs + nextInterval * DAY_MS).toISOString(),
  };
}

/** カードが現在時刻時点で復習期限に達しているか判定する */
export function isCardDue(card: ReviewCard, nowMs = Date.now()): boolean {
  const dueMs = Date.parse(card.dueAt);
  if (!Number.isFinite(dueMs)) return true;
  return dueMs <= nowMs;
}

/**
 * 期限到来済みの復習カードを「間違えた回数（lapses）が多い順 → 期限が古い順」に並べる。
 * SPEC.md「間違えたカードほど早く出てくる」の方針に準拠する。
 */
export function sortDueReviewQueue<T extends { card: ReviewCard }>(
  items: readonly T[],
  nowMs = Date.now(),
): T[] {
  return items
    .filter((item) => isCardDue(item.card, nowMs))
    .sort((a, b) => {
      if (b.card.lapses !== a.card.lapses) {
        return b.card.lapses - a.card.lapses;
      }
      const dueA = Date.parse(a.card.dueAt) || 0;
      const dueB = Date.parse(b.card.dueAt) || 0;
      return dueA - dueB;
    });
}

/** 各回答ボタンを押したときの次回予定の日本語ラベルを返す */
export function previewNextIntervalLabels(
  card: ReviewCard,
): Record<ReviewRating, string> {
  const hard = scheduleReviewCard(card, 'hard', 0);
  const good = scheduleReviewCard(card, 'good', 0);
  return {
    again: '10分後（すぐ再出題）',
    hard: `${hard.interval}日後`,
    good: `${good.interval}日後`,
  };
}
