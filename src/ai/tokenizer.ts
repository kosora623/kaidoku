import { detectLongSubject } from '../lang/en/constructs';
import type { Analysis, AnalysisSpan, ConstructId } from '../types';
import { AnalysisValidationError, validateAnalysis } from './schema';

/** 単語分割された1トークン（0始まりの単語番号と元の文での文字範囲を持つ） */
export interface WordToken {
  index: number;
  text: string;
  /** 元の文における開始文字位置（0始まり・包含） */
  start: number;
  /** 元の文における終了文字位置（排他） */
  end: number;
}

/**
 * 英文を単語単位に分割し、各単語の 0 始まりインデックスと文字位置を返す。
 * arXiv HTML の文中数式プレースホルダ（[MATH]）、アポストロフィ（don't）、
 * ハイフン複合語（state-of-the-art）、小数・パーセント（98.5%）、通貨（$100）を
 * 1単語として扱い、周囲の句読点・括弧は除外する。
 */
const WORD_TOKEN_REGEX =
  /\[MATH\]|(?:[$€£¥](?=\d))?[\p{L}\p{N}]+(?:['’\-./][\p{L}\p{N}]+)*%?/gu;

export function tokenizeWords(sentence: string): WordToken[] {
  const tokens: WordToken[] = [];
  let index = 0;

  for (const match of sentence.matchAll(WORD_TOKEN_REGEX)) {
    const text = match[0];
    const start = match.index;
    if (start === undefined) continue;
    tokens.push({
      index,
      text,
      start,
      end: start + text.length,
    });
    index += 1;
  }

  return tokens;
}

/**
 * 単語境界から生成されたスパン [start, end) の内部に未閉じの "(" があり、
 * 直後に ")" が続いている場合（例: "(Section 6)", "(Paperno et al., 2016)", "(86 Hz)",
 * 入れ子の "(large-v2 (Radford et al., 2023))"）、対応する ")" まで end を拡張する。
 * スパンの内部で "(" が始まっていない場合は直後の ")" を取り込まない。
 */
export function expandBalancedClosingParens(
  sentence: string,
  start: number,
  end: number,
): number {
  let unmatchedOpen = 0;
  for (let i = start; i < end; i++) {
    const ch = sentence[i];
    if (ch === '(') {
      unmatchedOpen += 1;
    } else if (ch === ')' && unmatchedOpen > 0) {
      unmatchedOpen -= 1;
    }
  }

  let nextEnd = end;
  while (unmatchedOpen > 0 && nextEnd < sentence.length) {
    const ch = sentence[nextEnd];
    if (ch === ')') {
      nextEnd += 1;
      unmatchedOpen -= 1;
    } else if (ch === '.' && sentence[nextEnd + 1] === ')') {
      // 例: "(etc.)" のようにピリオド直後に ")" が続くケース
      nextEnd += 2;
      unmatchedOpen -= 1;
    } else {
      break;
    }
  }

  return nextEnd;
}

function validateWordRange(
  startWord: unknown,
  endWord: unknown,
  tokenCount: number,
  label: string,
  raw: unknown,
): { startWord: number; endWord: number } {
  if (
    typeof startWord !== 'number' ||
    typeof endWord !== 'number' ||
    !Number.isInteger(startWord) ||
    !Number.isInteger(endWord)
  ) {
    throw new AnalysisValidationError(
      'WORD_INDEX_OUT_OF_RANGE',
      `${label} の startWord / endWord は整数である必要があります。`,
      raw,
    );
  }

  if (
    startWord < 0 ||
    endWord < 0 ||
    startWord > endWord ||
    endWord >= tokenCount
  ) {
    throw new AnalysisValidationError(
      'WORD_INDEX_OUT_OF_RANGE',
      `${label} の単語範囲 [${startWord}..${endWord}] が単語数（0..${tokenCount - 1}）の範囲外です。`,
      raw,
    );
  }

  return { startWord, endWord };
}

const VALID_BRACKETS_SET = new Set(['noun', 'adj', 'adv']);
const NOUN_CONTAINER_ROLES = new Set(['S', 'O', 'C']);

/**
 * AI 出力の文字スパン配列から、再試行するまでもない軽い検証エラーを自動修復する。
 * - modifies が自分自身・範囲外・非整数（単語番号の誤記など）を指す場合 → modifies を除去
 * - role="modifier" なのに bracket がない（または不正）場合 → S/O/C スパンの内側なら adj、それ以外は adv を補完
 * 修復した内容の日本語ログ配列を返す（修復なしなら空配列）。
 */
export function repairMinorSpanIssues(
  spans: Array<Partial<AnalysisSpan> & Record<string, unknown>>,
): string[] {
  const repairs: string[] = [];

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];

    // 1. 不正な modifies（自己参照・範囲外・単語番号誤記など）を除去
    if (span.modifies !== undefined) {
      const m = span.modifies;
      const isInvalidModifies =
        typeof m !== 'number' ||
        !Number.isInteger(m) ||
        m < 0 ||
        m >= spans.length ||
        m === i;
      if (isInvalidModifies) {
        delete span.modifies;
        repairs.push(
          `spans[${i}] の不正な modifies（${String(m)}）を除去しました。`,
        );
      }
    }

    // 2. role="modifier" で bracket が欠落している場合に adj / adv を補完
    if (
      span.role === 'modifier' &&
      (typeof span.bracket !== 'string' || !VALID_BRACKETS_SET.has(span.bracket))
    ) {
      const start = typeof span.start === 'number' ? span.start : -1;
      const end = typeof span.end === 'number' ? span.end : -1;
      const insideNounContainer =
        start >= 0 &&
        end > start &&
        spans.some(
          (other, j) =>
            j !== i &&
            typeof other.role === 'string' &&
            NOUN_CONTAINER_ROLES.has(other.role) &&
            typeof other.start === 'number' &&
            typeof other.end === 'number' &&
            other.start <= start &&
            end <= other.end,
        );
      const inferred: AnalysisSpan['bracket'] = insideNounContainer ? 'adj' : 'adv';
      span.bracket = inferred;
      repairs.push(
        `spans[${i}]（modifier）に不足していた bracket="${inferred}" を補完しました。`,
      );
    }
  }

  return repairs;
}

/** 単語番号ベース解析の変換結果（自動修復ログ付き） */
export interface ConvertedWordAnalysisResult {
  analysis: Analysis;
  repaired: string[];
}

/**
 * AI が返した単語番号ベース（mainVerbs + spans）の解析 JSON を
 * SPEC.md 準拠の文字位置ベース（start / end）の Analysis へ変換し、
 * 軽い検証エラー（不正な modifies・modifier の bracket 欠落）を自動修復したうえで
 * validateAnalysis で検証して返す。
 */
export function convertWordAnalysisToCharAnalysisWithRepairs(
  sentence: string,
  raw: unknown,
  tokens: WordToken[] = tokenizeWords(sentence),
): ConvertedWordAnalysisResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnalysisValidationError(
      'INVALID_SHAPE',
      'AI の解析結果がオブジェクト形式ではありません。',
      raw,
    );
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.spans)) {
    throw new AnalysisValidationError(
      'INVALID_SHAPE',
      'AI の解析結果の spans が配列ではありません。',
      raw,
    );
  }

  if (!Array.isArray(obj.mainVerbs) || obj.mainVerbs.length === 0) {
    throw new AnalysisValidationError(
      'MISSING_MAIN_VERB',
      'AI の解析結果に mainVerbs（主節の動詞）が含まれていません。',
      raw,
    );
  }

  if (tokens.length === 0) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '入力文から解析対象の単語を抽出できませんでした。',
      raw,
    );
  }

  const convertedSpans: Array<Partial<AnalysisSpan> & Record<string, unknown>> =
    [];

  // 1. spans（S / O / C / modifier）を元のインデックス順を保ったまま変換（modifies の整合を維持）
  for (let i = 0; i < obj.spans.length; i++) {
    const entry = obj.spans[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AnalysisValidationError(
        'INVALID_SHAPE',
        `spans[${i}] がオブジェクトではありません。`,
        raw,
      );
    }

    const s = entry as Record<string, unknown>;
    const { startWord, endWord } = validateWordRange(
      s.startWord,
      s.endWord,
      tokens.length,
      `spans[${i}]`,
      raw,
    );

    const start = tokens[startWord].start;
    const end = expandBalancedClosingParens(
      sentence,
      start,
      tokens[endWord].end,
    );
    const charSpan: Partial<AnalysisSpan> & Record<string, unknown> = {
      start,
      end,
      role: s.role as AnalysisSpan['role'],
    };

    if (s.bracket !== undefined) {
      charSpan.bracket = s.bracket as AnalysisSpan['bracket'];
    }
    if (s.modifies !== undefined) {
      charSpan.modifies = s.modifies as number;
    }

    convertedSpans.push(charSpan);
  }

  // 2. トップレベルの mainVerbs を role="V" スパンに変換して末尾へ追加する
  const verbSpanIndices: number[] = [];
  for (let i = 0; i < obj.mainVerbs.length; i++) {
    const entry = obj.mainVerbs[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AnalysisValidationError(
        'INVALID_SHAPE',
        `mainVerbs[${i}] がオブジェクトではありません。`,
        raw,
      );
    }
    const v = entry as Record<string, unknown>;
    const { startWord, endWord } = validateWordRange(
      v.startWord,
      v.endWord,
      tokens.length,
      `mainVerbs[${i}]`,
      raw,
    );

    const verbIndex = convertedSpans.length;
    verbSpanIndices.push(verbIndex);
    convertedSpans.push({
      start: tokens[startWord].start,
      end: tokens[endWord].end,
      role: 'V',
    });
  }

  // 受け身動詞（例: "is well established"）の内側にある modifier の modifies が未設定なら、
  // 自動的にその V スパンへ紐づける
  for (const span of convertedSpans) {
    if (
      span.role === 'modifier' &&
      span.modifies === undefined &&
      typeof span.start === 'number' &&
      typeof span.end === 'number'
    ) {
      for (const vIdx of verbSpanIndices) {
        const vSpan = convertedSpans[vIdx];
        if (
          typeof vSpan.start === 'number' &&
          typeof vSpan.end === 'number' &&
          vSpan.start <= span.start &&
          span.end <= vSpan.end
        ) {
          span.modifies = vIdx;
          break;
        }
      }
    }
  }

  // 2.5. 軽い検証エラー（不正な modifies・modifier の bracket 欠落）を検証・再試行前に自動修復する
  const repaired = repairMinorSpanIssues(convertedSpans);

  // 3. constructs：AI が万一 long_subject を返しても一旦取り除き、コード側のルールで確定判定する
  const rawConstructs = Array.isArray(obj.constructs) ? obj.constructs : obj.constructs;
  const baseConstructs = Array.isArray(rawConstructs)
    ? rawConstructs.filter((c) => c !== 'long_subject')
    : rawConstructs;

  // まず validateAnalysis で文字位置・構造・主節 V の整合を検証
  const validated = validateAnalysis(sentence, {
    spans: convertedSpans,
    constructs: baseConstructs,
    difficulty: obj.difficulty,
  });

  // 検証済みスパンから long_subject をコード側で決定的に付与する
  const finalConstructs: ConstructId[] = [...validated.constructs];
  if (
    detectLongSubject(sentence, validated.spans) &&
    !finalConstructs.includes('long_subject')
  ) {
    finalConstructs.push('long_subject');
  }

  return {
    analysis: {
      ...validated,
      constructs: finalConstructs,
    },
    repaired,
  };
}

/**
 * 既存呼び出し互換用：自動修復・検証済みの Analysis のみを返す。
 */
export function convertWordAnalysisToCharAnalysis(
  sentence: string,
  raw: unknown,
  tokens: WordToken[] = tokenizeWords(sentence),
): Analysis {
  return convertWordAnalysisToCharAnalysisWithRepairs(sentence, raw, tokens)
    .analysis;
}
