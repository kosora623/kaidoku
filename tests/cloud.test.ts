import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeWithCloud, DEFAULT_CLOUD_MODEL } from '../src/ai/cloud';
import { resetCloudRateLimiter } from '../src/ai/rate-limiter';
import { AnalysisValidationError } from '../src/ai/schema';

const SAMPLE_SENTENCE = 'The method that we propose achieves higher accuracy.';

function makeApiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  resetCloudRateLimiter();
  vi.restoreAllMocks();
});

describe('cloud.ts', () => {
  it('デフォルトモデルが gemini-3.1-flash-lite である', () => {
    expect(DEFAULT_CLOUD_MODEL).toBe('gemini-3.1-flash-lite');
  });

  it('Gemini REST API を呼び出して文字位置ベース Analysis と timing を返す', async () => {
    const wordJson = JSON.stringify({
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [
        { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
        { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
      ],
      constructs: ['relative_clause'],
      difficulty: 2,
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeApiResponse(wordJson));

    const result = await analyzeWithCloud(SAMPLE_SENTENCE, 'test-api-key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'test-api-key',
    );

    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();

    expect(result.provider).toBe('cloud');
    expect(result.modelName).toBe('gemini-3.1-flash-lite');
    expect(result.timing.sessionCreateMs).toBe(0);
    expect(result.sessionCreated).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.analysis.spans[0]).toEqual({
      start: 0,
      end: 26,
      role: 'S',
      bracket: 'noun',
    });
  });

  it('初回バリデーション失敗時に 1 回だけ再試行し、2 回目で成功すれば結果を返す', async () => {
    const badJson = JSON.stringify({
      mainVerbs: [],
      spans: [{ startWord: 0, endWord: 4, role: 'S', bracket: 'noun' }],
      constructs: [],
      difficulty: 2,
    });
    const goodJson = JSON.stringify({
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [
        { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
        { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
      ],
      constructs: ['relative_clause'],
      difficulty: 2,
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeApiResponse(badJson))
      .mockResolvedValueOnce(makeApiResponse(goodJson));

    const result = await analyzeWithCloud(SAMPLE_SENTENCE, 'test-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.firstAttemptError?.code).toBe('MISSING_MAIN_VERB');
  });

  it('API キーが空の場合はエラーを投げる', async () => {
    await expect(analyzeWithCloud(SAMPLE_SENTENCE, '   ')).rejects.toThrow(
      /API キー/,
    );
  });

  it('API がエラーレスポンスを返した場合は詳細付きエラーを投げる', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'API key not valid.' } }),
        { status: 400, statusText: 'Bad Request' },
      ),
    );

    await expect(
      analyzeWithCloud(SAMPLE_SENTENCE, 'bad-key'),
    ).rejects.toThrow(/API key not valid/);
  });

  it('1 回再試行しても不正なスパンの場合は AnalysisValidationError（attempts=2）を投げる', async () => {
    const badJson = JSON.stringify({
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [{ startWord: 0, endWord: 99, role: 'S' }],
      constructs: [],
      difficulty: 1,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => makeApiResponse(badJson));

    try {
      await analyzeWithCloud(SAMPLE_SENTENCE, 'test-key');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      expect((err as AnalysisValidationError).attempts).toBe(2);
      expect((err as AnalysisValidationError).rawText).toBe(badJson);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('既定（cloudPromptMode: auto）で 25 語以上の長文のみ 2 段階（骨格抽出→細部解析）を実行する', async () => {
    const longSentence =
      'Such routing strategy spaces differ from the singleton structure underlying network Cournot games, so that result neither gives our restricted hardness instances nor conflicts with our positive results.';

    const skeletonJson = JSON.stringify({
      clauses: [
        {
          startWord: 0,
          endWord: 12,
          subjects: [{ startWord: 0, endWord: 3 }],
          mainVerbs: [{ startWord: 4, endWord: 4 }],
        },
        {
          startWord: 14,
          endWord: 27,
          coordinatorWord: 13,
          subjects: [{ startWord: 14, endWord: 15 }],
          mainVerbs: [
            { startWord: 17, endWord: 17 },
            { startWord: 23, endWord: 23 },
          ],
        },
      ],
    });

    const stage2Json = JSON.stringify({
      mainVerbs: [
        { startWord: 4, endWord: 4 },
        { startWord: 17, endWord: 17 },
        { startWord: 23, endWord: 23 },
      ],
      spans: [
        { startWord: 0, endWord: 3, role: 'S', bracket: 'noun' },
        { startWord: 5, endWord: 12, role: 'modifier', bracket: 'adv' },
        { startWord: 9, endWord: 12, role: 'modifier', bracket: 'adj', modifies: 1 },
        { startWord: 14, endWord: 15, role: 'S', bracket: 'noun' },
        { startWord: 18, endWord: 21, role: 'O', bracket: 'noun' },
        { startWord: 24, endWord: 27, role: 'modifier', bracket: 'adv' },
      ],
      constructs: ['participle_modifier', 'coordination'],
      difficulty: 5,
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeApiResponse(skeletonJson))
      .mockResolvedValueOnce(makeApiResponse(stage2Json));

    // cloudPromptMode 省略時の既定（auto）で 25 語以上の文が 2 段階になり、1段目完了通知と時間内訳が返ること
    const stage1Events: Array<{ clauseCount: number; stage1Ms: number }> = [];
    const result = await analyzeWithCloud(longSentence, 'test-key', {
      onStage1Complete: (progress) => {
        stage1Events.push({
          clauseCount: progress.clauses.length,
          stage1Ms: progress.stage1Ms,
        });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stage1Events).toHaveLength(1);
    expect(stage1Events[0].clauseCount).toBe(2);
    expect(result.timing.stage1Ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.stage2Ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.retryMs).toBe(0);
    expect(result.timing.waitMs).toBe(0);
    // 2段目リクエストに 1段目の節区切り（coordinator word 13 "so"）が前提として渡されていること
    const stage2Body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const lastUserText =
      stage2Body.contents[stage2Body.contents.length - 1].parts[0].text;
    expect(lastUserText).toContain('coordinating conjunction word 13 ("so")');
    expect(lastUserText).toContain('14..15 ("that result")');

    expect(result.analysis.constructs).toEqual([
      'participle_modifier',
      'coordination',
    ]);
  });

  it('軽い検証エラー（不正 modifies・modifier の bracket 欠落）は再試行せず 1 回目で自動修復して repaired を返す', async () => {
    const minorIssueJson = JSON.stringify({
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [
        { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
        { startWord: 2, endWord: 4, role: 'modifier', modifies: 1 }, // 自己参照 & bracket 欠落
        { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
      ],
      constructs: ['relative_clause'],
      difficulty: 2,
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeApiResponse(minorIssueJson));

    const result = await analyzeWithCloud(SAMPLE_SENTENCE, 'test-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.repaired).toBeDefined();
    expect(result.repaired?.length).toBe(2);
    expect(result.analysis.spans[1].bracket).toBe('adj');
    expect(result.analysis.spans[1].modifies).toBeUndefined();
  });
});
