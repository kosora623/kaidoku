import { describe, expect, it } from 'vitest';
import {
  AGAIN_RETRY_DELAY_MS,
  createInitialReviewCard,
  isCardDue,
  previewNextIntervalLabels,
  scheduleReviewCard,
  sortDueReviewQueue,
} from '../src/review';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_NOW = Date.parse('2026-11-19T09:00:00.000Z');

describe('review.ts（間隔反復アルゴリズム）', () => {
  it('初期カードは interval=0, ease=2.5, lapses=0 で即時復習待ちになる', () => {
    const card = createInitialReviewCard('word', 'w-1', BASE_NOW, 'c-1');
    expect(card).toEqual({
      id: 'c-1',
      kind: 'word',
      refId: 'w-1',
      dueAt: new Date(BASE_NOW).toISOString(),
      interval: 0,
      ease: 2.5,
      lapses: 0,
    });
    expect(isCardDue(card, BASE_NOW)).toBe(true);
  });

  it('good（分かった）を繰り返すと 1日 → 3日 → ease倍 に間隔が伸びる', () => {
    const c0 = createInitialReviewCard('word', 'w-1', BASE_NOW, 'c-1');
    const c1 = scheduleReviewCard(c0, 'good', BASE_NOW);
    expect(c1.interval).toBe(1);
    expect(c1.ease).toBe(2.55);
    expect(Date.parse(c1.dueAt)).toBe(BASE_NOW + 1 * DAY_MS);

    const c2 = scheduleReviewCard(c1, 'good', BASE_NOW + DAY_MS);
    expect(c2.interval).toBe(3);
    expect(c2.ease).toBe(2.6);
    expect(Date.parse(c2.dueAt)).toBe(BASE_NOW + 4 * DAY_MS);

    const c3 = scheduleReviewCard(c2, 'good', BASE_NOW + 4 * DAY_MS);
    expect(c3.interval).toBe(Math.round(3 * 2.6)); // 8日
    expect(c3.ease).toBe(2.65);
  });

  it('again（忘れた）は lapses を増やし interval=0・10分後に再出題、ease は下限 1.3 を割らない', () => {
    let card = createInitialReviewCard('construct', 'k-1', BASE_NOW, 'c-2');
    card = scheduleReviewCard(card, 'good', BASE_NOW); // interval=1
    const again = scheduleReviewCard(card, 'again', BASE_NOW + DAY_MS);

    expect(again.lapses).toBe(1);
    expect(again.interval).toBe(0);
    expect(again.ease).toBe(2.35);
    expect(Date.parse(again.dueAt)).toBe(BASE_NOW + DAY_MS + AGAIN_RETRY_DELAY_MS);

    // 繰り返し again しても ease >= 1.3
    let low = again;
    for (let i = 0; i < 10; i++) {
      low = scheduleReviewCard(low, 'again', BASE_NOW);
    }
    expect(low.ease).toBe(1.3);
  });

  it('hard（少し怪しい）は短い間隔で再設定し ease をわずかに下げる', () => {
    const c0 = createInitialReviewCard('word', 'w-1', BASE_NOW, 'c-1');
    const c1 = scheduleReviewCard(c0, 'good', BASE_NOW); // 1日
    const c2 = scheduleReviewCard(c1, 'good', BASE_NOW + DAY_MS); // 3日
    const hard = scheduleReviewCard(c2, 'hard', BASE_NOW + 4 * DAY_MS);

    expect(hard.interval).toBe(4); // round(3 * 1.2) = 4日
    expect(hard.ease).toBe(2.45);
  });

  it('sortDueReviewQueue は期限到来カードのみ抽出し、間違えた回数（lapses）が多い順→期限が古い順に並べる', () => {
    const cOldNoLapse = createInitialReviewCard('word', 'w-1', BASE_NOW - 5 * DAY_MS, 'old-0');
    const cNewHighLapse = {
      ...createInitialReviewCard('construct', 'k-1', BASE_NOW - 1000, 'new-3'),
      lapses: 3,
    };
    const cMidLapse = {
      ...createInitialReviewCard('word', 'w-2', BASE_NOW - DAY_MS, 'mid-1'),
      lapses: 1,
    };
    const cFuture = createInitialReviewCard('word', 'w-3', BASE_NOW + DAY_MS, 'future');

    const sorted = sortDueReviewQueue(
      [
        { card: cOldNoLapse },
        { card: cFuture },
        { card: cMidLapse },
        { card: cNewHighLapse },
      ],
      BASE_NOW,
    );

    expect(sorted.map((x) => x.card.id)).toEqual(['new-3', 'mid-1', 'old-0']);
  });

  it('previewNextIntervalLabels が各ボタンの日本語ラベルを返す', () => {
    const card = createInitialReviewCard('word', 'w-1', BASE_NOW, 'c-1');
    expect(previewNextIntervalLabels(card)).toEqual({
      again: '10分後（すぐ再出題）',
      hard: '1日後',
      good: '1日後',
    });
  });
});
