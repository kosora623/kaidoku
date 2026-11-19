import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetNanoBaseSession } from '../src/ai/nano';
import { analyzeSentence, getAiEnvironmentStatus } from '../src/ai/router';

const SAMPLE_SENTENCE = 'The method works.';

const SIMPLE_WORD_JSON = JSON.stringify({
  mainVerbs: [{ startWord: 2, endWord: 2 }],
  spans: [{ startWord: 0, endWord: 1, role: 'S', bracket: 'noun' }],
  constructs: [],
  difficulty: 1,
});

afterEach(async () => {
  await resetNanoBaseSession();
  globalThis.LanguageModel = undefined;
  vi.restoreAllMocks();
});

describe('router.ts（クラウド既定・APIキー未設定時のみ Nano 実験モード）', () => {
  it('API キーが設定されている場合は Nano が available でもクラウド（gemini-3.1-flash-lite）を優先する', async () => {
    const createMock = vi.fn();
    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      params: vi.fn(),
      create: createMock,
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: SIMPLE_WORD_JSON }] } }],
        }),
        { status: 200 },
      ),
    );

    const status = await getAiEnvironmentStatus('my-api-key');
    expect(status.activeProvider).toBe('cloud');

    const result = await analyzeSentence(SAMPLE_SENTENCE, {
      preferredProvider: 'auto',
      apiKey: 'my-api-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.provider).toBe('cloud');
    expect(result.modelName).toBe('gemini-3.1-flash-lite');
    expect(result.isExperimentalNano).toBeUndefined();
  });

  it('API キー未設定で Nano が available の場合のみ Nano を使用し、実験的なモードの注意メッセージを付与する', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      params: vi.fn(),
      create: vi.fn().mockResolvedValue({
        prompt: vi.fn(),
        destroy: vi.fn(),
        clone: vi.fn().mockResolvedValue({
          prompt: vi.fn().mockResolvedValue(SIMPLE_WORD_JSON),
          destroy: vi.fn(),
          clone: vi.fn(),
        }),
      }),
    };

    const status = await getAiEnvironmentStatus('');
    expect(status.activeProvider).toBe('nano');

    const result = await analyzeSentence(SAMPLE_SENTENCE, {
      preferredProvider: 'auto',
      apiKey: '',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.provider).toBe('nano');
    expect(result.isExperimentalNano).toBe(true);
    expect(result.noticeMessage).toContain('精度が低い実験的なモード');
  });

  it('API キー未設定かつ Nano が unavailable のときは設定画面を案内する日本語エラーを投げる', async () => {
    globalThis.LanguageModel = undefined;

    await expect(
      analyzeSentence(SAMPLE_SENTENCE, { apiKey: '' }),
    ).rejects.toThrow(/API キー/);
  });

  it('preferredProvider: nano を明示指定した場合は API キーがあっても Nano（実験モード）を使う', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      params: vi.fn(),
      create: vi.fn().mockResolvedValue({
        prompt: vi.fn(),
        destroy: vi.fn(),
        clone: vi.fn().mockResolvedValue({
          prompt: vi.fn().mockResolvedValue(SIMPLE_WORD_JSON),
          destroy: vi.fn(),
          clone: vi.fn(),
        }),
      }),
    };

    const result = await analyzeSentence(SAMPLE_SENTENCE, {
      preferredProvider: 'nano',
      apiKey: 'has-key',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.provider).toBe('nano');
    expect(result.isExperimentalNano).toBe(true);
    expect(result.noticeMessage).toContain('精度が低い実験的なモード');
  });
});
