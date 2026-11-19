/**
 * ページ本文からの英文抽出・文分割・DOM Range マッピング
 * - arXiv HTML の文中数式（.ltx_Math 等）は除外せず送信テキスト上で [MATH] に置換し、
 *   ハイライト用 Range は元の DOM 範囲をそのまま保つ
 * - 数式行（.ltx_equation）・コード・参考文献・ナビゲーション等は対象外とする
 */

export interface SplitSentenceSlice {
  text: string;
  start: number;
  end: number;
}

export interface ExtractedDomSentence {
  id: string;
  sentenceHash: string;
  /** AI 送信・解析用の正規化テキスト（文中数式は [MATH]） */
  text: string;
  /** CSS Custom Highlight API・Range.getClientRects() 用の元の DOM 範囲 */
  range: Range;
  /** この文が属する本文ブロック要素（左余白ガターの位置揃えに使用） */
  blockElement?: Element;
  /** 画面に見えている位置から読む順の優先番号 */
  viewportOrder: number;
}

/** 末尾ピリオドで文分割してはいけない代表的な学術・一般略語 */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'et al',
  'etc',
  'vs',
  'fig',
  'figs',
  'eq',
  'eqs',
  'tab',
  'sec',
  'ref',
  'refs',
  'no',
  'vol',
  'pp',
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'st',
  'jr',
  'sr',
  'u.s',
  'u.k',
  'u.s.a',
  'approx',
  'cf',
  'al',
]);

/** 抽出対象から完全に除外する要素セレクタ */
const EXCLUDED_ELEMENT_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'kbd',
  'samp',
  'svg',
  'canvas',
  'input',
  'textarea',
  'select',
  'button',
  '[contenteditable="true"]',
  '[aria-hidden="true"]',
  '.ltx_equation',
  '.ltx_equationgroup',
  '.ltx_bibliography',
  '.ltx_biblist',
  '.ltx_page_footer',
  '.ltx_page_header',
  '.ltx_role_author',
  '.ltx_authors',
  '.ltx_dates',
  'mjx-container[display="true"]',
  '#kaidoku-shadow-host',
].join(', ');

/** 文中数式（[MATH] に置換するが DOM Range には含める）として扱うセレクタ */
const INLINE_MATH_SELECTOR = [
  '.ltx_Math',
  'math',
  '.MathJax',
  'mjx-container:not([display="true"])',
  '.katex',
].join(', ');

/** テキストの軽量決定ハッシュ（同期計算可能な FNV-1a 64bit 風 16進文字列） */
export function hashSentenceText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

/** 候補文一覧全体から本文変更検知用のコンテンツハッシュを作る */
export function hashCandidateList(texts: readonly string[]): string {
  return hashSentenceText(texts.join('\n'));
}

/** ピリオド直前の語が略語・イニシャル・小数点かどうか判定する */
function isNonBoundaryPeriod(text: string, periodIndex: number): boolean {
  const prevChar = text[periodIndex - 1];
  const nextChar = text[periodIndex + 1];

  // 小数点（例: 3.14）
  if (prevChar && /\d/.test(prevChar) && nextChar && /\d/.test(nextChar)) {
    return true;
  }

  // 直前の語句を取り出す（最大 12 文字）
  const before = text.slice(Math.max(0, periodIndex - 12), periodIndex);

  // "et al." や "e.g." / "i.e." / "Fig." など
  const multiWordMatch = before.match(/(?:^|[\s(["'“‘])(et al)$/i);
  if (multiWordMatch) return true;

  const tokenMatch = before.match(/([A-Za-z](?:\.[A-Za-z])*|[A-Za-z]+)$/);
  if (tokenMatch) {
    const token = tokenMatch[1].toLowerCase();
    // 1文字イニシャル（例: "J. Smith"）
    if (token.length === 1) return true;
    if (ABBREVIATIONS.has(token)) return true;
  }

  return false;
}

/**
 * 1 パラグラフの英文を文単位に分割し、元文字列内の start / end 位置を返す。
 */
export function splitParagraphSentences(text: string): SplitSentenceSlice[] {
  const slices: SplitSentenceSlice[] = [];
  const len = text.length;
  let sentenceStart = 0;

  // 先頭空白をスキップ
  while (sentenceStart < len && /\s/.test(text[sentenceStart])) {
    sentenceStart += 1;
  }

  let i = sentenceStart;
  while (i < len) {
    const ch = text[i];
    const isTerminal = ch === '.' || ch === '?' || ch === '!';
    if (!isTerminal) {
      i += 1;
      continue;
    }

    if (ch === '.' && isNonBoundaryPeriod(text, i)) {
      i += 1;
      continue;
    }

    // 終端記号の後ろに閉じ括弧・引用符があれば含める
    let end = i + 1;
    while (end < len && /[)"'”’\]]/.test(text[end])) {
      end += 1;
    }

    // 終端または空白（次の文頭）が続いていれば文境界として確定
    const atEnd = end >= len;
    const followedBySpace = !atEnd && /\s/.test(text[end]);
    if (atEnd || followedBySpace) {
      // 次の非空白文字が小文字始まりなら略語などの誤分割を避ける（ただし ? / ! は常に分割）
      let nextStart = end;
      while (nextStart < len && /\s/.test(text[nextStart])) {
        nextStart += 1;
      }
      const nextChar = text[nextStart];
      const looksLikeContinuation =
        ch === '.' &&
        nextChar !== undefined &&
        /[a-z]/.test(nextChar);

      if (!looksLikeContinuation) {
        const rawSlice = text.slice(sentenceStart, end);
        const trimmed = rawSlice.trim();
        if (trimmed.length > 0) {
          const leadSpaces = rawSlice.length - rawSlice.trimStart().length;
          const trailSpaces = rawSlice.length - rawSlice.trimEnd().length;
          slices.push({
            text: trimmed,
            start: sentenceStart + leadSpaces,
            end: end - trailSpaces,
          });
        }
        sentenceStart = nextStart;
        i = nextStart;
        continue;
      }
    }

    i += 1;
  }

  // 末尾にピリオドなしで残った文も回収する
  if (sentenceStart < len) {
    const rawSlice = text.slice(sentenceStart, len);
    const trimmed = rawSlice.trim();
    if (trimmed.length > 0) {
      const leadSpaces = rawSlice.length - rawSlice.trimStart().length;
      const trailSpaces = rawSlice.length - rawSlice.trimEnd().length;
      slices.push({
        text: trimmed,
        start: sentenceStart + leadSpaces,
        end: len - trailSpaces,
      });
    }
  }

  return slices;
}

interface TextSegment {
  kind: 'text';
  node: Text;
  virtualStart: number;
  virtualEnd: number;
  domOffset: number;
}

interface MathSegment {
  kind: 'math';
  element: Element;
  parent: Node;
  childIndex: number;
  virtualStart: number;
  virtualEnd: number;
}

type DomSegment = TextSegment | MathSegment;

function getChildIndex(node: Node): number {
  let idx = 0;
  let cur: Node | null = node.previousSibling;
  while (cur) {
    idx += 1;
    cur = cur.previousSibling;
  }
  return idx;
}

/** 1 つの本文ブロック要素から仮想テキストと DOM マッピングを構築する */
function collectBlockSegments(block: Element): {
  virtualText: string;
  segments: DomSegment[];
} {
  let virtualText = '';
  const segments: DomSegment[] = [];

  function walk(node: Node): void {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const textNode = node as Text;
      const raw = textNode.data;
      if (!raw) return;
      const virtualStart = virtualText.length;
      virtualText += raw;
      segments.push({
        kind: 'text',
        node: textNode,
        virtualStart,
        virtualEnd: virtualText.length,
        domOffset: 0,
      });
      return;
    }

    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;

    if (el.matches(EXCLUDED_ELEMENT_SELECTOR)) {
      return;
    }

    // 文中数式は内部を辿らず原子トークン [MATH] として扱う（元の DOM 要素範囲を保持）
    if (el.matches(INLINE_MATH_SELECTOR) && el.parentNode) {
      const virtualStart = virtualText.length;
      const placeholder = '[MATH]';
      virtualText += placeholder;
      segments.push({
        kind: 'math',
        element: el,
        parent: el.parentNode,
        childIndex: getChildIndex(el),
        virtualStart,
        virtualEnd: virtualText.length,
      });
      return;
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
  }

  walk(block);
  return { virtualText, segments };
}

/** 仮想テキスト上の [start, end) を元の DOM の Range に変換する */
function createDomRangeFromSegments(
  doc: Document,
  segments: DomSegment[],
  start: number,
  end: number,
): Range | null {
  let startAnchor: { container: Node; offset: number } | null = null;
  let endAnchor: { container: Node; offset: number } | null = null;

  for (const seg of segments) {
    if (startAnchor === null && start >= seg.virtualStart && start < seg.virtualEnd) {
      if (seg.kind === 'text') {
        startAnchor = {
          container: seg.node,
          offset: seg.domOffset + (start - seg.virtualStart),
        };
      } else {
        startAnchor = {
          container: seg.parent,
          offset: seg.childIndex,
        };
      }
    }

    if (end > seg.virtualStart && end <= seg.virtualEnd) {
      if (seg.kind === 'text') {
        endAnchor = {
          container: seg.node,
          offset: seg.domOffset + (end - seg.virtualStart),
        };
      } else {
        endAnchor = {
          container: seg.parent,
          offset: seg.childIndex + 1,
        };
      }
    }
  }

  if (!startAnchor || !endAnchor) {
    return null;
  }

  const range = doc.createRange();
  range.setStart(startAnchor.container, startAnchor.offset);
  range.setEnd(endAnchor.container, endAnchor.offset);
  return range;
}

/** 本文ブロック要素の候補を収集する（arXiv HTML と一般記事の両方に対応） */
function findProseBlocks(doc: Document): Element[] {
  const root =
    doc.querySelector('.ltx_document') ??
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.body;
  if (!root) return [];

  // arXiv HTML は .ltx_p が本文パラグラフ
  const arxivBlocks = Array.from(root.querySelectorAll('.ltx_p')).filter(
    (el) => !el.closest(EXCLUDED_ELEMENT_SELECTOR),
  );
  if (arxivBlocks.length > 0) {
    return arxivBlocks;
  }

  const candidates = Array.from(root.querySelectorAll('p, li, blockquote')).filter(
    (el) => !el.closest(EXCLUDED_ELEMENT_SELECTOR),
  );

  // 入れ子になった li > p 等の二重抽出を防ぐ（子に p を含む li はスキップ）
  return candidates.filter((el) => {
    if (el.tagName === 'LI' && el.querySelector('p')) {
      return false;
    }
    return true;
  });
}

/**
 * 現在のページから英文を抽出し、DOM Range と画面位置ベースの読む順（viewportOrder）を付与して返す。
 */
export function extractPageSentences(
  doc: Document,
  win?: Window,
): ExtractedDomSentence[] {
  const blocks = findProseBlocks(doc);
  const rawItems: Array<{
    text: string;
    range: Range;
    blockElement: Element;
    top: number;
    docOrder: number;
  }> = [];

  let docOrder = 0;
  for (const block of blocks) {
    const { virtualText, segments } = collectBlockSegments(block);
    if (!virtualText.trim()) continue;

    const slices = splitParagraphSentences(virtualText);
    for (const slice of slices) {
      const normalizedText = slice.text.replace(/\s+/g, ' ').trim();
      // 英字を含まない文字列（数字列や記号のみ）は除外
      if (!/[A-Za-z]/.test(normalizedText)) continue;

      const range = createDomRangeFromSegments(
        doc,
        segments,
        slice.start,
        slice.end,
      );
      if (!range) continue;

      let top = docOrder * 20;
      if (typeof range.getBoundingClientRect === 'function') {
        const rect = range.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          top = rect.top;
        }
      }

      rawItems.push({
        text: normalizedText,
        range,
        blockElement: block,
        top,
        docOrder,
      });
      docOrder += 1;
    }
  }

  // 画面に見えている位置（top >= -40）から下方向を優先し、その後に画面より上の文を並べる
  const viewportHeight = win?.innerHeight ?? 900;
  const visibleAndBelow: typeof rawItems = [];
  const aboveViewport: typeof rawItems = [];

  for (const item of rawItems) {
    if (item.top >= -40 && item.top <= viewportHeight * 50) {
      visibleAndBelow.push(item);
    } else if (item.top < -40) {
      aboveViewport.push(item);
    } else {
      visibleAndBelow.push(item);
    }
  }

  const ordered = [...visibleAndBelow, ...aboveViewport];
  const orderMap = new Map<number, number>();
  ordered.forEach((item, idx) => {
    orderMap.set(item.docOrder, idx);
  });

  return rawItems.map((item, idx) => ({
    id: `s-${idx}`,
    sentenceHash: hashSentenceText(item.text),
    text: item.text,
    range: item.range,
    blockElement: item.blockElement,
    viewportOrder: orderMap.get(item.docOrder) ?? idx,
  }));
}
