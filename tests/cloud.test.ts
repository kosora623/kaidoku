import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeWithCloud, DEFAULT_CLOUD_MODEL } from '../src/ai/cloud';
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
});
