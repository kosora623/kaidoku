import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCloudRateLimiter } from '../src/ai/rate-limiter';
import {
  clearWordMeaningCache,
  lookupWordMeaning,
} from '../src/ai/word-meaning';

const SAMPLE_SENTENCE =
  'Such routing strategy spaces differ from the singleton structure underlying network Cournot games.';

afterEach(() => {
  clearWordMeaningCache();
  resetCloudRateLimiter();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).LanguageModel;
});

describe('word-meaning.ts（文脈に合う単語の意味取得）', () => {
  it('クラウド API から文脈に合う日本語の意味を取得し、同じ単語・文の再照会はキャッシュから返す', async () => {
    const payload = JSON.stringify({
      lemma: 'underlie',
      partOfSpeech: '動詞',
      meaningJa: '〜の根底にある',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: payload }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const first = await lookupWordMeaning('underlying', SAMPLE_SENTENCE, {
      apiKey: 'test-key',
    });
    expect(first).toEqual({
      word: 'underlying',
      lemma: 'underlie',
      partOfSpeech: '動詞',
      meaningJa: '〜の根底にある',
      provider: 'cloud',
      modelName: 'gemini-3.1-flash-lite',
      fromCache: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2 回目はキャッシュヒットし fetch を呼ばない
    const second = await lookupWordMeaning('UNDERLYING', SAMPLE_SENTENCE, {
      apiKey: 'test-key',
    });
    expect(second.fromCache).toBe(true);
    expect(second.meaningJa).toBe('〜の根底にある');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('API キー未設定時は利用可能な Gemini Nano へフォールバックし、日本語出力用オプションを availability / create に渡す', async () => {
    const destroyMock = vi.fn();
    const promptMock = vi.fn().mockResolvedValue(
      JSON.stringify({
        lemma: 'singleton',
        partOfSpeech: '名詞',
        meaningJa: '単一要素集合',
      }),
    );
    const availabilityMock = vi.fn().mockResolvedValue('available');
    const createMock = vi.fn().mockResolvedValue({
      prompt: promptMock,
      destroy: destroyMock,
    });
    (globalThis as Record<string, unknown>).LanguageModel = {
      availability: availabilityMock,
      create: createMock,
    };

    const res = await lookupWordMeaning('singleton', SAMPLE_SENTENCE, {
      apiKey: '',
    });
    expect(res.provider).toBe('nano');
    expect(res.meaningJa).toBe('単一要素集合');
    expect(availabilityMock).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['ja'] }],
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['ja'] }],
      }),
    );
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('API キー未設定かつ Nano 利用不可の場合は分かりやすい日本語エラーを投げる', async () => {
    await expect(
      lookupWordMeaning('singleton', SAMPLE_SENTENCE, { apiKey: '' }),
    ).rejects.toThrow(/API キー/);
  });

  it('略語のページ内定義が見つかった場合、正式名称を AI プロンプトに渡して文脈に合う訳を返す', async () => {
    const payload = JSON.stringify({
      lemma: 'MRAS',
      partOfSpeech: '名詞',
      meaningJa: 'モデル規範適応システム',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: payload }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const sentence =
      'The proposed MRAS controller guarantees asymptotic tracking.';
    const res = await lookupWordMeaning('MRAS', sentence, {
      apiKey: 'test-key',
      isAcronym: true,
      acronymDefinition: 'Model reference adaptive systems',
    });

    expect(res).toEqual({
      word: 'MRAS',
      lemma: 'MRAS',
      partOfSpeech: '名詞',
      meaningJa: 'モデル規範適応システム',
      provider: 'cloud',
      modelName: 'gemini-3.1-flash-lite',
      fromCache: false,
      isAcronym: true,
      acronymDefinition: 'Model reference adaptive systems',
      isGuessed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reqInit = fetchMock.mock.calls[0]?.[1];
    const reqBody = JSON.parse(String(reqInit?.body ?? '{}')) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const promptText = reqBody.contents?.[0]?.parts?.[0]?.text ?? '';
    expect(promptText).toContain('Model reference adaptive systems');
  });

  it('略語の定義がページ内に見つからない場合、既定では AI を呼ばず未定義結果を返す', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const res = await lookupWordMeaning(
      'MRAS',
      'The proposed MRAS controller guarantees asymptotic tracking.',
      {
        apiKey: 'test-key',
        isAcronym: true,
        acronymDefinition: null,
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({
      word: 'MRAS',
      lemma: 'MRAS',
      partOfSpeech: '略語',
      meaningJa: '',
      provider: 'none',
      modelName: 'page-lookup',
      fromCache: false,
      isAcronym: true,
      acronymDefinition: null,
      isGuessed: false,
    });
  });

  it('定義なしの略語で推測を明示要求（allowAcronymGuess: true）した場合は isGuessed: true で返す', async () => {
    const payload = JSON.stringify({
      lemma: 'MRAS',
      partOfSpeech: '略語',
      meaningJa: 'モデル規範適応システム',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: payload }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await lookupWordMeaning(
      'MRAS',
      'The proposed MRAS controller guarantees asymptotic tracking.',
      {
        apiKey: 'test-key',
        isAcronym: true,
        acronymDefinition: null,
        allowAcronymGuess: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isAcronym).toBe(true);
    expect(res.acronymDefinition).toBeNull();
    expect(res.isGuessed).toBe(true);
    expect(res.meaningJa).toBe('モデル規範適応システム');
  });
});
