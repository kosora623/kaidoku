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

/**
 * AI が返した単語番号ベース（mainVerbs + spans）の解析 JSON を
 * SPEC.md 準拠の文字位置ベース（start / end）の Analysis へ変換し、
 * long_subject のコード判定を適用したうえで validateAnalysis で検証して返す。
 */
export function convertWordAnalysisToCharAnalysis(
  sentence: string,
  raw: unknown,
  tokens: WordToken[] = tokenizeWords(sentence),
): Analysis {
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

    const charSpan: Partial<AnalysisSpan> & Record<string, unknown> = {
      start: tokens[startWord].start,
      end: tokens[endWord].end,
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
    ...validated,
    constructs: finalConstructs,
  };
}
