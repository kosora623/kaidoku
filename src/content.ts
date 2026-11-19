import { EN_CONSTRUCTS } from './lang/en/constructs';
import {
  extractPageSentences,
  type ExtractedDomSentence,
} from './lang/en/sentence-splitter';
import { renderNotationHtml } from './notation';
import type {
  AnalyzeResult,
  ConstructId,
  MarkedSentencePayload,
  MarkLevel,
} from './types';

/** CSS Custom Highlight API の最小型宣言 */
interface HighlightInstance {
  add(range: AbstractRange): void;
  clear(): void;
}
interface HighlightRegistry {
  set(name: string, highlight: HighlightInstance): void;
  delete(name: string): boolean;
}
declare global {
  interface Window {
    __kaidokuContentInitialized?: boolean;
    Highlight?: new (...ranges: AbstractRange[]) => HighlightInstance;
  }
}

interface MarkedItemRuntime {
  dom: ExtractedDomSentence;
  payload: MarkedSentencePayload;
}

const HIGHLIGHT_NAMES: Record<Exclude<MarkLevel, 0>, string> = {
  1: 'kaidoku-mark-1',
  2: 'kaidoku-mark-2',
  3: 'kaidoku-mark-3',
};
const ACTIVE_HIGHLIGHT_NAME = 'kaidoku-active';
const STYLE_ELEMENT_ID = 'kaidoku-highlight-style';
const SHADOW_HOST_ID = 'kaidoku-shadow-host';

/** 本文 DOM を書き換えずに色付けするための ::highlight スタイルを注入する */
function ensureHighlightStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    ::highlight(${HIGHLIGHT_NAMES[1]}) {
      background-color: rgba(254, 240, 138, 0.48);
    }
    ::highlight(${HIGHLIGHT_NAMES[2]}) {
      background-color: rgba(253, 224, 71, 0.68);
    }
    ::highlight(${HIGHLIGHT_NAMES[3]}) {
      background-color: rgba(250, 204, 21, 0.88);
      text-decoration: underline wavy #d97706;
    }
    ::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
      background-color: rgba(147, 197, 253, 0.52);
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function getCssHighlights(): HighlightRegistry | null {
  const cssObj = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return cssObj?.highlights ?? null;
}

function clearAllHighlights(): void {
  const registry = getCssHighlights();
  if (!registry) return;
  registry.delete(HIGHLIGHT_NAMES[1]);
  registry.delete(HIGHLIGHT_NAMES[2]);
  registry.delete(HIGHLIGHT_NAMES[3]);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

function applyHighlights(items: MarkedItemRuntime[]): void {
  const registry = getCssHighlights();
  const HighlightCtor = window.Highlight;
  if (!registry || !HighlightCtor) return;

  ensureHighlightStyles();
  clearAllHighlights();

  const buckets: Record<Exclude<MarkLevel, 0>, Range[]> = {
    1: [],
    2: [],
    3: [],
  };

  for (const item of items) {
    const level = item.payload.markLevel;
    if (level === 1 || level === 2 || level === 3) {
      buckets[level].push(item.dom.range);
    }
  }

  for (const level of [1, 2, 3] as const) {
    if (buckets[level].length > 0) {
      registry.set(HIGHLIGHT_NAMES[level], new HighlightCtor(...buckets[level]));
    }
  }
}

function setActiveHighlight(range: Range | null): void {
  const registry = getCssHighlights();
  const HighlightCtor = window.Highlight;
  if (!registry || !HighlightCtor) return;

  if (!range) {
    registry.delete(ACTIVE_HIGHLIGHT_NAME);
    return;
  }
  registry.set(ACTIVE_HIGHLIGHT_NAME, new HighlightCtor(range));
}

/** document.caretPositionFromPoint を用いてクリック位置に重なるマーク文を特定する */
function findMarkedItemAtPoint(
  x: number,
  y: number,
  items: MarkedItemRuntime[],
): MarkedItemRuntime | null {
  let node: Node | null = null;
  let offset = 0;

  if (typeof document.caretPositionFromPoint === 'function') {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }

  if (!node) return null;

  for (const item of items) {
    try {
      if (item.dom.range.comparePoint(node, offset) === 0) {
        return item;
      }
    } catch {
      // 別ドキュメント等で比較不能な Range はスキップ
    }
  }
  return null;
}

/** Shadow DOM の UI ホストを作成する（ページ CSS と完全に隔離する） */
function createShadowUi(callbacks: {
  onRefresh: () => void;
  onClearMarks: () => void;
  onClosePanel: () => void;
  onFeedback: (result: 'understood' | 'unsure') => void;
}) {
  let host = document.getElementById(SHADOW_HOST_ID);
  if (host) {
    host.remove();
  }
  host = document.createElement('div');
  host.id = SHADOW_HOST_ID;
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        font-family: 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', sans-serif;
      }
      .status-bar {
        position: fixed;
        top: 14px;
        right: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        box-shadow: 0 4px 16px rgba(15, 23, 42, 0.14);
        font-size: 12.5px;
        line-height: 1.4;
      }
      .logo {
        font-family: Georgia, serif;
        font-style: italic;
        font-weight: 700;
        color: #2563eb;
        font-size: 15px;
      }
      .bar-btn {
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #1e293b;
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .bar-btn:hover {
        background: #e2e8f0;
      }
      .panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: min(560px, calc(100vw - 32px));
        max-height: 75vh;
        overflow-y: auto;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 14px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
        padding: 16px 18px;
        font-size: 13.5px;
        line-height: 1.6;
      }
      .hidden {
        display: none !important;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .panel-title {
        font-weight: 700;
        font-size: 14px;
      }
      .notice {
        padding: 8px 10px;
        margin-bottom: 10px;
        border-radius: 8px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        color: #92400e;
        font-size: 12px;
      }
      .error {
        padding: 10px 12px;
        border-radius: 8px;
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: #991b1b;
        font-size: 12.5px;
      }
      .notation-box {
        padding: 14px 16px;
        border-radius: 10px;
        background: #fafcff;
        border: 1px solid #dbe4f3;
        font-family: Georgia, 'Times New Roman', serif;
        font-size: 17px;
        line-height: 2.1;
        margin-bottom: 12px;
        overflow-wrap: break-word;
      }
      .kaidoku-span { padding: 1px 2px; border-radius: 4px; }
      .kaidoku-bracket-noun { background: rgba(37, 99, 235, 0.08); }
      .kaidoku-bracket-adj { background: rgba(5, 150, 105, 0.09); }
      .kaidoku-bracket-adv { background: rgba(217, 119, 6, 0.09); }
      .kaidoku-delim { font-family: ui-monospace, Consolas, monospace; font-weight: 800; padding: 0 1px; }
      .kaidoku-delim-noun { color: #1d4ed8; }
      .kaidoku-delim-adj { color: #047857; }
      .kaidoku-delim-adv { color: #b45309; }
      .kaidoku-role-badge {
        display: inline-block;
        margin-left: 2px;
        padding: 1px 5px;
        border-radius: 4px;
        font-family: 'Segoe UI', sans-serif;
        font-size: 10px;
        font-weight: 800;
        color: #ffffff;
        vertical-align: super;
      }
      .kaidoku-role-badge-S { background: #1d4ed8; }
      .kaidoku-role-badge-V { background: #dc2626; }
      .kaidoku-role-badge-O { background: #7c3aed; }
      .kaidoku-role-badge-C { background: #0f766e; }
      .construct-item {
        padding: 8px 10px;
        margin-bottom: 6px;
        border-radius: 8px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
      }
      .construct-name {
        font-weight: 700;
        font-size: 12.5px;
      }
      .construct-desc {
        margin: 2px 0 0;
        font-size: 12px;
        color: #334155;
      }
      .feedback-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #e2e8f0;
      }
      .fb-btns {
        display: flex;
        gap: 8px;
      }
      .fb-ok {
        background: #dcfce7;
        border: 1px solid #86efac;
        color: #166534;
        border-radius: 8px;
        padding: 6px 12px;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
      }
      .fb-unsure {
        background: #fef3c7;
        border: 1px solid #fcd34d;
        color: #92400e;
        border-radius: 8px;
        padding: 6px 12px;
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
      }
      .fb-msg {
        font-size: 11.5px;
        color: #475569;
      }
    </style>

    <div class="status-bar" id="status-bar">
      <span class="logo">χ読</span>
      <span id="status-text">準備中...</span>
      <button type="button" class="bar-btn" id="refresh-btn">再判定</button>
      <button type="button" class="bar-btn" id="clear-btn">解除</button>
    </div>

    <div class="panel hidden" id="panel">
      <div class="panel-head">
        <span class="panel-title">英文解釈パネル</span>
        <button type="button" class="bar-btn" id="close-panel-btn">閉じる</button>
      </div>
      <div class="notice hidden" id="panel-notice"></div>
      <div id="panel-body"></div>
      <div class="feedback-row hidden" id="feedback-row">
        <div class="fb-btns">
          <button type="button" class="fb-ok" id="btn-understood">分かった</button>
          <button type="button" class="fb-unsure" id="btn-unsure">まだ怪しい</button>
        </div>
        <span class="fb-msg" id="fb-msg"></span>
      </div>
    </div>
  `;

  const statusText = shadow.getElementById('status-text') as HTMLSpanElement;
  const refreshBtn = shadow.getElementById('refresh-btn') as HTMLButtonElement;
  const clearBtn = shadow.getElementById('clear-btn') as HTMLButtonElement;
  const panel = shadow.getElementById('panel') as HTMLDivElement;
  const panelNotice = shadow.getElementById('panel-notice') as HTMLDivElement;
  const panelBody = shadow.getElementById('panel-body') as HTMLDivElement;
  const closePanelBtn = shadow.getElementById('close-panel-btn') as HTMLButtonElement;
  const feedbackRow = shadow.getElementById('feedback-row') as HTMLDivElement;
  const btnUnderstood = shadow.getElementById('btn-understood') as HTMLButtonElement;
  const btnUnsure = shadow.getElementById('btn-unsure') as HTMLButtonElement;
  const fbMsg = shadow.getElementById('fb-msg') as HTMLSpanElement;

  refreshBtn.addEventListener('click', callbacks.onRefresh);
  clearBtn.addEventListener('click', callbacks.onClearMarks);
  closePanelBtn.addEventListener('click', callbacks.onClosePanel);
  btnUnderstood.addEventListener('click', () => callbacks.onFeedback('understood'));
  btnUnsure.addEventListener('click', () => callbacks.onFeedback('unsure'));

  return {
    host,
    setStatus(text: string) {
      statusText.textContent = text;
    },
    showPanelLoading(sentence: string) {
      panel.classList.remove('hidden');
      panelNotice.classList.add('hidden');
      feedbackRow.classList.add('hidden');
      fbMsg.textContent = '';
      panelBody.innerHTML = `<div class="notation-box"></div><p style="margin:0;color:#475569;">構文を解析しています...</p>`;
      const box = panelBody.querySelector('.notation-box');
      if (box) box.textContent = sentence;
    },
    showPanelResult(sentence: string, result: AnalyzeResult) {
      panel.classList.remove('hidden');
      if (result.noticeMessage) {
        panelNotice.textContent = result.noticeMessage;
        panelNotice.classList.remove('hidden');
      } else {
        panelNotice.classList.add('hidden');
      }

      const constructsHtml =
        result.analysis.constructs.length === 0
          ? '<p class="construct-desc">特別な難構文は検出されませんでした。</p>'
          : result.analysis.constructs
              .map((cid) => {
                const def = EN_CONSTRUCTS[cid];
                return `<div class="construct-item"><div class="construct-name">${def.labelJa} (${cid})</div><p class="construct-desc">${def.explanationJa}</p></div>`;
              })
              .join('');

      panelBody.innerHTML = `
        <div class="notation-box">${renderNotationHtml(sentence, result.analysis)}</div>
        <div>${constructsHtml}</div>
      `;
      feedbackRow.classList.remove('hidden');
      fbMsg.textContent = `${result.modelName} / ${result.timing.analyzeMs} ms`;
    },
    showPanelError(message: string) {
      panel.classList.remove('hidden');
      panelNotice.classList.add('hidden');
      feedbackRow.classList.add('hidden');
      panelBody.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'error';
      errDiv.textContent = message;
      panelBody.appendChild(errDiv);
    },
    setFeedbackMessage(msg: string) {
      fbMsg.textContent = msg;
    },
    hidePanel() {
      panel.classList.add('hidden');
    },
    destroy() {
      host?.remove();
    },
  };
}

/** ページ内での難文マークとタップ解析を初期化する（二重注入を防止） */
function initKaidokuContent(): void {
  if (window.__kaidokuContentInitialized) return;
  window.__kaidokuContentInitialized = true;

  let markedItems: MarkedItemRuntime[] = [];
  let activeItem: MarkedItemRuntime | null = null;
  let activeAnalysis: AnalyzeResult | null = null;
  let ui: ReturnType<typeof createShadowUi> | null = null;

  async function runMarking(forceRefresh = false): Promise<void> {
    if (!ui) {
      ui = createShadowUi({
        onRefresh: () => void runMarking(true),
        onClearMarks: () => {
          clearAllHighlights();
          markedItems = [];
          activeItem = null;
          activeAnalysis = null;
          ui?.destroy();
          ui = null;
        },
        onClosePanel: () => {
          setActiveHighlight(null);
          activeItem = null;
          activeAnalysis = null;
          ui?.hidePanel();
        },
        onFeedback: (result) => {
          if (!activeItem || !activeAnalysis) return;
          const constructs: ConstructId[] =
            activeAnalysis.analysis.constructs.length > 0
              ? activeAnalysis.analysis.constructs
              : activeItem.payload.constructs;
          void chrome.runtime
            .sendMessage({
              type: 'RECORD_CONSTRUCT_FEEDBACK',
              text: activeItem.dom.text,
              pageUrl: window.location.href,
              pageTitle: document.title,
              constructs,
              result,
              analysis: activeAnalysis.analysis,
            })
            .then(() => {
              ui?.setFeedbackMessage(
                result === 'unsure'
                  ? '苦手構文として記録しました（次回以降マークが濃くなります）'
                  : '「分かった」として記録しました',
              );
            });
        },
      });
    }

    ui.setStatus('本文の英文を抽出中...');
    const extracted = extractPageSentences(document, window);
    const byId = new Map(extracted.map((s) => [s.id, s]));

    ui.setStatus(`難文を判定中（抽出 ${extracted.length} 文）...`);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'MARK_PAGE_SENTENCES',
        pageUrl: window.location.href,
        pageTitle: document.title,
        sentences: extracted.map((s) => ({
          id: s.id,
          sentenceHash: s.sentenceHash,
          text: s.text,
          viewportOrder: s.viewportOrder,
        })),
        forceRefresh,
      })) as {
        ok?: boolean;
        data?: {
          marks: MarkedSentencePayload[];
          fromCache: boolean;
          provider: 'cloud' | 'rule';
          batchCallCount: number;
          markedCount: number;
          notice?: string;
        };
        error?: string;
      };

      if (!response?.ok || !response.data) {
        ui.setStatus(`エラー: ${response?.error ?? '判定に失敗しました'}`);
        return;
      }

      const data = response.data;
      markedItems = [];
      for (const payload of data.marks) {
        const dom = byId.get(payload.id);
        if (dom) {
          markedItems.push({ dom, payload });
        }
      }

      applyHighlights(markedItems);

      const sourceLabel = data.fromCache
        ? 'キャッシュ利用'
        : data.provider === 'cloud'
          ? `クラウド ${data.batchCallCount}回`
          : 'ルール簡易判定';
      ui.setStatus(
        `難文 ${data.markedCount} 件マーク済み（${sourceLabel}・文をタップで図解）`,
      );
    } catch (err) {
      ui.setStatus(
        `エラー: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ページクリック時に caretPositionFromPoint でマーク文を特定して 1 文構造解析を開く
  document.addEventListener('click', (event) => {
    if (markedItems.length === 0 || !ui) return;
    // Shadow DOM 内のクリックやテキスト選択ドラッグは無視
    const target = event.target as HTMLElement | null;
    if (target?.id === SHADOW_HOST_ID || target?.closest?.(`#${SHADOW_HOST_ID}`)) {
      return;
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const hit = findMarkedItemAtPoint(event.clientX, event.clientY, markedItems);
    if (!hit) return;

    activeItem = hit;
    activeAnalysis = null;
    setActiveHighlight(hit.dom.range);
    ui.showPanelLoading(hit.dom.text);

    void chrome.runtime
      .sendMessage({
        type: 'ANALYZE_SENTENCE',
        sentence: hit.dom.text,
        preferredProvider: 'auto',
      })
      .then((res: { ok?: boolean; data?: AnalyzeResult; error?: string }) => {
        if (!res?.ok || !res.data) {
          ui?.showPanelError(res?.error ?? '構文解析に失敗しました。');
          return;
        }
        activeAnalysis = res.data;
        ui?.showPanelResult(hit.dom.text, res.data);
      })
      .catch((err) => {
        ui?.showPanelError(err instanceof Error ? err.message : String(err));
      });
  });

  chrome.runtime?.onMessage.addListener((message: { type?: string }) => {
    if (message?.type === 'KAIDOKU_RUN_MARK') {
      void runMarking(false);
    }
  });
}

initKaidokuContent();
