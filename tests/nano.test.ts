import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeWithNano,
  getNanoAvailability,
  NANO_MODEL_OPTIONS,
  resetNanoBaseSession,
} from '../src/ai/nano';
import type { LanguageModelSession } from '../src/ai/prompt-api';
import {
  AnalysisValidationError,
  MAIN_VERB_JSON_SCHEMA,
  WORD_ANALYSIS_JSON_SCHEMA,
} from '../src/ai/schema';

const SAMPLE_SENTENCE = 'The method that we propose achieves higher accuracy.';

const VALID_WORD_RESPONSE = JSON.stringify({
  mainVerbs: [{ startWord: 5, endWord: 5 }],
  spans: [
    { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
    { startWord: 2, endWord: 4, role: 'modifier', bracket: 'adj', modifies: 0 },
    { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
  ],
  constructs: ['relative_clause'],
  difficulty: 2,
});

const INVALID_MISSING_MAIN_VERB_RESPONSE = JSON.stringify({
  mainVerbs: [{ startWord: 5, endWord: 5 }],
  spans: [
    { startWord: 0, endWord: 5, role: 'S', bracket: 'noun' },
    { startWord: 2, endWord: 5, role: 'modifier', bracket: 'adj', modifies: 0 },
    { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
  ],
  constructs: ['relative_clause'],
  difficulty: 3,
});

afterEach(async () => {
  await resetNanoBaseSession();
  globalThis.LanguageModel = undefined;
  vi.restoreAllMocks();
});

describe('nano.ts', () => {
  it('LanguageModel 未定義時は unavailable を返す', async () => {
    globalThis.LanguageModel = undefined;
    expect(await getNanoAvailability()).toBe('unavailable');
  });

  it('availability() に NANO_MODEL_OPTIONS を渡して判定する', async () => {
    const availabilityMock = vi.fn().mockResolvedValue('available');
    globalThis.LanguageModel = {
      availability: availabilityMock,
      create: vi.fn(),
      params: vi.fn(),
    };

    const status = await getNanoAvailability();
    expect(status).toBe('available');
    expect(availabilityMock).toHaveBeenCalledWith(NANO_MODEL_OPTIONS);
  });

  it('土台セッションを 1 回だけ作成し、初回と 2 回目以降で作成時間と解析時間を分離計測する', async () => {
    const cloneDestroyMocks: Array<ReturnType<typeof vi.fn>> = [];
    const clonePromptMocks: Array<ReturnType<typeof vi.fn>> = [];

    const baseSession: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockImplementation(async () => {
        const prompt = vi.fn().mockResolvedValue(VALID_WORD_RESPONSE);
        const destroy = vi.fn();
        clonePromptMocks.push(prompt);
        cloneDestroyMocks.push(destroy);
        return {
          prompt,
          destroy,
          clone: vi.fn(),
        };
      }),
    };

    const createMock = vi.fn().mockResolvedValue(baseSession);
    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      create: createMock,
      params: vi.fn().mockResolvedValue({
        defaultTopK: 3,
        maxTopK: 128,
        defaultTemperature: 1,
        maxTemperature: 2,
      }),
    };

    const first = await analyzeWithNano(SAMPLE_SENTENCE);
    const second = await analyzeWithNano(SAMPLE_SENTENCE);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(baseSession.clone).toHaveBeenCalledTimes(2);
    expect(baseSession.destroy).not.toHaveBeenCalled();

    expect(cloneDestroyMocks).toHaveLength(2);
    expect(cloneDestroyMocks[0]).toHaveBeenCalledTimes(1);
    expect(cloneDestroyMocks[1]).toHaveBeenCalledTimes(1);

    expect(clonePromptMocks[0]).toHaveBeenCalledWith(
      expect.stringContaining('0:The 1:method'),
      expect.objectContaining({
        responseConstraint: WORD_ANALYSIS_JSON_SCHEMA,
      }),
    );

    // 初回は土台新規作成、2 回目以降は再利用（sessionCreateMs === 0）
    expect(first.sessionCreated).toBe(true);
    expect(first.timing.sessionCreateMs).toBeGreaterThanOrEqual(0);
    expect(first.timing.totalMs).toBe(
      first.timing.sessionCreateMs + first.timing.analyzeMs,
    );
    expect(first.attempts).toBe(1);

    expect(second.sessionCreated).toBe(false);
    expect(second.timing.sessionCreateMs).toBe(0);
    expect(second.timing.totalMs).toBe(second.timing.analyzeMs);
    expect(second.attempts).toBe(1);
  });

  it('初回検証エラー（MISSING_MAIN_VERB 等）時は失敗理由を添えて 1 回だけ再試行し、成功すれば結果を返す', async () => {
    const cloneDestroy = vi.fn();
    const clonePrompt = vi
      .fn()
      .mockResolvedValueOnce(INVALID_MISSING_MAIN_VERB_RESPONSE)
      .mockResolvedValueOnce(VALID_WORD_RESPONSE);

    const baseSession: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockResolvedValue({
        prompt: clonePrompt,
        destroy: cloneDestroy,
        clone: vi.fn(),
      }),
    };

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(baseSession),
      params: vi.fn(),
    };

    const result = await analyzeWithNano(SAMPLE_SENTENCE);

    expect(clonePrompt).toHaveBeenCalledTimes(2);
    expect(clonePrompt.mock.calls[1][0]).toContain('MISSING_MAIN_VERB');
    expect(cloneDestroy).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(2);
    expect(result.firstAttemptError?.code).toBe('MISSING_MAIN_VERB');
    expect(result.analysis.spans.find((s) => s.role === 'V')).toEqual({
      start: 27,
      end: 35,
      role: 'V',
    });
  });

  it('1 回再試行しても失敗した場合は AnalysisValidationError（生出力と試行回数付き）を投げ、複製セッションを破棄する', async () => {
    const cloneDestroy = vi.fn();
    const badJson = JSON.stringify({
      mainVerbs: [{ startWord: 5, endWord: 5 }],
      spans: [{ startWord: 0, endWord: 50, role: 'S', bracket: 'noun' }],
      constructs: [],
      difficulty: 1,
    });
    const clonePrompt = vi.fn().mockResolvedValue(badJson);

    const baseSession: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockResolvedValue({
        prompt: clonePrompt,
        destroy: cloneDestroy,
        clone: vi.fn(),
      }),
    };

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(baseSession),
      params: vi.fn(),
    };

    try {
      await analyzeWithNano(SAMPLE_SENTENCE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisValidationError);
      const valErr = err as AnalysisValidationError;
      expect(valErr.code).toBe('WORD_INDEX_OUT_OF_RANGE');
      expect(valErr.attempts).toBe(2);
      expect(valErr.rawText).toBe(badJson);
      expect(valErr.firstAttemptError?.code).toBe('WORD_INDEX_OUT_OF_RANGE');
      expect(valErr.timing).toBeDefined();
    }
    expect(clonePrompt).toHaveBeenCalledTimes(2);
    expect(cloneDestroy).toHaveBeenCalledTimes(1);
  });

  it('clone() が失敗した場合は土台セッションを再作成してリトライする', async () => {
    const freshCloneDestroy = vi.fn();
    const freshBase: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockResolvedValue({
        prompt: vi.fn().mockResolvedValue(VALID_WORD_RESPONSE),
        destroy: freshCloneDestroy,
        clone: vi.fn(),
      }),
    };

    const brokenBase: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockRejectedValue(new Error('Session evicted')),
    };

    const createMock = vi
      .fn()
      .mockResolvedValueOnce(brokenBase)
      .mockResolvedValueOnce(freshBase);

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      create: createMock,
      params: vi.fn(),
    };

    const result = await analyzeWithNano(SAMPLE_SENTENCE);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(freshCloneDestroy).toHaveBeenCalledTimes(1);
    expect(result.analysis.spans).toHaveLength(4);
  });

  it('2段階プロンプトで 1段目（主節V抽出）→ 2段目（前提付き全体解析）を実行し、2回目以降は土台セッションを再利用する', async () => {
    const stage1Destroys: Array<ReturnType<typeof vi.fn>> = [];
    const stage2Destroys: Array<ReturnType<typeof vi.fn>> = [];
    const stage2Prompts: Array<ReturnType<typeof vi.fn>> = [];

    const mainVerbBase: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockImplementation(async () => {
        const destroy = vi.fn();
        stage1Destroys.push(destroy);
        return {
          prompt: vi
            .fn()
            .mockResolvedValue(
              JSON.stringify({ mainVerbs: [{ startWord: 5, endWord: 5 }] }),
            ),
          destroy,
          clone: vi.fn(),
        };
      }),
    };

    const structureBase: LanguageModelSession = {
      prompt: vi.fn(),
      destroy: vi.fn(),
      clone: vi.fn().mockImplementation(async () => {
        const destroy = vi.fn();
        const prompt = vi.fn().mockResolvedValue(VALID_WORD_RESPONSE);
        stage2Destroys.push(destroy);
        stage2Prompts.push(prompt);
        return {
          prompt,
          destroy,
          clone: vi.fn(),
        };
      }),
    };

    const createMock = vi
      .fn()
      .mockResolvedValueOnce(mainVerbBase)
      .mockResolvedValueOnce(structureBase);

    globalThis.LanguageModel = {
      availability: vi.fn().mockResolvedValue('available'),
      create: createMock,
      params: vi.fn(),
    };

    const first = await analyzeWithNano(SAMPLE_SENTENCE, {
      nanoPromptMode: 'two-stage',
    });
    const second = await analyzeWithNano(SAMPLE_SENTENCE, {
      nanoPromptMode: 'two-stage',
    });

    // 2回解析しても土台セッション作成は Stage1 / Stage2 の各1回（計2回）のみ
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(stage1Destroys).toHaveLength(2);
    expect(stage2Destroys).toHaveLength(2);
    expect(stage1Destroys[0]).toHaveBeenCalledTimes(1);
    expect(stage2Destroys[0]).toHaveBeenCalledTimes(1);

    // 2段目のプロンプトに 1段目で確定した主節動詞の前提が入っていること
    expect(stage2Prompts[0]).toHaveBeenCalledWith(
      expect.stringContaining('word 5..5 ("achieves")'),
      expect.objectContaining({
        responseConstraint: WORD_ANALYSIS_JSON_SCHEMA,
      }),
    );

    expect(first.nanoPromptMode).toBe('two-stage');
    expect(first.modelName).toBe('Gemini Nano (2段階)');
    expect(first.stage1MainVerbs).toEqual([
      { startWord: 5, endWord: 5, text: 'achieves' },
    ]);
    expect(first.sessionCreated).toBe(true);
    expect(second.sessionCreated).toBe(false);
    expect(second.timing.sessionCreateMs).toBe(0);
    expect(MAIN_VERB_JSON_SCHEMA).toBeDefined();
  });
});
