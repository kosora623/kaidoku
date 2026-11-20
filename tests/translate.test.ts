import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCloudRateLimiter } from '../src/ai/rate-limiter';
import {
  clearTranslationCache,
  translateSentence,
} from '../src/ai/translate';

const SAMPLE_SENTENCE =
  'The proposed MRAS approach outperforms classical PID controllers under [MATH] uncertainty.';

afterEach(() => {
  clearTranslationCache();
  resetCloudRateLimiter();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).LanguageModel;
});

describe('translate.ts（1文の日本語訳・略語定義の反映）', () => {
  it('ページ内の略語定義と未定義略語をプロンプトに反映し、同一条件の再照会はキャッシュから返す', async () => {
    const payload = JSON.stringify({
      translationJa:
        '提案するモデル規範適応システム（MRAS）の手法は、[MATH] の不確実性の下で従来の PID コントローラを上回る性能を示す。',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: payload }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const first = await translateSentence(SAMPLE_SENTENCE, {
      apiKey: 'test-key',
      acronymDefinitions: [
        { acronym: 'MRAS', fullForm: 'Model reference adaptive systems' },
      ],
      unresolvedAcronyms: ['PID'],
    });

    expect(first).toEqual({
      sentence: SAMPLE_SENTENCE,
      translationJa:
        '提案するモデル規範適応システム（MRAS）の手法は、[MATH] の不確実性の下で従来の PID コントローラを上回る性能を示す。',
      appliedAcronyms: [
        { acronym: 'MRAS', fullForm: 'Model reference adaptive systems' },
      ],
      unresolvedAcronyms: ['PID'],
      provider: 'cloud',
      modelName: 'gemini-3.1-flash-lite',
      fromCache: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // プロンプトに MRAS の定義と未定義略語 PID が含まれていること
    const reqInit = fetchMock.mock.calls[0]?.[1];
    const reqBody = JSON.parse(String(reqInit?.body ?? '{}')) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
    };
    const promptText = reqBody.contents?.[0]?.parts?.[0]?.text ?? '';
    expect(promptText).toContain('MRAS: Model reference adaptive systems');
    expect(promptText).toContain('- PID');

    // 2 回目はキャッシュヒットし fetch を呼ばない
    const second = await translateSentence(SAMPLE_SENTENCE, {
      apiKey: 'test-key',
      acronymDefinitions: [
        { acronym: 'MRAS', fullForm: 'Model reference adaptive systems' },
      ],
      unresolvedAcronyms: ['PID'],
    });
    expect(second.fromCache).toBe(true);
    expect(second.translationJa).toBe(first.translationJa);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('API キー未設定時は利用可能な Gemini Nano へフォールバックし、日本語出力用オプションを availability / create に渡す', async () => {
    const destroyMock = vi.fn();
    const promptMock = vi.fn().mockResolvedValue(
      JSON.stringify({
        translationJa: '提案するモデル規範適応システム（MRAS）は安定性を保証する。',
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

    const res = await translateSentence(
      'The proposed MRAS guarantees stability.',
      {
        apiKey: '',
        acronymDefinitions: [
          { acronym: 'MRAS', fullForm: 'Model reference adaptive systems' },
        ],
      },
    );
    expect(res.provider).toBe('nano');
    expect(res.translationJa).toContain('モデル規範適応システム');
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
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(String(promptMock.mock.calls[0]?.[0] ?? '')).toContain(
      'MRAS: Model reference adaptive systems',
    );
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('API キー未設定かつ Nano 利用不可の場合は分かりやすい日本語エラーを投げる', async () => {
    await expect(
      translateSentence(SAMPLE_SENTENCE, { apiKey: '' }),
    ).rejects.toThrow(/API キー/);
  });
});
