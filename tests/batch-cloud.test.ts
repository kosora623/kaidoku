import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyBatchConstructsWithCloud,
  CLOUD_BATCH_CONSTRUCTS_SCHEMA,
} from '../src/ai/cloud';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyBatchConstructsWithCloud', () => {
  it('スキーマに difficulty と long_subject を含めず constructs のみを 1 回の API 呼び出しで取得する', async () => {
    // スキーマ検証：difficulty を持たないこと
    const itemProps = (
      CLOUD_BATCH_CONSTRUCTS_SCHEMA.properties as Record<
        string,
        { items: { properties: Record<string, unknown> } }
      >
    ).items.items.properties;
    expect(itemProps.difficulty).toBeUndefined();
    expect(itemProps.constructs).toBeDefined();

    const batchJson = JSON.stringify({
      items: [
        { id: 0, constructs: ['relative_clause', 'comparative'] },
        { id: 1, constructs: ['formal_it', 'long_subject'] }, // long_subject はコード側で無視される
        { id: 99, constructs: ['inversion'] }, // 範囲外 ID は安全に無視される
      ],
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: batchJson }] } }],
        }),
        { status: 200 },
      ),
    );

    const res = await classifyBatchConstructsWithCloud(
      [
        {
          id: 0,
          text: 'The method that we propose achieves higher accuracy than baselines.',
        },
        {
          id: 1,
          text: 'It is clear that deeper models require residual connections.',
        },
      ],
      'test-key',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.constructsById.get(0)).toEqual(['relative_clause', 'comparative']);
    expect(res.constructsById.get(1)).toEqual(['formal_it']);
    expect(res.constructsById.has(99)).toBe(false);
  });
});
