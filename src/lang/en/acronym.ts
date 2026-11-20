/**
 * ページ本文から略語（アクロニム）の定義を探索するユーティリティ。
 * 「正式名称 (略語)」および「略語 (正式名称)」の 2 形式を正規表現＋頭文字照合で抽出する。
 */

export type AcronymDefinitionPattern = 'full-then-acronym' | 'acronym-then-full';

export interface AcronymDefinitionMatch {
  /** 正規化した略語（複数形 s を除いた基本形） */
  acronym: string;
  /** ページ本文から見つかった正式名称 */
  fullForm: string;
  /** 一致した定義の形式 */
  pattern: AcronymDefinitionPattern;
}

export interface SentenceAcronymResolution {
  /** ページ内で定義が見つかった略語の一覧（出現順・重複なし） */
  defined: AcronymDefinitionMatch[];
  /** ページ内に定義が見つからなかった略語の一覧（出現順・重複なし） */
  undefinedAcronyms: string[];
}

/** 正式名称の途中で省略され得る接続語・冠詞・前置詞 */
const ACRONYM_STOPWORDS = new Set([
  'of',
  'the',
  'and',
  'for',
  'in',
  'on',
  'to',
  'with',
  'by',
  'from',
  'at',
  'as',
  'a',
  'an',
  'or',
  'via',
  'into',
  'over',
  'under',
  'per',
  'between',
  'through',
  'de',
  'la',
  'des',
  'et',
  '&',
]);

/** extractPageBodyText で除外する非本文要素 */
const EXCLUDED_TEXT_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  '#kaidoku-shadow-host',
].join(', ');

/** 改行区切りを挿入するブロック要素タグ */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'BLOCKQUOTE',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'TR',
  'BR',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countUppercaseLetters(text: string): number {
  const matches = text.match(/[A-Z]/g);
  return matches ? matches.length : 0;
}

/**
 * 与えられた語が略語（2 文字以上の大文字を含む語、複数形の s 付きを含む）かどうかを判定する。
 */
export function isAcronymWord(word: string): boolean {
  const trimmed = word.trim();
  if (!trimmed) return false;
  // [MATH] などの記号・括弧付きプレースホルダは除外
  if (!/^[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*$/.test(trimmed)) {
    return false;
  }
  return countUppercaseLetters(trimmed) >= 2;
}

/**
 * 略語の複数形（末尾の小文字 s）や所有格（'s / ’s）を取り除いて基本形を返す。
 * 例: "MRASs" -> "MRAS", "LLMs" -> "LLM", "MRAS" -> "MRAS"（大文字 S は削らない）
 */
export function normalizeAcronymBase(word: string): string {
  let base = word.trim();
  // 所有格 's / ’s を除去（残りに大文字が 2 文字以上ある場合のみ）
  const withoutPossessive = base.replace(/['’]s$/, '');
  if (
    withoutPossessive !== base &&
    countUppercaseLetters(withoutPossessive) >= 2
  ) {
    base = withoutPossessive;
  }
  // 複数形の末尾小文字 s を除去（大文字 S は略語の一部なので残す）
  if (base.endsWith('s')) {
    const singular = base.slice(0, -1);
    if (countUppercaseLetters(singular) >= 2) {
      base = singular;
    }
  }
  return base;
}

interface SubwordUnit {
  text: string;
  /** ハイフン・スラッシュ・CamelCase 分割の 2 番目以降の要素（省略を許容する） */
  isContinuation: boolean;
}

/** 正式名称候補を照合用のサブワード配列へ分解する */
function splitCandidateSubwords(candidate: string): SubwordUnit[] {
  const units: SubwordUnit[] = [];
  const wsTokens = candidate.trim().split(/\s+/).filter(Boolean);

  for (const rawToken of wsTokens) {
    const cleaned = rawToken.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&]+$/g, '');
    if (!cleaned) continue;

    if (cleaned === '&') {
      units.push({ text: '&', isContinuation: false });
      continue;
    }

    const hyphenParts = cleaned.split(/[-/]+/).filter(Boolean);
    for (let hIdx = 0; hIdx < hyphenParts.length; hIdx++) {
      const camelParts = hyphenParts[hIdx]
        .split(/(?<=[a-z])(?=[A-Z])/)
        .filter(Boolean);
      for (let cIdx = 0; cIdx < camelParts.length; cIdx++) {
        units.push({
          text: camelParts[cIdx].toLowerCase(),
          isContinuation: hIdx > 0 || cIdx > 0,
        });
      }
    }
  }

  return units;
}

/**
 * 候補の正式名称が略語の文字構成と整合するかを検証する（Schwartz-Hearst 方式の頭文字照合）。
 * 括弧内の参照・注記（例: "MRAS (see Fig. 2)" や "the controller (MRAS)"）の誤検出を防ぐ。
 */
export function matchesAcronymFullForm(
  shortForm: string,
  candidate: string,
): boolean {
  const shortLetters = shortForm.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const candidateCompact = candidate.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (shortLetters.length < 2) return false;
  if (!candidateCompact || candidateCompact === shortLetters) return false;

  const subwords = splitCandidateSubwords(candidate);
  const wordCount = subwords.length;
  const letterCount = shortLetters.length;

  // 1 語のみの候補は誤検出（例: "mirages (MRAS)"）を防ぐため除外する
  if (wordCount < 2) return false;
  const maxSubwords = Math.min(letterCount + 5, letterCount * 2 + 2);
  if (wordCount > maxSubwords) return false;

  const memo = new Map<number, boolean>();

  function canAlign(wordIdx: number, letterIdx: number): boolean {
    if (wordIdx === wordCount) {
      return letterIdx === letterCount;
    }
    if (letterIdx === letterCount) {
      // 残りがすべてハイフン等の継続部なら許容（例: Pre-trained の trained）
      for (let k = wordIdx; k < wordCount; k++) {
        if (!subwords[k].isContinuation) return false;
      }
      return true;
    }

    const key = wordIdx * (letterCount + 1) + letterIdx;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const sw = subwords[wordIdx];
    const targetChar = shortLetters[letterIdx];

    // パターン 1: 現在のサブワードを 1〜3 文字分マッチさせる（先頭文字一致が必須）
    let firstPos = -1;
    if (sw.text[0] === targetChar) {
      firstPos = 0;
    } else if (targetChar === 'x' && sw.text.startsWith('ex')) {
      // UX = User Experience 等の慣用略記を許容
      firstPos = 1;
    }

    if (firstPos !== -1) {
      // 1 文字消費
      if (canAlign(wordIdx + 1, letterIdx + 1)) {
        memo.set(key, true);
        return true;
      }
      // 同一サブワードから追加で 2〜3 文字消費（例: LoRA の Lo, VAE の Ae, ResNet の Res）
      let prevPos = firstPos;
      const maxConsume = Math.min(3, letterCount - letterIdx, sw.text.length);
      for (let consume = 2; consume <= maxConsume; consume++) {
        const nextChar = shortLetters[letterIdx + consume - 1];
        const foundPos = sw.text.indexOf(nextChar, prevPos + 1);
        if (foundPos === -1) break;
        prevPos = foundPos;
        if (canAlign(wordIdx + 1, letterIdx + consume)) {
          memo.set(key, true);
          return true;
        }
      }
    }

    // パターン 2: 途中のストップワードまたはハイフン継続部をスキップする
    const canSkip =
      wordIdx > 0 &&
      (sw.isContinuation ||
        (wordIdx < wordCount - 1 && ACRONYM_STOPWORDS.has(sw.text)));
    if (canSkip && canAlign(wordIdx + 1, letterIdx)) {
      memo.set(key, true);
      return true;
    }

    memo.set(key, false);
    return false;
  }

  return canAlign(0, 0);
}

/** 「正式名称 (略語)」の直前テキストから最短の一致正式名称を取り出す */
function extractFullFormBeforeParen(
  pageText: string,
  parenIndex: number,
  baseAcronym: string,
): string | null {
  const rawBefore = pageText.slice(Math.max(0, parenIndex - 240), parenIndex);
  // 括弧直前の空白と末尾の閉じ引用符のみ取り除く
  const trimmedBefore = rawBefore.replace(/["'”’\s]+$/, '');
  if (!trimmedBefore) return null;

  // 文・節の強い区切りより後ろだけを対象にする
  const boundaryMatch = trimmedBefore.match(/[\n.!?;:()[\]{}“”",](?=[^\n.!?;:()[\]{}“”",]*$)/);
  const segment = boundaryMatch
    ? trimmedBefore.slice((boundaryMatch.index ?? 0) + 1)
    : trimmedBefore;

  const tokenMatches = Array.from(
    segment.matchAll(/[A-Za-z0-9]+(?:['’/-][A-Za-z0-9]+)*|&/g),
  );
  if (tokenMatches.length < 1) return null;

  const shortLen = baseAcronym.replace(/[^A-Za-z0-9]/g, '').length;
  const maxTokens = Math.min(tokenMatches.length, shortLen * 2 + 3);
  const lastToken = tokenMatches[tokenMatches.length - 1];
  const endOffset = (lastToken.index ?? 0) + lastToken[0].length;

  // 括弧に近い側（最短スパン）から順に検証し、前の動詞や冠詞（a / an / the）を巻き込まない
  // （1 トークンでも "Low-Rank" や "JavaScript" のような複合語はサブワード 2 語以上として検証される）
  for (let len = 1; len <= maxTokens; len++) {
    const startToken = tokenMatches[tokenMatches.length - len];
    const startOffset = startToken.index ?? 0;
    const candidate = segment
      .slice(startOffset, endOffset)
      .replace(/\s+/g, ' ')
      .trim();
    if (matchesAcronymFullForm(baseAcronym, candidate)) {
      return candidate;
    }
  }

  return null;
}

/** 「略語 (正式名称)」の括弧内テキストから正式名称を取り出す */
function extractFullFormInsideParen(
  innerRaw: string,
  baseAcronym: string,
): string | null {
  const normalized = innerRaw.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // 括弧内に注記が続く場合（例: "Model reference adaptive systems, see Sec. 2"）に備えて複数候補を作る
  const rawParts = [normalized];
  const beforeSemi = normalized.split(';')[0]?.trim();
  if (beforeSemi && beforeSemi !== normalized) rawParts.push(beforeSemi);
  const beforeComma = normalized.split(',')[0]?.trim();
  if (beforeComma && beforeComma !== normalized && beforeComma !== beforeSemi) {
    rawParts.push(beforeComma);
  }

  const introducerRe =
    /^(?:(?:short\s+for|stands?\s+for|abbreviated(?:\s+from|\s+as)?|i\.e\.?,?|namely|meaning)\s+)+/i;
  const articleRe = /^(?:a|an|the)\s+/i;

  for (const part of rawParts) {
    const strippedIntro = part.replace(introducerRe, '').trim();
    const candidates = [strippedIntro];
    const withoutArticle = strippedIntro.replace(articleRe, '').trim();
    if (withoutArticle && withoutArticle !== strippedIntro) {
      candidates.push(withoutArticle);
    }

    for (const candidate of candidates) {
      const clean = candidate.replace(/^["'“‘]+|["'”’.,;:]+$/g, '').trim();
      if (clean && matchesAcronymFullForm(baseAcronym, clean)) {
        return clean;
      }
    }
  }

  return null;
}

/**
 * ページ本文から指定された略語の定義を正規表現で探索する。
 * 対応形式:
 * 1. 「正式名称 (略語)」例: Model reference adaptive systems (MRAS)
 * 2. 「略語 (正式名称)」例: MRAS (Model reference adaptive systems)
 * 複数形の s 付き（例: MRASs / LLMs）にも対応する。
 */
export function findAcronymDefinition(
  word: string,
  pageText: string,
): AcronymDefinitionMatch | null {
  if (!isAcronymWord(word) || !pageText) return null;

  const base = normalizeAcronymBase(word);
  const escapedBase = escapeRegExp(base);
  // 改行を保ちつつ連続空白・ソフトハイフンだけ整える
  const normalizedPage = pageText
    .replace(/\u00ad/g, '')
    .replace(/\u00a0/g, ' ');

  let bestMatch: (AcronymDefinitionMatch & { index: number }) | null = null;

  // 形式 1: 正式名称 (略語) — 例: Model reference adaptive systems (MRAS)
  const form1Regex = new RegExp(
    `\\((?:(?:hereafter|abbreviated(?:\\s+as)?|short\\s+for|denoted(?:\\s+as)?|or)\\s+)?(?<![A-Za-z0-9])${escapedBase}s?(?![A-Za-z0-9])(?:\\s*[,;][^()]{0,60})?\\)`,
    'g',
  );
  for (const match of normalizedPage.matchAll(form1Regex)) {
    const matchIndex = match.index ?? 0;
    const fullForm = extractFullFormBeforeParen(normalizedPage, matchIndex, base);
    if (fullForm) {
      bestMatch = {
        acronym: base,
        fullForm,
        pattern: 'full-then-acronym',
        index: matchIndex,
      };
      break;
    }
  }

  // 形式 2: 略語 (正式名称) — 例: MRAS (Model reference adaptive systems)
  const form2Regex = new RegExp(
    `(?<![A-Za-z0-9])${escapedBase}s?(?![A-Za-z0-9])\\s*\\(([^()]{3,180})\\)`,
    'g',
  );
  for (const match of normalizedPage.matchAll(form2Regex)) {
    const matchIndex = match.index ?? 0;
    if (bestMatch && matchIndex >= bestMatch.index) {
      break;
    }
    const inner = match[1] ?? '';
    const fullForm = extractFullFormInsideParen(inner, base);
    if (fullForm) {
      bestMatch = {
        acronym: base,
        fullForm,
        pattern: 'acronym-then-full',
        index: matchIndex,
      };
      break;
    }
  }

  if (!bestMatch) return null;
  return {
    acronym: bestMatch.acronym,
    fullForm: bestMatch.fullForm,
    pattern: bestMatch.pattern,
  };
}

/**
 * 1 文に含まれるすべての略語を抽出し、ページ本文から定義を解決する。
 * 「訳を見る」で日本語訳にページ内の略語定義を反映するために使用する。
 */
export function findAcronymsInSentence(
  sentence: string,
  pageText: string,
): SentenceAcronymResolution {
  const tokenRegex = /\[MATH\]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
  const seenBases = new Set<string>();
  const defined: AcronymDefinitionMatch[] = [];
  const undefinedAcronyms: string[] = [];

  for (const match of sentence.matchAll(tokenRegex)) {
    const token = match[0];
    if (token === '[MATH]') continue;
    if (!isAcronymWord(token)) continue;

    const base = normalizeAcronymBase(token);
    if (seenBases.has(base)) continue;
    seenBases.add(base);

    const found = findAcronymDefinition(token, pageText);
    if (found) {
      defined.push(found);
    } else {
      undefinedAcronyms.push(base);
    }
  }

  return { defined, undefinedAcronyms };
}

/**
 * DOM ドキュメントから略語定義探索用の本文テキストを抽出する。
 * script/style/Shadow DOM ホスト等を除外し、ブロック境界に改行を入れて返す。
 * 一般記事で <title> にのみ正式名称が書かれているケースも拾えるよう doc.title を先頭に補完する。
 */
export function extractPageBodyText(doc: Document): string {
  const root = doc.querySelector('.ltx_document') ?? doc.body;
  const chunks: string[] = [];

  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  if (title) {
    chunks.push(title, '\n');
  }

  if (!root) {
    return chunks.join('').trim();
  }

  function walk(node: Node): void {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const data = (node as Text).data;
      if (data) chunks.push(data);
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;

    const el = node as Element;
    if (el.matches(EXCLUDED_TEXT_SELECTOR)) return;

    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) chunks.push('\n');
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
    if (isBlock) chunks.push('\n');
  }

  walk(root);
  return chunks
    .join('')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
