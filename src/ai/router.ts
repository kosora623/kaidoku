import { loadSettings } from '../settings';
import type {
  AiProvider,
  AiProviderPreference,
  AnalyzeResult,
  NanoPromptMode,
} from '../types';
import {
  analyzeWithCloud,
  DEFAULT_CLOUD_MODEL,
  type Stage1SkeletonProgress,
} from './cloud';
import { analyzeWithNano, getNanoAvailability } from './nano';
import type { LanguageModelAvailability, LanguageModelMonitor } from './prompt-api';

/** 現在の AI 利用環境ステータス */
export interface AiEnvironmentStatus {
  nanoAvailability: LanguageModelAvailability;
  hasApiKey: boolean;
  activeProvider: AiProvider | null;
  cloudModel: string;
  nanoPromptMode: NanoPromptMode;
}

export interface AnalyzeSentenceOptions {
  /** 'auto' のときはクラウド優先、API キー未設定時のみ Nano（実験モード）を使う */
  preferredProvider?: AiProviderPreference;
  /** Nano プロンプト方式の上書き（2段階実験は保留のため既定は 'one-stage'） */
  nanoPromptMode?: NanoPromptMode;
  /** テストや直接指定用に API キーを明示的に渡す場合 */
  apiKey?: string;
  /** クラウドモデルの上書き */
  cloudModel?: string;
  /** 2段階解析の 1 段目（骨格抽出）完了直後の通知コールバック */
  onStage1Complete?: (progress: Stage1SkeletonProgress) => void;
  /** availability が downloadable のときに Nano ダウンロードを許可するか */
  allowNanoDownload?: boolean;
  monitor?: (m: LanguageModelMonitor) => void;
  signal?: AbortSignal;
}

const EXPERIMENTAL_NANO_FALLBACK_NOTICE =
  'API キーが未設定のため、Gemini Nano（精度が低い実験的なモード）で解析しました。高精度な解析には設定画面（options.html）から Gemini API キーを登録してください。';

const EXPERIMENTAL_NANO_NOTICE =
  'Gemini Nano（精度が低い実験的なモード）で解析しました。';

/**
 * 設定済み API キーと Gemini Nano の利用可否から現在の利用状態を返す。
 * 30文評価の結果に基づき、API キーがある場合はクラウド（gemini-3.1-flash-lite）を既定とする。
 */
export async function getAiEnvironmentStatus(
  apiKeyOverride?: string,
): Promise<AiEnvironmentStatus> {
  const [nanoAvailability, settings] = await Promise.all([
    getNanoAvailability(),
    loadSettings(),
  ]);

  const effectiveKey =
    apiKeyOverride !== undefined ? apiKeyOverride.trim() : settings.geminiApiKey;
  const hasApiKey = effectiveKey.length > 0;
  let activeProvider: AiProvider | null = null;
  if (hasApiKey) {
    activeProvider = 'cloud';
  } else if (nanoAvailability === 'available') {
    activeProvider = 'nano';
  }

  return {
    nanoAvailability,
    hasApiKey,
    activeProvider,
    cloudModel: DEFAULT_CLOUD_MODEL,
    nanoPromptMode: settings.nanoPromptMode,
  };
}

/**
 * クラウド（gemini-3.1-flash-lite）を既定として 1 文を構造解析する。
 * auto モードでは API キーがあればクラウドを優先し、
 * API キーがない場合のみ Gemini Nano（精度が低い実験的なモード）を使用する。
 */
export async function analyzeSentence(
  sentence: string,
  options?: AnalyzeSentenceOptions,
): Promise<AnalyzeResult> {
  const preference: AiProviderPreference = options?.preferredProvider ?? 'auto';
  const settings = await loadSettings();
  const apiKey =
    options?.apiKey !== undefined
      ? options.apiKey.trim()
      : settings.geminiApiKey;
  // 2段階プロンプト実験は保留のため、明示指定がなければ既定 'one-stage' を使用する
  const nanoPromptMode: NanoPromptMode = options?.nanoPromptMode ?? 'one-stage';

  if (preference === 'cloud') {
    return analyzeWithCloud(sentence, apiKey, {
      model: options?.cloudModel,
      onStage1Complete: options?.onStage1Complete,
      signal: options?.signal,
    });
  }

  if (preference === 'nano') {
    const availability = await getNanoAvailability();
    if (availability === 'unavailable') {
      throw new Error(
        'この環境では Gemini Nano（Prompt API）が利用できません（availability: unavailable）。',
      );
    }
    const nanoResult = await analyzeWithNano(sentence, {
      nanoPromptMode,
      monitor: options?.monitor,
      signal: options?.signal,
    });
    return {
      ...nanoResult,
      isExperimentalNano: true,
      noticeMessage: EXPERIMENTAL_NANO_NOTICE,
    };
  }

  // auto モード：クラウド（gemini-3.1-flash-lite）を優先
  if (apiKey) {
    return analyzeWithCloud(sentence, apiKey, {
      model: options?.cloudModel,
      onStage1Complete: options?.onStage1Complete,
      signal: options?.signal,
    });
  }

  // API キー未設定時のみ Gemini Nano（精度が低い実験的なモード）を使用
  const availability = await getNanoAvailability();
  const canTryNano =
    availability === 'available' ||
    ((availability === 'downloadable' || availability === 'downloading') &&
      Boolean(options?.allowNanoDownload));

  if (canTryNano) {
    const nanoResult = await analyzeWithNano(sentence, {
      nanoPromptMode,
      monitor: options?.monitor,
      signal: options?.signal,
    });
    return {
      ...nanoResult,
      isExperimentalNano: true,
      noticeMessage: EXPERIMENTAL_NANO_FALLBACK_NOTICE,
      fallbackReason: EXPERIMENTAL_NANO_FALLBACK_NOTICE,
    };
  }

  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error(
      `Gemini API キーが未設定で、Gemini Nano は現在「${availability}」状態です。設定画面（options.html）から Gemini API キーを登録してください。`,
    );
  }

  throw new Error(
    'Gemini API キーが未設定で、Gemini Nano も利用できません。設定画面（options.html）から Gemini API キーを登録してください。',
  );
}
