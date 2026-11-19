import { probePromptApi } from './ai/nano';
import { analyzeSentence } from './ai/router';
import { AnalysisValidationError } from './ai/schema';
import { EN_CONSTRUCTS } from './lang/en/constructs';
import { formatNotationText, renderNotationHtml } from './notation';
import { loadSettings } from './settings';
import type {
  AiProviderPreference,
  AnalyzeResult,
  PromptApiProbeResult,
} from './types';

const SPEC_SAMPLE_SENTENCE =
  'The method that we propose achieves higher accuracy than existing approaches trained on larger datasets.';

const swProbeStatusEl = document.getElementById('sw-probe-status') as HTMLSpanElement;
const pageProbeStatusEl = document.getElementById('page-probe-status') as HTMLSpanElement;
const cloudKeyStatusEl = document.getElementById('cloud-key-status') as HTMLSpanElement;
const activeRouteStatusEl = document.getElementById('active-route-status') as HTMLSpanElement;

const sentenceInput = document.getElementById('sentence-input') as HTMLTextAreaElement;
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const loadSampleBtn = document.getElementById('load-sample-btn') as HTMLButtonElement;
const analyzeBtn = document.getElementById('analyze-btn') as HTMLButtonElement;
const errorBox = document.getElementById('error-box') as HTMLDivElement;

const resultSection = document.getElementById('result-section') as HTMLElement;
const metaPillsEl = document.getElementById('meta-pills') as HTMLDivElement;
const fallbackBannerEl = document.getElementById('fallback-banner') as HTMLDivElement;
const notationRichEl = document.getElementById('notation-rich') as HTMLDivElement;
const notationTextEl = document.getElementById('notation-text') as HTMLPreElement;
const constructsListEl = document.getElementById('constructs-list') as HTMLDivElement;
const jsonStatsEl = document.getElementById('json-stats') as HTMLSpanElement;
const jsonOutputEl = document.getElementById('json-output') as HTMLPreElement;
const rawJsonOutputEl = document.getElementById('raw-json-output') as HTMLPreElement;

/** Service Worker で Prompt API が使えるかの判定結果 */
let useServiceWorkerForAi = false;

interface SwResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  rawOutput?: unknown;
  rawText?: string;
  attempts?: number;
  timing?: {
    sessionCreateMs: number;
    analyzeMs: number;
    totalMs: number;
  };
}

function formatProbeLabel(probe: PromptApiProbeResult): {
  text: string;
  className: string;
} {
  if (!probe.hasLanguageModel) {
    return { text: '未公開（LanguageModel なし）', className: 'status-err' };
  }
  if (probe.error) {
    return { text: `エラー: ${probe.error}`, className: 'status-err' };
  }
  if (probe.availability === 'available') {
    return { text: '利用可能（available）', className: 'status-ok' };
  }
  return {
    text: `${probe.availability ?? 'unknown'}`,
    className: 'status-warn',
  };
}

async function probeServiceWorker(
  runPromptCheck = false,
): Promise<PromptApiProbeResult> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return {
      context: 'service_worker',
      hasLanguageModel: false,
      availability: null,
      params: null,
      promptTestOk: false,
      error: '拡張機能コンテキスト外で開かれています。',
    };
  }

  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'PROBE_PROMPT_API',
      runPromptCheck,
    })) as SwResponse<PromptApiProbeResult>;

    if (res?.ok && res.data) {
      return res.data;
    }
    return {
      context: 'service_worker',
      hasLanguageModel: false,
      availability: null,
      params: null,
      promptTestOk: false,
      error: res?.error ?? 'Service Worker からの応答がありません。',
    };
  } catch (err) {
    return {
      context: 'service_worker',
      hasLanguageModel: false,
      availability: null,
      params: null,
      promptTestOk: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function refreshEnvironmentStatus(): Promise<void> {
  const [swProbe, pageProbe, settings] = await Promise.all([
    probeServiceWorker(false),
    probePromptApi('extension_page', false),
    loadSettings(),
  ]);

  const swLabel = formatProbeLabel(swProbe);
  swProbeStatusEl.textContent = swLabel.text;
  swProbeStatusEl.className = `status-value ${swLabel.className}`;

  const pageLabel = formatProbeLabel(pageProbe);
  pageProbeStatusEl.textContent = pageLabel.text;
  pageProbeStatusEl.className = `status-value ${pageLabel.className}`;

  const hasKey = settings.geminiApiKey.length > 0;
  cloudKeyStatusEl.textContent = hasKey ? '設定済み' : '未設定';
  cloudKeyStatusEl.className = `status-value ${hasKey ? 'status-ok' : 'status-warn'}`;

  // Service Worker 経由で AI 呼び出しを取り次ぐ（クラウド・Nano 共通）
  useServiceWorkerForAi =
    typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);

  if (hasKey) {
    activeRouteStatusEl.textContent =
      'クラウド Gemini (gemini-3.1-flash-lite) 優先';
    activeRouteStatusEl.className = 'status-value status-ok';
  } else if (
    (swProbe.hasLanguageModel &&
      swProbe.availability !== null &&
      swProbe.availability !== 'unavailable') ||
    (pageProbe.hasLanguageModel &&
      pageProbe.availability !== null &&
      pageProbe.availability !== 'unavailable')
  ) {
    activeRouteStatusEl.textContent = 'Gemini Nano（精度が低い実験的なモード）';
    activeRouteStatusEl.className = 'status-value status-warn';
  } else {
    activeRouteStatusEl.textContent = '利用不可（APIキー未設定・Nano未対応）';
    activeRouteStatusEl.className = 'status-value status-err';
  }

  // 自動検証スクリプトから参照できるようグローバルに公開する
  (window as unknown as Record<string, unknown>).__kaidokuProbeSummary = {
    swProbe,
    pageProbe,
    hasApiKey: hasKey,
    useServiceWorkerForAi,
  };
}

function showError(message: string, rawOutput?: unknown): void {
  let text = message;
  if (rawOutput !== undefined) {
    const formatted =
      typeof rawOutput === 'string'
        ? rawOutput
        : JSON.stringify(rawOutput, null, 2);
    text += `\n\n--- AI の生出力 ---\n${formatted}`;
  }
  errorBox.textContent = text;
  errorBox.classList.remove('hidden');
}

function clearError(): void {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function bindModifierHighlights(container: HTMLElement): void {
  const modifierSpans = container.querySelectorAll<HTMLElement>('[data-modifies]');
  for (const el of modifierSpans) {
    const targetIdx = el.dataset.modifies;
    if (!targetIdx) continue;
    el.addEventListener('mouseenter', () => {
      const target = container.querySelector<HTMLElement>(
        `[data-span-index="${targetIdx}"]`,
      );
      target?.classList.add('is-highlight-target');
    });
    el.addEventListener('mouseleave', () => {
      const target = container.querySelector<HTMLElement>(
        `[data-span-index="${targetIdx}"]`,
      );
      target?.classList.remove('is-highlight-target');
    });
  }
}

function renderResult(sentence: string, result: AnalyzeResult): void {
  resultSection.classList.remove('hidden');

  const providerPillClass =
    result.provider === 'nano' ? 'pill pill-nano' : 'pill pill-cloud';
  const stars = '★'.repeat(result.analysis.difficulty) + '☆'.repeat(5 - result.analysis.difficulty);

  metaPillsEl.innerHTML = '';
  const sessionLabel = result.sessionCreated
    ? `土台作成: ${result.timing.sessionCreateMs} ms`
    : '土台作成: 0 ms（再利用）';
  const noticeText = result.noticeMessage ?? result.fallbackReason;
  const pills = [
    { text: result.modelName, cls: providerPillClass },
    { text: `難易度 ${result.analysis.difficulty}/5 (${stars})`, cls: 'pill' },
    ...(result.provider === 'nano' ? [{ text: sessionLabel, cls: 'pill' }] : []),
    { text: `解析: ${result.timing.analyzeMs} ms`, cls: 'pill' },
    { text: `合計: ${result.timing.totalMs} ms`, cls: 'pill' },
    ...(result.isExperimentalNano
      ? [{ text: '実験的なモード（精度低）', cls: 'pill pill-cloud' }]
      : []),
    ...(result.attempts > 1
      ? [{ text: `再試行で成功 (${result.attempts}回目)`, cls: 'pill pill-cloud' }]
      : []),
  ];
  for (const p of pills) {
    const span = document.createElement('span');
    span.className = p.cls;
    span.textContent = p.text;
    metaPillsEl.appendChild(span);
  }

  if (noticeText) {
    fallbackBannerEl.textContent = noticeText;
    fallbackBannerEl.classList.remove('hidden');
  } else {
    fallbackBannerEl.textContent = '';
    fallbackBannerEl.classList.add('hidden');
  }

  notationRichEl.innerHTML = renderNotationHtml(sentence, result.analysis);
  bindModifierHighlights(notationRichEl);

  notationTextEl.textContent = formatNotationText(sentence, result.analysis, {
    multiline: true,
  });

  constructsListEl.innerHTML = '';
  if (result.analysis.constructs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'construct-desc';
    empty.textContent = '特別な難構文は検出されませんでした。';
    constructsListEl.appendChild(empty);
  } else {
    for (const cid of result.analysis.constructs) {
      const def = EN_CONSTRUCTS[cid];
      const card = document.createElement('div');
      card.className = 'construct-card';

      const title = document.createElement('div');
      title.className = 'construct-title';
      title.textContent = def.labelJa;

      const idSpan = document.createElement('span');
      idSpan.className = 'construct-id';
      idSpan.textContent = cid;
      title.appendChild(idSpan);

      const desc = document.createElement('p');
      desc.className = 'construct-desc';
      desc.textContent = def.explanationJa;

      card.appendChild(title);
      card.appendChild(desc);
      constructsListEl.appendChild(card);
    }
  }

  jsonStatsEl.textContent = `spans: ${result.analysis.spans.length}件 / 文字数: ${sentence.length}`;
  jsonOutputEl.textContent = JSON.stringify(result.analysis, null, 2);

  try {
    rawJsonOutputEl.textContent = JSON.stringify(
      JSON.parse(result.rawText),
      null,
      2,
    );
  } catch {
    rawJsonOutputEl.textContent = result.rawText;
  }
}

async function runAnalysis(): Promise<void> {
  const sentence = sentenceInput.value.trim();
  if (!sentence) {
    showError('英文を入力してください。');
    return;
  }

  clearError();
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '解析中...';

  const preferredProvider = providerSelect.value as AiProviderPreference;

  try {
    let result: AnalyzeResult;
    if (
      useServiceWorkerForAi &&
      typeof chrome !== 'undefined' &&
      chrome.runtime?.sendMessage
    ) {
      const res = (await chrome.runtime.sendMessage({
        type: 'ANALYZE_SENTENCE',
        sentence,
        preferredProvider,
        allowNanoDownload: true,
      })) as SwResponse<AnalyzeResult>;

      if (!res?.ok || !res.data) {
        const timingNote = res?.timing
          ? `\n（土台作成: ${res.timing.sessionCreateMs} ms / 解析: ${res.timing.analyzeMs} ms / 試行: ${res.attempts ?? 1}回）`
          : '';
        showError(
          `${res?.error ?? 'Service Worker での解析に失敗しました。'}${timingNote}`,
          res?.rawText ?? res?.rawOutput,
        );
        return;
      }
      result = res.data;
    } else {
      result = await analyzeSentence(sentence, {
        preferredProvider,
        allowNanoDownload: true,
      });
    }

    renderResult(sentence, result);
  } catch (err) {
    if (err instanceof AnalysisValidationError) {
      showError(
        `解析結果の検証エラー（${err.code}）: ${err.message}`,
        err.rawOutput,
      );
    } else {
      showError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '構文を解析する';
  }
}

loadSampleBtn.addEventListener('click', () => {
  sentenceInput.value = SPEC_SAMPLE_SENTENCE;
  clearError();
});

analyzeBtn.addEventListener('click', () => {
  void runAnalysis();
});

// Ctrl+Enter で解析を実行できるようにする
sentenceInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void runAnalysis();
  }
});

// 検証ツールから直接プローブ実行できるように公開する
(window as unknown as Record<string, unknown>).__kaidokuRunFullProbe =
  async () => {
    const [swProbe, pageProbe] = await Promise.all([
      probeServiceWorker(true),
      probePromptApi('extension_page', true),
    ]);
    return { swProbe, pageProbe };
  };

void refreshEnvironmentStatus();
