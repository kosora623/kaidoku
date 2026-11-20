import type { ClauseSkeletonItem } from './ai/prompt';
import { tokenizeWords } from './ai/tokenizer';
import type { TranslateSentenceResult } from './ai/translate';
import type { WordMeaningResult } from './ai/word-meaning';
import {
  computeGutterBars,
  type ComputedGutterBar,
  type GutterSourceItem,
} from './gutter';
import {
  extractPageBodyText,
  findAcronymDefinition,
  findAcronymsInSentence,
  isAcronymWord,
  normalizeAcronymBase,
} from './lang/en/acronym';
import { EN_CONSTRUCTS } from './lang/en/constructs';
import {
  applyRelativePageMarks,
  calculateDifficultyAndMarkLevel,
  countWords,
} from './lang/en/difficulty';
import {
  extractPageSentences,
  type ExtractedDomSentence,
} from './lang/en/sentence-splitter';
import { renderNotationHtml } from './notation';
import type {
  AnalyzeResult,
  AnalyzeTiming,
  ConstructId,
  MarkDensity,
  MarkedSentencePayload,
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

const HOVER_HIGHLIGHT_NAME = 'kaidoku-hover';
const ACTIVE_HIGHLIGHT_NAME = 'kaidoku-active';
const STYLE_ELEMENT_ID = 'kaidoku-highlight-style';
const SHADOW_HOST_ID = 'kaidoku-shadow-host';

/**
 * 本文 DOM を書き換えずにホバー・選択中だけを装飾するための ::highlight スタイルを注入する。
 * 通常マークは本文に常時の下線・背景色を付けず左余白の縦線（ガター）で表し、
 * マウスホバー時のみ薄い点線下線＋半透明背景、選択中のみ半透明青背景を付ける。
 */
function ensureHighlightStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    ::highlight(${HOVER_HIGHLIGHT_NAME}) {
      background-color: rgba(139, 92, 246, 0.14);
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: rgba(139, 92, 246, 0.68);
      text-decoration-thickness: 1.5px;
    }
    ::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
      background-color: rgba(59, 130, 246, 0.24);
      text-decoration-line: underline;
      text-decoration-style: solid;
      text-decoration-color: rgba(59, 130, 246, 0.85);
      text-decoration-thickness: 2px;
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
  registry.delete(HOVER_HIGHLIGHT_NAME);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

function setHoverHighlight(range: Range | null): void {
  const registry = getCssHighlights();
  const HighlightCtor = window.Highlight;
  if (!registry || !HighlightCtor) return;

  ensureHighlightStyles();
  if (!range) {
    registry.delete(HOVER_HIGHLIGHT_NAME);
    return;
  }
  registry.set(HOVER_HIGHLIGHT_NAME, new HighlightCtor(range));
}

function setActiveHighlight(range: Range | null): void {
  const registry = getCssHighlights();
  const HighlightCtor = window.Highlight;
  if (!registry || !HighlightCtor) return;

  ensureHighlightStyles();
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
    if (item.payload.markLevel <= 0) continue;
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

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 所要時間の内訳（1段目 / 2段目 / 再試行 / 429・503等待機）を日本語で整形する */
function formatTimingBreakdown(timing: AnalyzeTiming): string {
  const s1 = timing.stage1Ms !== undefined ? `${timing.stage1Ms} ms` : 'なし';
  const s2 =
    timing.stage2Ms !== undefined
      ? `${timing.stage2Ms} ms`
      : `${timing.analyzeMs} ms`;
  const retry = `${timing.retryMs ?? 0} ms`;
  const wait = `${timing.waitMs ?? 0} ms`;
  return `合計 ${timing.analyzeMs} ms（1段目: ${s1} / 2段目: ${s2} / 再試行: ${retry} / 429・503等待機: ${wait}）`;
}

/** 2段階解析の 1 段目結果（主節 S・V と節の区切り）を文の骨組みプレビュー HTML に変換する */
function renderStage1SkeletonHtml(
  sentence: string,
  clauses: ClauseSkeletonItem[],
): string {
  const tokens = tokenizeWords(sentence);
  if (tokens.length === 0 || clauses.length === 0) {
    return `<div class="notation-box">${escapeHtml(sentence)}</div>`;
  }

  // 文字範囲のマーキング（主節 S / 主節 V / 等位接続詞）を収集
  type HighlightMark = {
    start: number;
    end: number;
    kind: 'S' | 'V' | 'coord';
  };
  const marks: HighlightMark[] = [];

  for (const c of clauses) {
    if (
      c.coordinatorWord !== undefined &&
      tokens[c.coordinatorWord]
    ) {
      const t = tokens[c.coordinatorWord];
      marks.push({ start: t.start, end: t.end, kind: 'coord' });
    }
    for (const s of c.subjects) {
      if (tokens[s.startWord] && tokens[s.endWord]) {
        marks.push({
          start: tokens[s.startWord].start,
          end: tokens[s.endWord].end,
          kind: 'S',
        });
      }
    }
    for (const v of c.mainVerbs) {
      if (tokens[v.startWord] && tokens[v.endWord]) {
        marks.push({
          start: tokens[v.startWord].start,
          end: tokens[v.endWord].end,
          kind: 'V',
        });
      }
    }
  }

  marks.sort((a, b) => a.start - b.start || b.end - a.end);

  let inlineHtml = '';
  let cursor = 0;
  for (const m of marks) {
    if (m.start < cursor) continue;
    if (m.start > cursor) {
      inlineHtml += escapeHtml(sentence.slice(cursor, m.start));
    }
    const piece = escapeHtml(sentence.slice(m.start, m.end));
    if (m.kind === 'coord') {
      inlineHtml += `<span class="skeleton-coord">｜${piece}｜</span>`;
    } else if (m.kind === 'S') {
      inlineHtml += `<span class="kaidoku-span kaidoku-bracket-noun">${piece}<sup class="kaidoku-role-badge kaidoku-role-badge-S">S</sup></span>`;
    } else {
      inlineHtml += `<span class="kaidoku-span">${piece}<sup class="kaidoku-role-badge kaidoku-role-badge-V">V</sup></span>`;
    }
    cursor = m.end;
  }
  if (cursor < sentence.length) {
    inlineHtml += escapeHtml(sentence.slice(cursor));
  }

  const clauseSummary = clauses
    .map((c, idx) => {
      const coord = c.coordinatorText
        ? `<span class="skeleton-coord-tag">接続: ${escapeHtml(c.coordinatorText)}</span> `
        : '';
      const sText =
        c.subjects.length > 0
          ? c.subjects.map((s) => escapeHtml(s.text)).join(' / ')
          : '（省略・共有）';
      const vText = c.mainVerbs.map((v) => escapeHtml(v.text)).join(' / ');
      return `<div class="skeleton-clause-item">${coord}<strong>節${idx + 1}</strong>：S = <code>${sText}</code> ／ V = <code>${vText}</code></div>`;
    })
    .join('');

  return `
    <div class="notation-box">${inlineHtml}</div>
    <div class="skeleton-summary">${clauseSummary}</div>
  `;
}

/** Shadow DOM の UI ホストを作成する（ページ CSS と完全に隔離する） */
function createShadowUi(callbacks: {
  onRefresh: () => void;
  onChangeDensity: (density: MarkDensity) => void;
  onOpenReview: () => void;
  onOpenOptions: () => void;
  onOpenConsent: () => void;
  onClearMarks: () => void;
  onClosePanel: () => void;
  onFeedback: (result: 'understood' | 'unsure') => void;
  onWordClick: (word: string) => void;
  onGuessAcronym: (word: string) => void;
  onSaveWord: (meaning: WordMeaningResult) => void;
  onToggleTranslation: () => void;
  onGutterHover: (id: string | null) => void;
  onGutterClick: (id: string) => void;
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
      .word-hint {
        margin: -6px 0 10px;
        font-size: 11.5px;
        color: #64748b;
      }
      .kaidoku-word {
        cursor: pointer;
        border-radius: 3px;
        transition: background-color 0.12s ease;
      }
      .kaidoku-word:hover {
        background: rgba(37, 99, 235, 0.16);
        text-decoration: underline dotted #2563eb;
      }
      .kaidoku-word.is-selected {
        background: rgba(37, 99, 235, 0.24);
        outline: 1px solid rgba(37, 99, 235, 0.5);
      }
      .word-card {
        margin: 0 0 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: #f0f9ff;
        border: 1px solid #bae6fd;
      }
      .word-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
      }
      .word-head-left {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }
      .word-term {
        font-family: Georgia, serif;
        font-weight: 700;
        font-size: 15px;
        color: #0c4a6e;
      }
      .word-lemma {
        font-size: 11.5px;
        color: #475569;
      }
      .word-pos {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 999px;
        background: #e0f2fe;
        color: #0369a1;
        font-size: 11px;
        font-weight: 700;
      }
      .word-meaning {
        margin: 4px 0 8px;
        font-size: 13.5px;
        font-weight: 600;
        color: #0f172a;
      }
      .word-card-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .word-save-btn {
        border: 1px solid #0284c7;
        background: #0284c7;
        color: #ffffff;
        border-radius: 7px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .word-save-btn:hover:not(:disabled) {
        background: #0369a1;
      }
      .word-save-btn:disabled {
        opacity: 0.65;
        cursor: default;
      }
      .word-status {
        font-size: 11.5px;
        color: #0369a1;
      }
      .word-acronym-def {
        margin: 4px 0 6px;
        padding: 5px 8px;
        border-radius: 6px;
        background: #e0f2fe;
        border: 1px solid #7dd3fc;
        color: #0c4a6e;
        font-size: 12px;
        line-height: 1.45;
      }
      .word-acronym-missing {
        margin: 4px 0 8px;
        padding: 6px 9px;
        border-radius: 6px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        color: #92400e;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.45;
      }
      .word-guess-badge {
        display: inline-block;
        margin-right: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        background: #fef3c7;
        border: 1px solid #f59e0b;
        color: #92400e;
        font-size: 11px;
        font-weight: 700;
        vertical-align: middle;
      }
      .word-guess-btn {
        border: 1px solid #d97706;
        background: #fffbeb;
        color: #92400e;
        border-radius: 7px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .word-guess-btn:hover:not(:disabled) {
        background: #fef3c7;
      }
      .translation-section {
        margin: 0 0 12px;
      }
      .translation-toggle-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #1e293b;
        border-radius: 8px;
        padding: 5px 11px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .translation-toggle-btn:hover {
        background: #eef2ff;
        border-color: #a5b4fc;
        color: #3730a3;
      }
      .translation-chevron {
        font-size: 10px;
        color: #64748b;
      }
      .translation-body {
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 10px;
        background: #f8fafc;
        border: 1px solid #cbd5e1;
      }
      .translation-text {
        margin: 0;
        font-size: 13.5px;
        line-height: 1.7;
        color: #0f172a;
      }
      .translation-loading {
        margin: 0;
        font-size: 12.5px;
        color: #475569;
      }
      .translation-meta {
        margin: 6px 0 0;
        font-size: 11.5px;
        line-height: 1.45;
        color: #475569;
      }
      .density-group {
        display: inline-flex;
        align-items: center;
        background: #f1f5f9;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        padding: 2px;
        gap: 2px;
      }
      .density-btn {
        border: none;
        background: transparent;
        color: #475569;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .density-btn.is-active {
        background: #2563eb;
        color: #ffffff;
      }
      .skeleton-banner {
        margin: 0 0 10px;
        padding: 7px 10px;
        border-radius: 8px;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        color: #1e40af;
        font-size: 12px;
        font-weight: 600;
      }
      .skeleton-coord {
        display: inline-block;
        padding: 0 4px;
        margin: 0 2px;
        border-radius: 4px;
        background: #fef3c7;
        color: #92400e;
        font-family: 'Segoe UI', sans-serif;
        font-size: 12.5px;
        font-weight: 700;
      }
      .skeleton-summary {
        margin: 0 0 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .skeleton-clause-item {
        padding: 6px 10px;
        border-radius: 7px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        font-size: 12px;
        color: #334155;
      }
      .skeleton-coord-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 999px;
        background: #fef3c7;
        color: #92400e;
        font-size: 11px;
        font-weight: 700;
      }
      .timing-line {
        margin-top: 8px;
        font-size: 11.5px;
        color: #64748b;
        line-height: 1.45;
      }
      .gutter-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
      }
      .gutter-hit {
        position: fixed;
        width: 14px;
        transform: translateX(-50%);
        pointer-events: auto;
        cursor: pointer;
        border: none;
        background: transparent;
        padding: 0;
        margin: 0;
        display: flex;
        justify-content: center;
        align-items: stretch;
      }
      .gutter-bar {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: #8b5cf6;
        transition: opacity 0.12s ease, transform 0.12s ease, background-color 0.12s ease;
      }
      .gutter-level-1 .gutter-bar {
        width: 2.5px;
        opacity: 0.36;
      }
      .gutter-level-2 .gutter-bar {
        width: 4px;
        opacity: 0.68;
      }
      .gutter-level-3 .gutter-bar {
        width: 6px;
        opacity: 0.96;
      }
      .gutter-hit.is-hover .gutter-bar,
      .gutter-hit:hover .gutter-bar {
        opacity: 1;
        transform: scaleX(1.25);
      }
      .fb-ok:disabled,
      .fb-unsure:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .status-notice {
        position: fixed;
        top: 56px;
        right: 16px;
        max-width: min(440px, calc(100vw - 32px));
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 10px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        color: #92400e;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.12);
        font-size: 12px;
        line-height: 1.45;
      }
      .status-notice-text {
        flex: 1;
      }
      .error-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        flex-wrap: wrap;
      }
      .gutter-hit.is-active .gutter-bar {
        background: #3b82f6;
        opacity: 1;
        transform: scaleX(1.3);
      }
    </style>

    <div class="gutter-layer" id="gutter-layer" aria-label="難文ガターマーク"></div>

    <div class="status-bar" id="status-bar">
      <span class="logo">χ読</span>
      <span id="status-text">準備中...</span>
      <div class="density-group" id="density-group" role="group" aria-label="マーク量の切替">
        <button type="button" class="density-btn" data-density="low" title="スコア上位10%">少なめ</button>
        <button type="button" class="density-btn is-active" data-density="normal" title="スコア上位20%">ふつう</button>
        <button type="button" class="density-btn" data-density="high" title="スコア上位40%">多め</button>
      </div>
      <button type="button" class="bar-btn" id="review-btn">復習</button>
      <button type="button" class="bar-btn" id="options-btn">設定</button>
      <button type="button" class="bar-btn" id="refresh-btn">再判定</button>
      <button type="button" class="bar-btn" id="clear-btn">解除</button>
    </div>

    <div class="status-notice hidden" id="status-notice" role="status"></div>

    <div class="panel hidden" id="panel">
      <div class="panel-head">
        <span class="panel-title">英文解釈パネル</span>
        <button type="button" class="bar-btn" id="close-panel-btn">閉じる</button>
      </div>
      <div class="notice hidden" id="panel-notice"></div>
      <div id="panel-body"></div>
      <div class="word-card hidden" id="word-card"></div>
      <div class="feedback-row hidden" id="feedback-row">
        <div class="fb-btns">
          <button type="button" class="fb-ok" id="btn-understood">分かった</button>
          <button type="button" class="fb-unsure" id="btn-unsure">まだ怪しい</button>
        </div>
        <span class="fb-msg" id="fb-msg"></span>
      </div>
      <div class="timing-line hidden" id="timing-line"></div>
    </div>
  `;

  const gutterLayer = shadow.getElementById('gutter-layer') as HTMLDivElement;
  const statusText = shadow.getElementById('status-text') as HTMLSpanElement;
  const statusNotice = shadow.getElementById('status-notice') as HTMLDivElement;
  const densityBtns = Array.from(
    shadow.querySelectorAll<HTMLButtonElement>('.density-btn'),
  );
  const reviewBtn = shadow.getElementById('review-btn') as HTMLButtonElement;
  const optionsBtn = shadow.getElementById('options-btn') as HTMLButtonElement;
  const refreshBtn = shadow.getElementById('refresh-btn') as HTMLButtonElement;
  const clearBtn = shadow.getElementById('clear-btn') as HTMLButtonElement;
  const panel = shadow.getElementById('panel') as HTMLDivElement;
  const panelNotice = shadow.getElementById('panel-notice') as HTMLDivElement;
  const panelBody = shadow.getElementById('panel-body') as HTMLDivElement;
  const wordCard = shadow.getElementById('word-card') as HTMLDivElement;
  const closePanelBtn = shadow.getElementById('close-panel-btn') as HTMLButtonElement;
  const feedbackRow = shadow.getElementById('feedback-row') as HTMLDivElement;
  const btnUnderstood = shadow.getElementById('btn-understood') as HTMLButtonElement;
  const btnUnsure = shadow.getElementById('btn-unsure') as HTMLButtonElement;
  const fbMsg = shadow.getElementById('fb-msg') as HTMLSpanElement;
  const timingLine = shadow.getElementById('timing-line') as HTMLDivElement;

  let showDeveloperTiming = false;

  for (const btn of densityBtns) {
    btn.addEventListener('click', () => {
      const d = btn.dataset.density as MarkDensity | undefined;
      if (d === 'low' || d === 'normal' || d === 'high') {
        callbacks.onChangeDensity(d);
      }
    });
  }
  reviewBtn.addEventListener('click', callbacks.onOpenReview);
  optionsBtn.addEventListener('click', callbacks.onOpenOptions);
  refreshBtn.addEventListener('click', callbacks.onRefresh);
  clearBtn.addEventListener('click', callbacks.onClearMarks);
  closePanelBtn.addEventListener('click', callbacks.onClosePanel);
  btnUnderstood.addEventListener('click', () => callbacks.onFeedback('understood'));
  btnUnsure.addEventListener('click', () => callbacks.onFeedback('unsure'));

  function buildErrorBox(message: string): HTMLDivElement {
    const errDiv = document.createElement('div');
    errDiv.className = 'error';
    const textEl = document.createElement('div');
    textEl.textContent = message;
    errDiv.appendChild(textEl);

    const needsConsent = /同意|consent\.html/.test(message);
    const needsOptions = /API キー|options\.html|設定画面/.test(message);
    if (needsConsent || needsOptions) {
      const actions = document.createElement('div');
      actions.className = 'error-actions';
      if (needsConsent) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bar-btn';
        btn.textContent = '同意画面を開く';
        btn.addEventListener('click', callbacks.onOpenConsent);
        actions.appendChild(btn);
      }
      if (needsOptions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bar-btn';
        btn.textContent = '設定画面を開く';
        btn.addEventListener('click', callbacks.onOpenOptions);
        actions.appendChild(btn);
      }
      errDiv.appendChild(actions);
    }
    return errDiv;
  }

  // 解析パネル内の単語タップ（クリック／Enter・Space）をイベント委譲で処理する
  function triggerWordSelect(targetEl: HTMLElement): void {
    const word = targetEl.dataset.word?.trim();
    if (!word) return;
    for (const prev of panelBody.querySelectorAll('.kaidoku-word.is-selected')) {
      prev.classList.remove('is-selected');
    }
    targetEl.classList.add('is-selected');
    callbacks.onWordClick(word);
  }

  panelBody.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const toggleBtn = target?.closest?.('#btn-toggle-translation');
    if (toggleBtn) {
      callbacks.onToggleTranslation();
      return;
    }
    const el = target?.closest?.('.kaidoku-word') as HTMLElement | null;
    if (el) {
      triggerWordSelect(el);
    }
  });

  panelBody.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = (event.target as HTMLElement | null)?.closest?.(
      '.kaidoku-word',
    ) as HTMLElement | null;
    if (el) {
      event.preventDefault();
      triggerWordSelect(el);
    }
  });

  function clearWordCard(): void {
    wordCard.classList.add('hidden');
    wordCard.innerHTML = '';
  }

  return {
    host,
    renderGutters(
      bars: ComputedGutterBar[],
      activeId: string | null,
      hoveredId: string | null,
    ) {
      gutterLayer.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const bar of bars) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `gutter-hit gutter-level-${bar.markLevel}`;
        if (bar.id === activeId) btn.classList.add('is-active');
        if (bar.id === hoveredId) btn.classList.add('is-hover');
        btn.dataset.sentenceId = bar.id;
        btn.style.left = `${bar.left}px`;
        btn.style.top = `${bar.top}px`;
        btn.style.height = `${bar.height}px`;
        btn.setAttribute('aria-label', '難文の構造解析を開く');

        const pill = document.createElement('span');
        pill.className = 'gutter-bar';
        btn.appendChild(pill);

        btn.addEventListener('mouseenter', () => callbacks.onGutterHover(bar.id));
        btn.addEventListener('mouseleave', () => callbacks.onGutterHover(null));
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          callbacks.onGutterClick(bar.id);
        });
        frag.appendChild(btn);
      }
      gutterLayer.appendChild(frag);
    },
    syncGutterStates(activeId: string | null, hoveredId: string | null) {
      for (const el of gutterLayer.querySelectorAll<HTMLElement>('.gutter-hit')) {
        const id = el.dataset.sentenceId ?? null;
        el.classList.toggle('is-active', Boolean(activeId && id === activeId));
        el.classList.toggle('is-hover', Boolean(hoveredId && id === hoveredId));
      }
    },
    setStatus(text: string) {
      statusText.textContent = text;
    },
    setStatusNotice(message: string | null) {
      if (!message) {
        statusNotice.classList.add('hidden');
        statusNotice.innerHTML = '';
        return;
      }
      statusNotice.classList.remove('hidden');
      statusNotice.innerHTML = '';

      const textSpan = document.createElement('span');
      textSpan.className = 'status-notice-text';
      textSpan.textContent = message;
      statusNotice.appendChild(textSpan);

      if (/同意|consent\.html/.test(message)) {
        const consentBtn = document.createElement('button');
        consentBtn.type = 'button';
        consentBtn.className = 'bar-btn';
        consentBtn.textContent = '同意画面';
        consentBtn.addEventListener('click', callbacks.onOpenConsent);
        statusNotice.appendChild(consentBtn);
      } else if (/API キー|設定画面/.test(message)) {
        const optBtn = document.createElement('button');
        optBtn.type = 'button';
        optBtn.className = 'bar-btn';
        optBtn.textContent = '設定を開く';
        optBtn.addEventListener('click', callbacks.onOpenOptions);
        statusNotice.appendChild(optBtn);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'bar-btn';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', 'お知らせを閉じる');
      closeBtn.addEventListener('click', () => {
        statusNotice.classList.add('hidden');
      });
      statusNotice.appendChild(closeBtn);
    },
    setDeveloperMode(enabled: boolean) {
      showDeveloperTiming = enabled;
      if (!enabled) {
        timingLine.classList.add('hidden');
      } else if (timingLine.textContent?.trim()) {
        timingLine.classList.remove('hidden');
      }
    },
    setFeedbackBusy(busy: boolean) {
      btnUnderstood.disabled = busy;
      btnUnsure.disabled = busy;
    },
    setActiveDensity(density: MarkDensity) {
      for (const btn of densityBtns) {
        btn.classList.toggle('is-active', btn.dataset.density === density);
      }
    },
    showPanelLoading(sentence: string, isLongTwoStage = false) {
      panel.classList.remove('hidden');
      panelNotice.classList.add('hidden');
      feedbackRow.classList.add('hidden');
      timingLine.classList.add('hidden');
      timingLine.textContent = '';
      clearWordCard();
      fbMsg.textContent = '';
      const loadingMsg = isLongTwoStage
        ? '長い文のため 2 段階で解析しています（まず 1 段目で主節の S・V と節の区切りを抽出中...）'
        : '構文を解析しています...';
      panelBody.innerHTML = `<div class="notation-box"></div><p style="margin:0;color:#475569;">${loadingMsg}</p>`;
      const box = panelBody.querySelector('.notation-box');
      if (box) box.textContent = sentence;
    },
    showPanelStage1(
      sentence: string,
      clauses: ClauseSkeletonItem[],
      stage1Ms: number,
      waitMs: number,
    ) {
      panel.classList.remove('hidden');
      const waitNote = waitMs > 0 ? ` / 待機: ${waitMs} ms` : '';
      panelBody.innerHTML = `
        <div class="skeleton-banner">1段目完了（文の骨組み：主節の S・V と節の区切り）— 細部の修飾構造を解析中（2段目）...</div>
        ${renderStage1SkeletonHtml(sentence, clauses)}
      `;
      timingLine.textContent = `進行中（1段目: ${stage1Ms} ms${waitNote} / 2段目: 解析中...）`;
      timingLine.classList.toggle('hidden', !showDeveloperTiming);
    },
    showPanelResult(sentence: string, result: AnalyzeResult) {
      panel.classList.remove('hidden');
      clearWordCard();
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
        <div class="notation-box">${renderNotationHtml(sentence, result.analysis, { clickableWords: true })}</div>
        <p class="word-hint">分からない単語をタップすると、この文脈での意味を表示して記録できます。</p>
        <div class="translation-section" id="translation-section">
          <button type="button" class="translation-toggle-btn" id="btn-toggle-translation" aria-expanded="false">
            <span class="translation-chevron" aria-hidden="true">▶</span>
            <span class="translation-btn-label">訳を見る</span>
          </button>
          <div class="translation-body hidden" id="translation-body"></div>
        </div>
        <div>${constructsHtml}</div>
      `;
      feedbackRow.classList.remove('hidden');
      btnUnderstood.disabled = false;
      btnUnsure.disabled = false;
      fbMsg.textContent = result.modelName;
      timingLine.textContent = formatTimingBreakdown(result.timing);
      timingLine.classList.toggle('hidden', !showDeveloperTiming);
    },
    setTranslationExpanded(expanded: boolean) {
      const btn = panelBody.querySelector<HTMLButtonElement>('#btn-toggle-translation');
      const body = panelBody.querySelector<HTMLDivElement>('#translation-body');
      const chevron = btn?.querySelector<HTMLSpanElement>('.translation-chevron');
      const label = btn?.querySelector<HTMLSpanElement>('.translation-btn-label');
      if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (chevron) chevron.textContent = expanded ? '▼' : '▶';
      if (label) label.textContent = expanded ? '訳を隠す' : '訳を見る';
      if (body) body.classList.toggle('hidden', !expanded);
    },
    showTranslationLoading() {
      const body = panelBody.querySelector<HTMLDivElement>('#translation-body');
      if (!body) return;
      body.classList.remove('hidden');
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'translation-loading';
      p.textContent = '自然な日本語訳を生成しています...';
      body.appendChild(p);
    },
    showTranslationResult(data: TranslateSentenceResult) {
      const body = panelBody.querySelector<HTMLDivElement>('#translation-body');
      if (!body) return;
      body.classList.remove('hidden');
      body.innerHTML = '';

      const textEl = document.createElement('p');
      textEl.className = 'translation-text';
      textEl.textContent = data.translationJa;
      body.appendChild(textEl);

      if (data.appliedAcronyms.length > 0) {
        const meta = document.createElement('p');
        meta.className = 'translation-meta';
        const defs = data.appliedAcronyms
          .map((a) => `${a.acronym} = ${a.fullForm}`)
          .join(' ／ ');
        meta.textContent = `ページ内の定義を反映：${defs}`;
        body.appendChild(meta);
      }

      if (data.unresolvedAcronyms.length > 0) {
        const meta = document.createElement('p');
        meta.className = 'translation-meta';
        meta.textContent = `ページ内に定義が見つからない略語（${data.unresolvedAcronyms.join('・')}）は推測せずそのまま表記しています`;
        body.appendChild(meta);
      }
    },
    showTranslationError(message: string) {
      const body = panelBody.querySelector<HTMLDivElement>('#translation-body');
      if (!body) return;
      body.classList.remove('hidden');
      body.innerHTML = '';
      body.appendChild(buildErrorBox(message));
    },
    showWordLoading(word: string, customMessage?: string) {
      wordCard.classList.remove('hidden');
      wordCard.innerHTML = '';
      const p = document.createElement('div');
      p.className = 'word-status';
      p.textContent =
        customMessage ?? `「${word}」の文脈に合う意味を調べています...`;
      wordCard.appendChild(p);
    },
    showWordMeaning(meaning: WordMeaningResult) {
      wordCard.classList.remove('hidden');
      wordCard.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'word-card-head';

      const left = document.createElement('div');
      left.className = 'word-head-left';

      const term = document.createElement('span');
      term.className = 'word-term';
      term.textContent = meaning.word;
      left.appendChild(term);

      if (meaning.lemma.toLowerCase() !== meaning.word.toLowerCase()) {
        const lemma = document.createElement('span');
        lemma.className = 'word-lemma';
        lemma.textContent = `（原形: ${meaning.lemma}）`;
        left.appendChild(lemma);
      }

      const pos = document.createElement('span');
      pos.className = 'word-pos';
      pos.textContent = meaning.partOfSpeech;
      left.appendChild(pos);

      const closeWordBtn = document.createElement('button');
      closeWordBtn.type = 'button';
      closeWordBtn.className = 'bar-btn';
      closeWordBtn.textContent = '×';
      closeWordBtn.setAttribute('aria-label', '単語表示を閉じる');
      closeWordBtn.addEventListener('click', clearWordCard);

      head.appendChild(left);
      head.appendChild(closeWordBtn);
      wordCard.appendChild(head);

      // 略語の場合：ページ内定義の有無を明示する
      if (meaning.isAcronym) {
        if (meaning.acronymDefinition) {
          const defEl = document.createElement('div');
          defEl.className = 'word-acronym-def';
          defEl.textContent = `ページ内の定義：${meaning.acronymDefinition}`;
          wordCard.appendChild(defEl);
        } else {
          const missingEl = document.createElement('div');
          missingEl.className = 'word-acronym-missing';
          missingEl.textContent = 'ページ内に定義が見つかりません';
          wordCard.appendChild(missingEl);
        }
      }

      const actions = document.createElement('div');
      actions.className = 'word-card-actions';

      // ページ内定義が見つからない略語で、まだ AI 推測を実行していない場合
      if (meaning.isAcronym && !meaning.acronymDefinition && !meaning.meaningJa) {
        const guessBtn = document.createElement('button');
        guessBtn.type = 'button';
        guessBtn.className = 'word-guess-btn';
        guessBtn.textContent = 'AI で意味を推測する（参考）';
        guessBtn.addEventListener('click', () => {
          guessBtn.disabled = true;
          callbacks.onGuessAcronym(meaning.word);
        });
        actions.appendChild(guessBtn);
        wordCard.appendChild(actions);
        return;
      }

      const meaningEl = document.createElement('p');
      meaningEl.className = 'word-meaning';
      if (meaning.isGuessed) {
        const guessBadge = document.createElement('span');
        guessBadge.className = 'word-guess-badge';
        guessBadge.textContent = '推測';
        meaningEl.appendChild(guessBadge);
      }
      meaningEl.appendChild(document.createTextNode(meaning.meaningJa));

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'word-save-btn';
      saveBtn.textContent = '元の文ごと記録する';

      const statusSpan = document.createElement('span');
      statusSpan.className = 'word-status';
      statusSpan.id = 'word-save-status';

      saveBtn.addEventListener('click', () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '記録中...';
        callbacks.onSaveWord(meaning);
      });

      actions.appendChild(saveBtn);
      actions.appendChild(statusSpan);

      wordCard.appendChild(meaningEl);
      wordCard.appendChild(actions);
    },
    setWordSaveResult(success: boolean, message: string) {
      const saveBtn = wordCard.querySelector<HTMLButtonElement>('.word-save-btn');
      const statusSpan = wordCard.querySelector<HTMLSpanElement>('#word-save-status');
      if (saveBtn) {
        saveBtn.disabled = success;
        saveBtn.textContent = success ? '記録済み' : '元の文ごと記録する';
      }
      if (statusSpan) {
        statusSpan.textContent = message;
      }
    },
    showWordError(message: string) {
      wordCard.classList.remove('hidden');
      wordCard.innerHTML = '';
      wordCard.appendChild(buildErrorBox(message));
    },
    showPanelError(message: string) {
      panel.classList.remove('hidden');
      panelNotice.classList.add('hidden');
      feedbackRow.classList.add('hidden');
      timingLine.classList.add('hidden');
      timingLine.textContent = '';
      clearWordCard();
      panelBody.innerHTML = '';
      panelBody.appendChild(buildErrorBox(message));
    },
    setFeedbackMessage(msg: string) {
      fbMsg.textContent = msg;
    },
    hidePanel() {
      clearWordCard();
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
  let itemById = new Map<string, MarkedItemRuntime>();
  let totalPageSentences = 0;
  let currentDensity: MarkDensity = 'normal';
  let lastSourceLabel = '';
  let activeItem: MarkedItemRuntime | null = null;
  let hoveredItem: MarkedItemRuntime | null = null;
  let activeAnalysis: AnalyzeResult | null = null;
  let currentAnalyzeRequestId: string | null = null;
  let currentWordRequestId: string | null = null;
  let translationExpanded = false;
  let activeTranslation: TranslateSentenceResult | null = null;
  let currentTranslateRequestId: string | null = null;
  let feedbackBusy = false;
  let developerMode = false;
  let cachedPageBodyText = '';
  let ui: ReturnType<typeof createShadowUi> | null = null;
  let gutterRafId: number | null = null;
  let hoverRafId: number | null = null;
  let lastPointerPos: { x: number; y: number } | null = null;
  let mutationObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let trackingAttached = false;

  /** 現在マーク中の文の Range.getClientRects() から左ガター縦線を再描画する */
  function renderGuttersNow(): void {
    gutterRafId = null;
    if (!ui) return;

    const sources: GutterSourceItem[] = [];
    for (const item of markedItems) {
      const level = item.payload.markLevel;
      if (level !== 1 && level !== 2 && level !== 3) continue;
      try {
        const clientRects = Array.from(item.dom.range.getClientRects());
        if (clientRects.length === 0) continue;
        const blockRect = item.dom.blockElement?.getBoundingClientRect();
        sources.push({
          id: item.payload.id,
          markLevel: level,
          rects: clientRects,
          blockLeft:
            blockRect && blockRect.width > 0 ? blockRect.left : undefined,
        });
      } catch {
        // DOM 変化で一時的に無効になった Range はスキップ
      }
    }

    const bars = computeGutterBars(sources, {
      viewportHeight: window.innerHeight,
    });
    ui.renderGutters(
      bars,
      activeItem?.payload.id ?? null,
      hoveredItem?.payload.id ?? null,
    );
  }

  function scheduleGutterRender(): void {
    if (gutterRafId !== null) return;
    gutterRafId = window.requestAnimationFrame(renderGuttersNow);
  }

  function updateHoveredItem(next: MarkedItemRuntime | null): void {
    if (hoveredItem === next) return;
    hoveredItem = next;
    // 選択中の文にホバーが重なる場合は選択中表示を優先しつつガターだけ同期する
    if (next && next !== activeItem) {
      setHoverHighlight(next.dom.range);
    } else {
      setHoverHighlight(null);
    }
    ui?.syncGutterStates(
      activeItem?.payload.id ?? null,
      hoveredItem?.payload.id ?? null,
    );
  }

  /** スクロール・リサイズ・本文 DOM 変化に追従するリスナ群を接続する */
  function attachLayoutTrackers(): void {
    if (trackingAttached) return;
    trackingAttached = true;
    window.addEventListener('scroll', scheduleGutterRender, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', scheduleGutterRender, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleGutterRender());
      resizeObserver.observe(document.documentElement);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      mutationObserver = new MutationObserver((records) => {
        // 自身の Shadow Host や style 注入による変化は無視して無限ループを防ぐ
        const relevant = records.some((rec) => {
          const target = rec.target as Element | null;
          if (!target) return false;
          if (target.id === SHADOW_HOST_ID || target.id === STYLE_ELEMENT_ID) {
            return false;
          }
          if (target.closest?.(`#${SHADOW_HOST_ID}`)) {
            return false;
          }
          return true;
        });
        if (relevant) {
          scheduleGutterRender();
        }
      });
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  function detachLayoutTrackers(): void {
    if (!trackingAttached) return;
    trackingAttached = false;
    window.removeEventListener('scroll', scheduleGutterRender, true);
    window.removeEventListener('resize', scheduleGutterRender);
    resizeObserver?.disconnect();
    resizeObserver = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (gutterRafId !== null) {
      window.cancelAnimationFrame(gutterRafId);
      gutterRafId = null;
    }
    if (hoverRafId !== null) {
      window.cancelAnimationFrame(hoverRafId);
      hoverRafId = null;
    }
  }

  function getPageBodyText(): string {
    if (!cachedPageBodyText) {
      cachedPageBodyText = extractPageBodyText(document);
    }
    return cachedPageBodyText;
  }

  function closeActivePanel(): void {
    setActiveHighlight(null);
    activeItem = null;
    activeAnalysis = null;
    currentAnalyzeRequestId = null;
    currentWordRequestId = null;
    currentTranslateRequestId = null;
    translationExpanded = false;
    activeTranslation = null;
    feedbackBusy = false;
    ui?.setFeedbackBusy(false);
    ui?.syncGutterStates(null, hoveredItem?.payload.id ?? null);
    ui?.hidePanel();
  }

  /** 指定したマーク文の構造解析パネルを開く（本文クリック・縦線クリック共通） */
  function openAnalysisForItem(hit: MarkedItemRuntime): void {
    if (!ui) return;
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentAnalyzeRequestId = requestId;
    currentWordRequestId = null;
    currentTranslateRequestId = null;
    translationExpanded = false;
    activeTranslation = null;
    feedbackBusy = false;
    activeItem = hit;
    activeAnalysis = null;
    if (hoveredItem === hit) {
      setHoverHighlight(null);
    }
    setActiveHighlight(hit.dom.range);
    ui.syncGutterStates(hit.payload.id, hoveredItem?.payload.id ?? null);
    ui.showPanelLoading(hit.dom.text, countWords(hit.dom.text) >= 25);

    void chrome.runtime
      .sendMessage({
        type: 'ANALYZE_SENTENCE',
        sentence: hit.dom.text,
        requestId,
        preferredProvider: 'auto',
      })
      .then(
        (res: {
          ok?: boolean;
          data?: AnalyzeResult;
          developerMode?: boolean;
          error?: string;
        }) => {
          if (currentAnalyzeRequestId !== requestId) return;
          if (typeof res?.developerMode === 'boolean') {
            developerMode = res.developerMode;
            ui?.setDeveloperMode(developerMode);
          }
          if (!res?.ok || !res.data) {
            ui?.showPanelError(res?.error ?? '構文解析に失敗しました。');
            return;
          }
          activeAnalysis = res.data;
          ui?.showPanelResult(hit.dom.text, res.data);
        },
      )
      .catch((err) => {
        if (currentAnalyzeRequestId !== requestId) return;
        ui?.showPanelError(err instanceof Error ? err.message : String(err));
      });
  }

  /** 手元の判定済みスコアに対して現在の密度（10% / 20% / 40%）を適用し、API なしで即時再描画する */
  function reapplyRelativeMarks(density: MarkDensity): void {
    currentDensity = density;
    ui?.setActiveDensity(density);

    const levelMap = applyRelativePageMarks(
      markedItems.map((item) => ({
        id: item.payload.id,
        hardnessScore: item.payload.hardnessScore,
        weakConstructsHit: item.payload.weakConstructsHit,
        viewportOrder: item.dom.viewportOrder,
      })),
      {
        totalPageSentences,
        density,
      },
    );

    let markedCount = 0;
    for (const item of markedItems) {
      const lvl = levelMap.get(item.payload.id) ?? 0;
      item.payload.markLevel = lvl;
      if (lvl > 0) markedCount += 1;
    }

    if (hoveredItem && hoveredItem.payload.markLevel <= 0) {
      updateHoveredItem(null);
    }
    if (activeItem) {
      setActiveHighlight(activeItem.dom.range);
    }
    renderGuttersNow();

    const suffix = lastSourceLabel ? `（${lastSourceLabel}）` : '';
    ui?.setStatus(
      `全 ${totalPageSentences} 文中 ${markedCount} 文をマーク${suffix}`,
    );
  }

  /** 単語（または略語）の意味照会を実行する */
  function requestWordLookup(word: string, allowAcronymGuess = false): void {
    if (!activeItem) return;
    const targetSentence = activeItem.dom.text;
    const acronym = isAcronymWord(word);
    const pageText = acronym ? getPageBodyText() : '';
    const acronymMatch = acronym ? findAcronymDefinition(word, pageText) : null;

    // 略語でページ内に定義が見つからず、推測も要求されていない場合は AI を呼ばずに即表示する
    if (acronym && !acronymMatch && !allowAcronymGuess) {
      currentWordRequestId = null;
      ui?.showWordMeaning({
        word,
        lemma: normalizeAcronymBase(word),
        partOfSpeech: '略語',
        meaningJa: '',
        provider: 'none',
        modelName: 'page-lookup',
        fromCache: false,
        isAcronym: true,
        acronymDefinition: null,
        isGuessed: false,
      });
      return;
    }

    const reqId = `word-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentWordRequestId = reqId;
    ui?.showWordLoading(
      word,
      acronym && allowAcronymGuess
        ? `「${word}」の意味を AI で推測しています（ページ内に定義なし）...`
        : undefined,
    );

    void chrome.runtime
      .sendMessage({
        type: 'LOOKUP_WORD_MEANING',
        word,
        sentence: targetSentence,
        ...(acronym
          ? {
              isAcronym: true,
              acronymDefinition: acronymMatch?.fullForm ?? null,
              allowAcronymGuess,
            }
          : {}),
      })
      .then(
        (res: { ok?: boolean; data?: WordMeaningResult; error?: string }) => {
          if (currentWordRequestId !== reqId) return;
          if (!res?.ok || !res.data) {
            ui?.showWordError(
              res?.error ?? '単語の意味を取得できませんでした。',
            );
            return;
          }
          ui?.showWordMeaning(res.data);
        },
      )
      .catch((err) => {
        if (currentWordRequestId !== reqId) return;
        ui?.showWordError(err instanceof Error ? err.message : String(err));
      });
  }

  /** 「訳を見る」ボタンの開閉・日本語訳取得（ページ内略語定義を反映） */
  function toggleSentenceTranslation(): void {
    if (!activeItem || !ui) return;

    if (translationExpanded) {
      translationExpanded = false;
      ui.setTranslationExpanded(false);
      return;
    }

    translationExpanded = true;
    ui.setTranslationExpanded(true);

    if (activeTranslation) {
      ui.showTranslationResult(activeTranslation);
      return;
    }

    if (currentTranslateRequestId !== null) {
      ui.showTranslationLoading();
      return;
    }

    const targetSentence = activeItem.dom.text;
    const reqId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentTranslateRequestId = reqId;
    ui.showTranslationLoading();

    const resolved = findAcronymsInSentence(targetSentence, getPageBodyText());
    const acronymDefinitions = resolved.defined.map((d) => ({
      acronym: d.acronym,
      fullForm: d.fullForm,
    }));

    void chrome.runtime
      .sendMessage({
        type: 'TRANSLATE_SENTENCE',
        sentence: targetSentence,
        acronymDefinitions,
        unresolvedAcronyms: resolved.undefinedAcronyms,
      })
      .then(
        (res: {
          ok?: boolean;
          data?: TranslateSentenceResult;
          error?: string;
        }) => {
          if (currentTranslateRequestId !== reqId) return;
          currentTranslateRequestId = null;
          if (!res?.ok || !res.data) {
            ui?.showTranslationError(
              res?.error ?? '日本語訳を取得できませんでした。',
            );
            return;
          }
          activeTranslation = res.data;
          if (translationExpanded) {
            ui?.showTranslationResult(res.data);
          }
        },
      )
      .catch((err) => {
        if (currentTranslateRequestId !== reqId) return;
        currentTranslateRequestId = null;
        ui?.showTranslationError(
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  async function runMarking(forceRefresh = false): Promise<void> {
    if (!ui) {
      ui = createShadowUi({
        onRefresh: () => void runMarking(true),
        onChangeDensity: (density) => {
          reapplyRelativeMarks(density);
          void chrome.runtime.sendMessage({
            type: 'SET_MARK_DENSITY',
            density,
          });
        },
        onOpenReview: () => {
          void chrome.runtime.sendMessage({ type: 'OPEN_REVIEW_PAGE' });
        },
        onOpenOptions: () => {
          void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
        },
        onOpenConsent: () => {
          void chrome.runtime.sendMessage({ type: 'OPEN_CONSENT_PAGE' });
        },
        onClearMarks: () => {
          detachLayoutTrackers();
          clearAllHighlights();
          markedItems = [];
          itemById = new Map();
          activeItem = null;
          hoveredItem = null;
          activeAnalysis = null;
          currentAnalyzeRequestId = null;
          currentWordRequestId = null;
          currentTranslateRequestId = null;
          translationExpanded = false;
          activeTranslation = null;
          feedbackBusy = false;
          cachedPageBodyText = '';
          ui?.destroy();
          ui = null;
        },
        onClosePanel: () => {
          closeActivePanel();
        },
        onGutterHover: (id) => {
          updateHoveredItem(id ? (itemById.get(id) ?? null) : null);
        },
        onGutterClick: (id) => {
          const hit = itemById.get(id);
          if (hit) {
            openAnalysisForItem(hit);
          }
        },
        onWordClick: (word) => {
          requestWordLookup(word, false);
        },
        onGuessAcronym: (word) => {
          requestWordLookup(word, true);
        },
        onToggleTranslation: () => {
          toggleSentenceTranslation();
        },
        onSaveWord: (meaning) => {
          if (!activeItem) return;
          const savedMeaning = meaning.acronymDefinition
            ? `${meaning.meaningJa}（${meaning.acronymDefinition}）`
            : meaning.isGuessed
              ? `${meaning.meaningJa}（推測）`
              : meaning.meaningJa;
          void chrome.runtime
            .sendMessage({
              type: 'SAVE_WORD_ENTRY',
              word: meaning.word,
              meaning: savedMeaning,
              text: activeItem.dom.text,
              pageUrl: window.location.href,
              pageTitle: document.title,
              analysis: activeAnalysis?.analysis,
            })
            .then(
              (res: {
                ok?: boolean;
                data?: { created: boolean };
                error?: string;
              }) => {
                if (!res?.ok) {
                  ui?.setWordSaveResult(
                    false,
                    res?.error ?? '単語の保存に失敗しました。',
                  );
                  return;
                }
                ui?.setWordSaveResult(
                  true,
                  res.data?.created
                    ? '復習カードに追加しました'
                    : '記録済みの単語を更新しました',
                );
              },
            )
            .catch((err) => {
              ui?.setWordSaveResult(
                false,
                err instanceof Error ? err.message : String(err),
              );
            });
        },
        onFeedback: (result) => {
          if (!activeItem || !activeAnalysis || feedbackBusy) return;
          const constructs: ConstructId[] =
            activeAnalysis.analysis.constructs.length > 0
              ? activeAnalysis.analysis.constructs
              : activeItem.payload.constructs;
          feedbackBusy = true;
          ui?.setFeedbackBusy(true);
          ui?.setFeedbackMessage('記録しています...');
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
            .then(
              (res: {
                ok?: boolean;
                data?: {
                  weakCounts?: Partial<Record<ConstructId, number>>;
                  createdCardCount?: number;
                };
                error?: string;
              }) => {
                if (!res?.ok) {
                  ui?.setFeedbackMessage(
                    `記録に失敗しました: ${res?.error ?? '不明なエラー'}`,
                  );
                  return;
                }

                // 苦手構文カウントの変化を現在のページのスコアと相対順位・マーク濃さに即時反映する
                if (res.data?.weakCounts) {
                  for (const item of markedItems) {
                    const updated = calculateDifficultyAndMarkLevel(
                      item.dom.text,
                      item.payload.constructs,
                      res.data.weakCounts,
                      {
                        overrideLongSubject:
                          item.payload.constructs.includes('long_subject'),
                      },
                    );
                    item.payload.difficulty = updated.difficulty;
                    item.payload.hardnessScore = updated.hardnessScore;
                    item.payload.weakConstructsHit = updated.weakConstructsHit;
                  }
                  reapplyRelativeMarks(currentDensity);
                }

                if (constructs.length === 0) {
                  ui?.setFeedbackMessage(
                    result === 'unsure'
                      ? 'この文には記録対象の構文がありませんでした（単語をタップして記録できます）'
                      : '「分かった」として記録しました',
                  );
                } else {
                  ui?.setFeedbackMessage(
                    result === 'unsure'
                      ? '苦手構文として記録し、復習カードを追加しました（マーク濃度に反映済み）'
                      : '「分かった」として記録しました',
                  );
                }
              },
            )
            .catch((err) => {
              ui?.setFeedbackMessage(
                `記録に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
            .finally(() => {
              feedbackBusy = false;
              ui?.setFeedbackBusy(false);
            });
        },
      });
    }

    // 再判定時などに古い Range / パネル参照が残らないよう選択状態をリセットする
    if (activeItem) {
      closeActivePanel();
    }
    updateHoveredItem(null);
    ui.setStatusNotice(null);
    ui.setStatus('本文の英文を抽出中...');
    cachedPageBodyText = extractPageBodyText(document);
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
          totalSentenceCount: number;
          markedCount: number;
          markDensity: MarkDensity;
          developerMode?: boolean;
          notice?: string;
        };
        error?: string;
      };

      if (!response?.ok || !response.data) {
        const errMsg = response?.error ?? '判定に失敗しました';
        ui.setStatus('エラーが発生しました');
        ui.setStatusNotice(errMsg);
        return;
      }

      const data = response.data;
      developerMode = Boolean(data.developerMode);
      ui.setDeveloperMode(developerMode);
      totalPageSentences = data.totalSentenceCount ?? extracted.length;
      currentDensity = data.markDensity ?? 'normal';
      markedItems = [];
      itemById = new Map();
      for (const payload of data.marks) {
        const dom = byId.get(payload.id);
        if (dom) {
          const runtimeItem = { dom, payload };
          markedItems.push(runtimeItem);
          itemById.set(payload.id, runtimeItem);
        }
      }

      lastSourceLabel = data.fromCache
        ? 'キャッシュ'
        : data.provider === 'cloud'
          ? `クラウド ${data.batchCallCount}回`
          : 'ルール簡易';

      attachLayoutTrackers();
      reapplyRelativeMarks(currentDensity);
      ui.setStatusNotice(data.notice ?? null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ui.setStatus('エラーが発生しました');
      ui.setStatusNotice(errMsg);
    }
  }

  // 本文上にマウスを乗せたときだけ、対象文に薄い点線下線＋半透明背景を表示する
  document.addEventListener(
    'mousemove',
    (event) => {
      if (markedItems.length === 0 || !ui) return;
      const target = event.target as HTMLElement | null;
      if (target?.id === SHADOW_HOST_ID || target?.closest?.(`#${SHADOW_HOST_ID}`)) {
        return;
      }
      lastPointerPos = { x: event.clientX, y: event.clientY };
      if (hoverRafId !== null) return;
      hoverRafId = window.requestAnimationFrame(() => {
        hoverRafId = null;
        if (!lastPointerPos) return;
        const hit = findMarkedItemAtPoint(
          lastPointerPos.x,
          lastPointerPos.y,
          markedItems,
        );
        updateHoveredItem(hit);
      });
    },
    { passive: true },
  );

  document.documentElement.addEventListener('mouseleave', () => {
    updateHoveredItem(null);
  });

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

    openAnalysisForItem(hit);
  });

  // Esc キーで解析パネルを閉じる
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeItem && ui) {
      closeActivePanel();
    }
  });

  // 設定画面で開発者モードを切り替えた際、開いているページの計測表示にも即時反映する
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if ('kaidoku_developer_mode' in changes) {
      developerMode = changes.kaidoku_developer_mode?.newValue === true;
      ui?.setDeveloperMode(developerMode);
    }
  });

  chrome.runtime?.onMessage.addListener(
    (message: {
      type?: string;
      requestId?: string;
      sentence?: string;
      clauses?: ClauseSkeletonItem[];
      stage1Ms?: number;
      waitMs?: number;
    }) => {
      if (message?.type === 'KAIDOKU_RUN_MARK') {
        void runMarking(false);
        return;
      }
      if (
        message?.type === 'KAIDOKU_ANALYSIS_STAGE1' &&
        message.requestId &&
        message.requestId === currentAnalyzeRequestId &&
        message.sentence &&
        Array.isArray(message.clauses)
      ) {
        ui?.showPanelStage1(
          message.sentence,
          message.clauses,
          message.stage1Ms ?? 0,
          message.waitMs ?? 0,
        );
      }
    },
  );
}

initKaidokuContent();
