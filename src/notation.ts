import { validateAnalysis } from './ai/schema';
import type { Analysis, AnalysisSpan, BracketType, SpanRole } from './types';

/** 英文解釈記法のツリーノード（テキストまたは入れ子スパン） */
export type NotationNode = NotationTextNode | NotationSpanNode;

export interface NotationTextNode {
  type: 'text';
  text: string;
  start: number;
  end: number;
}

export interface NotationSpanNode {
  type: 'span';
  /** 元の analysis.spans 配列内でのインデックス */
  spanIndex: number;
  span: AnalysisSpan;
  children: NotationNode[];
}

/** 括弧の種類ごとの開始・終了記号 */
export const BRACKET_SYMBOLS: Record<BracketType, [string, string]> = {
  noun: ['[', ']'],
  adj: ['(', ')'],
  adv: ['<', '>'],
};

/** 役割バッジを表示すべき role（modifier には文字ラベルを付けない） */
function getRoleLabel(role: SpanRole): string | null {
  return role === 'modifier' ? null : role;
}

interface IndexedSpan {
  index: number;
  span: AnalysisSpan;
}

/**
 * 検証済みの Analysis と元の文から、包含関係（入れ子）を保った記法ツリーを構築する。
 */
export function buildNotationTree(
  sentence: string,
  analysis: Analysis,
): NotationNode[] {
  const validated = validateAnalysis(sentence, analysis);

  // 外側のスパンが先に来るよう start 昇順・end 降順で並べる
  const sorted: IndexedSpan[] = validated.spans
    .map((span, index) => ({ index, span }))
    .sort((a, b) => {
      if (a.span.start !== b.span.start) {
        return a.span.start - b.span.start;
      }
      return b.span.end - a.span.end;
    });

  function buildRange(
    rangeStart: number,
    rangeEnd: number,
    candidates: IndexedSpan[],
  ): NotationNode[] {
    const nodes: NotationNode[] = [];
    let cursor = rangeStart;
    let i = 0;

    while (i < candidates.length) {
      const current = candidates[i];
      if (current.span.start < cursor) {
        i += 1;
        continue;
      }
      if (current.span.start >= rangeEnd) {
        break;
      }

      // 現在のスパンより前にある未装飾テキストを追加する
      if (current.span.start > cursor) {
        nodes.push({
          type: 'text',
          text: sentence.slice(cursor, current.span.start),
          start: cursor,
          end: current.span.start,
        });
      }

      // current の内側に完全に包含される子スパンを集める
      const innerCandidates: IndexedSpan[] = [];
      let j = i + 1;
      while (j < candidates.length && candidates[j].span.end <= current.span.end) {
        if (candidates[j].span.start >= current.span.start) {
          innerCandidates.push(candidates[j]);
        }
        j += 1;
      }

      nodes.push({
        type: 'span',
        spanIndex: current.index,
        span: current.span,
        children: buildRange(
          current.span.start,
          current.span.end,
          innerCandidates,
        ),
      });

      cursor = current.span.end;
      i = j;
    }

    if (cursor < rangeEnd) {
      nodes.push({
        type: 'text',
        text: sentence.slice(cursor, rangeEnd),
        start: cursor,
        end: rangeEnd,
      });
    }

    return nodes;
  }

  return buildRange(0, sentence.length, sorted);
}

/** ツリーノードを1行テキスト記法へ変換する */
function formatNodeInline(node: NotationNode): string {
  if (node.type === 'text') {
    return node.text;
  }

  const inner = node.children.map(formatNodeInline).join('');
  const wrapped = node.span.bracket
    ? `${BRACKET_SYMBOLS[node.span.bracket][0]}${inner}${BRACKET_SYMBOLS[node.span.bracket][1]}`
    : inner;
  const roleLabel = getRoleLabel(node.span.role);

  return roleLabel ? `${wrapped} ${roleLabel}` : wrapped;
}

export interface FormatNotationTextOptions {
  /** true のとき SPEC.md のようにトップレベル要素ごとに改行・インデントして表示する */
  multiline?: boolean;
}

/**
 * 解析 JSON から [ ] ( ) < > と S・V・O・C のテキスト記法を生成する。
 */
export function formatNotationText(
  sentence: string,
  analysis: Analysis,
  options?: FormatNotationTextOptions,
): string {
  const tree = buildNotationTree(sentence, analysis);

  if (!options?.multiline) {
    return tree.map(formatNodeInline).join('');
  }

  // SPEC.md 形式の複数行インデント記法を組み立てる
  const lines: string[] = [];
  for (const node of tree) {
    if (node.type === 'text') {
      const trimmed = node.text.trim();
      if (!trimmed) {
        continue;
      }
      // 先頭の句読点（例: "," や ", but" の "," 部分）は直前の行末に接続し、残りの語句だけ次の行に出す
      const punctMatch = trimmed.match(/^([.,;:!?)\]}'"”’]+)\s*(.*)$/);
      if (punctMatch && lines.length > 0) {
        lines[lines.length - 1] += punctMatch[1];
        if (punctMatch[2]) {
          lines.push(punctMatch[2]);
        }
      } else {
        lines.push(trimmed);
      }
    } else {
      lines.push(formatNodeInline(node));
    }
  }

  return lines
    .map((line, idx) => (idx === 0 ? line : `  ${line}`))
    .join('\n');
}

/** HTML 特殊文字をエスケープする */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface RenderNotationHtmlOptions {
  /** true のとき、テキスト内の各英単語をクリック可能な <span class="kaidoku-word"> で包む */
  clickableWords?: boolean;
}

/** テキストノード内の英単語・数字付き略語（GPT-4, 3D 等）をクリック可能スパンに変換する（[MATH] や純粋な数字・記号は素通し） */
function renderTextWithClickableWords(text: string): string {
  const pattern = /\[MATH\]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, start));
    }
    if (token === '[MATH]' || !/[A-Za-z]/.test(token)) {
      result += escapeHtml(token);
    } else {
      const escaped = escapeHtml(token);
      result += `<span class="kaidoku-word" data-word="${escaped}" role="button" tabindex="0">${escaped}</span>`;
    }
    lastIndex = start + token.length;
  }

  if (lastIndex < text.length) {
    result += escapeHtml(text.slice(lastIndex));
  }
  return result;
}

/** ツリーノードを構造化 HTML へ変換する */
function renderNodeHtml(
  node: NotationNode,
  spans: AnalysisSpan[],
  sentence: string,
  clickableWords: boolean,
): string {
  if (node.type === 'text') {
    const content = clickableWords
      ? renderTextWithClickableWords(node.text)
      : escapeHtml(node.text);
    return `<span class="kaidoku-text">${content}</span>`;
  }

  const innerHtml = node.children
    .map((child) => renderNodeHtml(child, spans, sentence, clickableWords))
    .join('');

  const classes = ['kaidoku-span', `kaidoku-role-${node.span.role}`];
  if (node.span.bracket) {
    classes.push(`kaidoku-bracket-${node.span.bracket}`);
  }

  const attrs = [
    `class="${classes.join(' ')}"`,
    `data-span-index="${node.spanIndex}"`,
    `data-role="${node.span.role}"`,
  ];
  if (node.span.bracket) {
    attrs.push(`data-bracket="${node.span.bracket}"`);
  }
  if (node.span.modifies !== undefined) {
    attrs.push(`data-modifies="${node.span.modifies}"`);
    const targetSpan = spans[node.span.modifies];
    if (targetSpan) {
      const targetText = sentence.slice(targetSpan.start, targetSpan.end);
      attrs.push(`title="修飾先: ${escapeHtml(targetText)}"`);
    }
  }

  const openBracket = node.span.bracket
    ? `<span class="kaidoku-delim kaidoku-delim-${node.span.bracket}" aria-hidden="true">${escapeHtml(BRACKET_SYMBOLS[node.span.bracket][0])}</span>`
    : '';
  const closeBracket = node.span.bracket
    ? `<span class="kaidoku-delim kaidoku-delim-${node.span.bracket}" aria-hidden="true">${escapeHtml(BRACKET_SYMBOLS[node.span.bracket][1])}</span>`
    : '';

  const roleLabel = getRoleLabel(node.span.role);
  const roleBadge = roleLabel
    ? `<sup class="kaidoku-role-badge kaidoku-role-badge-${roleLabel}">${roleLabel}</sup>`
    : '';

  return `<span ${attrs.join(' ')}>${openBracket}${innerHtml}${closeBracket}${roleBadge}</span>`;
}

/**
 * 解析 JSON から [ ] ( ) < > と S・V・O・C を視覚化した HTML を生成する。
 */
export function renderNotationHtml(
  sentence: string,
  analysis: Analysis,
  options?: RenderNotationHtmlOptions,
): string {
  const validated = validateAnalysis(sentence, analysis);
  const tree = buildNotationTree(sentence, validated);
  const clickableWords = Boolean(options?.clickableWords);
  const body = tree
    .map((node) => renderNodeHtml(node, validated.spans, sentence, clickableWords))
    .join('');

  return `<div class="kaidoku-notation">${body}</div>`;
}
