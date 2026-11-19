/**
 * Chrome Built-in AI Prompt API（LanguageModel）公式仕様に基づく型定義
 * 参照: https://developer.chrome.com/docs/ai/prompt-api
 *       https://developer.chrome.com/docs/extensions/ai/prompt-api
 */

export type LanguageModelAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

export interface LanguageModelExpectedIO {
  type: 'text' | 'image' | 'audio';
  languages?: string[];
}

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LanguageModelDownloadProgressEvent extends Event {
  readonly loaded: number;
  readonly total: number;
}

export interface LanguageModelMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: LanguageModelDownloadProgressEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

export interface LanguageModelAvailabilityOptions {
  expectedInputs?: LanguageModelExpectedIO[];
  expectedOutputs?: LanguageModelExpectedIO[];
}

export interface LanguageModelCreateOptions
  extends LanguageModelAvailabilityOptions {
  initialPrompts?: LanguageModelMessage[];
  temperature?: number;
  topK?: number;
  signal?: AbortSignal;
  monitor?: (monitor: LanguageModelMonitor) => void;
}

export interface LanguageModelPromptOptions {
  responseConstraint?: Record<string, unknown> | RegExp;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

export interface LanguageModelCloneOptions {
  signal?: AbortSignal;
}

export interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

export interface LanguageModelSession {
  prompt(
    input: string | LanguageModelMessage[],
    options?: LanguageModelPromptOptions,
  ): Promise<string>;
  promptStreaming?(
    input: string | LanguageModelMessage[],
    options?: LanguageModelPromptOptions,
  ): ReadableStream<string>;
  clone(options?: LanguageModelCloneOptions): Promise<LanguageModelSession>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(
    options?: LanguageModelAvailabilityOptions,
  ): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  params(): Promise<LanguageModelParams>;
}

declare global {
  // Chrome 138+ の拡張機能および対応ブラウザ環境でグローバル公開される Prompt API
  // eslint-disable-next-line no-var
  var LanguageModel: LanguageModelStatic | undefined;
}

export {};
