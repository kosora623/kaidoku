import { CONSTRUCT_IDS } from './constructs';
import type { ConstructId, MarkLevel } from '../../types';

/** 候補抽出の最小単語数（8 語以上の文は原則すべて候補にする） */
export const MIN_CANDIDATE_WORDS = 8;

/** 1 回のクラウドバッチ呼び出しあたりの最大文数 */
export const MAX_SENTENCES_PER_BATCH = 80;

/** 1 回のクラウドバッチ呼び出しあたりの最大文字数目安 */
export const MAX_CHARS_PER_BATCH = 12000;

/** 1 ページあたりのクラウドバッチ呼び出し最大回数 */
export const MAX_BATCHES_PER_PAGE = 3;

const WORD_REGEX =
  /\[MATH\]|(?:[$€£¥](?=\d))?[\p{L}\p{N}]+(?:['’\-./][\p{L}\p{N}]+)*%?/gu;

const VALID_CONSTRUCT_SET = new Set<ConstructId>(CONSTRUCT_IDS);

const LONG_SUBJECT_STARTERS = new Set([
  'what',
  'whether',
  'that',
  'how',
  'why',
  'to',
]);

/** 英語の主要定形動詞・助動詞の簡易集合（バッチ判定時の long_subject 推定に使用） */
const FINITE_VERB_HINT_REGEX =
  /^(?:is|are|was|were|be|has|have|had|does|do|did|can|could|will|would|shall|should|may|might|must|remains?|becomes?|seems?|appears?|achieves?|shows?|demonstrates?|suggests?|confirms?|improves?|reduces?|increases?|introduces?|contains?|depends?|yields?|preserves?|struggles?|outperforms?|requires?|breaks?|aligns?|motivates?|provides?|eliminates?|parses?|collects?|runs?|works?|changes?|measures?|supports?|consumes?)$/i;

/** 文中の単語数を数える（[MATH] も 1 語としてカウント） */
export function countWords(sentence: string): number {
  return (sentence.match(WORD_REGEX) ?? []).length;
}

/**
 * バッチ判定用（まだ主語スパン S が未解析の段階）の long_subject コード判定。
 * - 先頭語が what / whether / that / how / why / to（文頭カンマ付き分詞・副詞句を除く）
 * - 先頭語が -ing 動名詞（カンマで区切られる分詞構文を除く）
 * - 文頭から最初の主節定形動詞候補までの語数が 6 語以上（形式主語 It ... を除く）
 */
export function detectLongSubjectFromSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  const words = trimmed.match(WORD_REGEX) ?? [];
  if (words.length < 4) return false;

  const first = (words[0] ?? '').toLowerCase();

  // 形式主語 It で始まる文は long_subject にしない
  if (first === 'it') return false;

  // 倒置や接続詞先頭の副詞節（Although / Given / Combining ... ,）は主語先頭ではない
  if (
    /^(?:although|though|while|whereas|because|since|if|unless|when|whenever|after|before|only|rarely|never|not|seldom|little|given|considering|assuming|compared|based)\b/i.test(
      trimmed,
    )
  ) {
    // ただしカンマの後ろにある主節側が長い主語になっているかを確認する
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx !== -1) {
      const mainClause = trimmed.slice(commaIdx + 1).trim();
      if (mainClause.length > 0) {
        return detectLongSubjectFromSentence(mainClause);
      }
    }
    return false;
  }

  // 1. what / whether / that / how / why / to で始まる主語
  if (LONG_SUBJECT_STARTERS.has(first)) {
    // "To reduce cost, we ..." のような目的の不定詞（カンマ区切り）は除外
    if (first === 'to' && trimmed.includes(',')) {
      return false;
    }
    return true;
  }

  // 2. -ing で始まる動名詞主語（"Combining A with B, the engine ..." の分詞構文はカンマがあるため除外）
  if (/^[a-z]{2,}ing$/.test(first)) {
    const firstComma = trimmed.indexOf(',');
    if (firstComma === -1) {
      return true;
    }
    // カンマより前に定形動詞が現れていれば動名詞主語
    const beforeCommaWords = trimmed.slice(0, firstComma).match(WORD_REGEX) ?? [];
    if (beforeCommaWords.slice(1).some((w) => FINITE_VERB_HINT_REGEX.test(w))) {
      return true;
    }
    return false;
  }

  // 3. 関係詞・分詞・同格・前置詞句などで主部が 6 語以上になっているか推定
  // 関係詞節や同格節の内部にある動詞を読み飛ばすため、関係詞・分詞の直後1〜4語をスキップして主節動詞位置を探す
  let idx = 1;
  let inClause = false;
  let clauseWords = 0;
  while (idx < words.length) {
    const w = words[idx].toLowerCase();
    if (w === 'that' || w === 'which' || w === 'who' || w === 'whom' || w === 'whose') {
      inClause = true;
      clauseWords = 0;
      idx += 1;
      continue;
    }
    if (inClause) {
      clauseWords += 1;
      // 関係詞節・同格節内の最初の動詞を超えた次の動詞を主節動詞候補とみなす
      if (clauseWords >= 3 && FINITE_VERB_HINT_REGEX.test(w)) {
        return idx >= 6;
      }
      idx += 1;
      continue;
    }
    if (FINITE_VERB_HINT_REGEX.test(w)) {
      return idx >= 6;
    }
    idx += 1;
  }

  return false;
}

/**
 * 候補が 1 ページの上限（最大 3 バッチ）を超えたときの優先順位づけ、
 * および API キー未設定時のルールベース暫定マークに使うスコア。
 */
export function computeHardRuleScore(sentence: string): number {
  const words = sentence.match(WORD_REGEX) ?? [];
  const wordCount = words.length;
  let score = 0;

  if (wordCount >= 28) {
    score += 3;
  } else if (wordCount >= 18) {
    score += 2;
  } else if (wordCount >= 12) {
    score += 1;
  }

  // 関係詞・従属接続詞
  if (/\b(?:that|which|who|whom|whose|where|whereas|although|whether)\b/i.test(sentence)) {
    score += 2;
  }

  // 比較構文・形式主語 it・倒置
  if (
    /\bthan\b/i.test(sentence) ||
    /\bIt\s+(?:is|was|remains|seems|appears)\b/.test(sentence) ||
    /^(?:Not only|Only\s+\w+|Rarely|Seldom|Never)\b/i.test(sentence.trim())
  ) {
    score += 2;
  }

  // 分詞後置修飾・分詞構文の手がかり
  if (/\b[a-z]{3,}(?:ed|ing)\s+(?:on|in|by|to|for|with|under|from|without)\b/i.test(sentence)) {
    score += 2;
  }

  // カンマ・セミコロン・ダッシュの多さ
  const punctCount = (sentence.match(/[,;:—–]/g) ?? []).length;
  if (punctCount >= 2) {
    score += 2;
  } else if (punctCount === 1) {
    score += 1;
  }

  return score;
}

export interface ComputedDifficultyResult {
  /** コード判定の long_subject を統合した最終 constructs */
  constructs: ConstructId[];
  /** 1〜5 の難易度（SPEC.md の計算式に基づく） */
  difficulty: number;
  /** CSS Custom Highlight API 用のマーク濃さ（0: なし, 1: 薄, 2: 標準, 3: 濃） */
  markLevel: MarkLevel;
  /** ユーザーの苦手構文に該当した構文一覧 */
  weakConstructsHit: ConstructId[];
}

/**
 * SPEC.md の計算式に従い、constructs・文の長さ・long_subject（コード判定）・
 * ユーザーの苦手構文（ConstructEntry の unsure 件数）から difficulty と markLevel を確定計算する。
 */
export function calculateDifficultyAndMarkLevel(
  sentence: string,
  aiConstructs: readonly ConstructId[],
  weakConstructCounts: Partial<Record<ConstructId, number>> = {},
  options?: { overrideLongSubject?: boolean },
): ComputedDifficultyResult {
  const effectiveSet = new Set<ConstructId>();
  for (const cid of aiConstructs) {
    if (VALID_CONSTRUCT_SET.has(cid) && cid !== 'long_subject') {
      effectiveSet.add(cid);
    }
  }

  const hasLongSubject =
    options?.overrideLongSubject !== undefined
      ? options.overrideLongSubject
      : detectLongSubjectFromSentence(sentence);
  if (hasLongSubject) {
    effectiveSet.add('long_subject');
  }

  const constructs = Array.from(effectiveSet);
  const wordCount = countWords(sentence);

  // lengthBonus: 30語以上 +2、20語以上 +1、20語未満 0
  const lengthBonus = wordCount >= 30 ? 2 : wordCount >= 20 ? 1 : 0;

  // difficulty (1..5) = clamp(1 + min(3, constructs.length) + lengthBonus, 1, 5)
  const rawDifficulty = 1 + Math.min(3, constructs.length) + lengthBonus;
  const difficulty = Math.max(1, Math.min(5, rawDifficulty));

  // baseLevel (0..2)
  let baseLevel: MarkLevel;
  if (constructs.length === 0 && wordCount < 25) {
    baseLevel = 0;
  } else if (
    (constructs.length === 1 && wordCount < 25) ||
    (constructs.length === 0 && wordCount >= 25)
  ) {
    baseLevel = 1;
  } else {
    baseLevel = 2;
  }

  // 苦手構文ブースト：unsure 記録が 1 件以上ある構文を含めば濃さを +1（最大 3）
  const weakConstructsHit = constructs.filter(
    (cid) => (weakConstructCounts[cid] ?? 0) > 0,
  );

  let markLevel: MarkLevel = baseLevel;
  if (weakConstructsHit.length > 0) {
    markLevel = Math.min(3, Math.max(1, baseLevel) + 1) as MarkLevel;
  }

  return {
    constructs,
    difficulty,
    markLevel,
    weakConstructsHit,
  };
}

export interface BatchCandidateInput {
  id: string;
  text: string;
  /** 画面に見えている位置から読む順の優先番号（小さいほど先に送る） */
  viewportOrder: number;
}

export interface BatchSelectionOptions {
  minWords?: number;
  maxSentencesPerBatch?: number;
  maxCharsPerBatch?: number;
  maxBatches?: number;
}

/** 読む順の候補列を最大 maxSentencesPerBatch 文 / maxCharsPerBatch 文字のバッチ列へ分割する */
function packIntoBatches<T extends { text: string }>(
  ordered: T[],
  maxSentencesPerBatch: number,
  maxCharsPerBatch: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;

  for (const item of ordered) {
    const itemChars = item.text.length;
    const wouldExceedCount = current.length >= maxSentencesPerBatch;
    const wouldExceedChars =
      current.length > 0 && currentChars + itemChars > maxCharsPerBatch;

    if (wouldExceedCount || wouldExceedChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(item);
    currentChars += itemChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * 候補文を選定し、画面に見えている部分から読む順に最大 3 バッチへ分割する。
 * - 8 語以上の文は原則すべて候補とする
 * - 1 バッチ上限：80 文または 12,000 文字
 * - 3 バッチ（最大 240 文 / 約 36,000 文字）に収まらない超長文ページのみ、
 *   ルールスコア上位を優先採用してから読む順に 3 バッチへ詰める
 */
export function selectAndBatchCandidates<T extends BatchCandidateInput>(
  items: readonly T[],
  options?: BatchSelectionOptions,
): T[][] {
  const minWords = options?.minWords ?? MIN_CANDIDATE_WORDS;
  const maxSentencesPerBatch =
    options?.maxSentencesPerBatch ?? MAX_SENTENCES_PER_BATCH;
  const maxCharsPerBatch = options?.maxCharsPerBatch ?? MAX_CHARS_PER_BATCH;
  const maxBatches = options?.maxBatches ?? MAX_BATCHES_PER_PAGE;

  // 8 語以上の文は原則すべて候補にし、画面位置からの読む順に並べる
  const eligible = items
    .filter((item) => countWords(item.text) >= minWords)
    .sort((a, b) => a.viewportOrder - b.viewportOrder);

  if (eligible.length === 0) {
    return [];
  }

  const directBatches = packIntoBatches(
    eligible,
    maxSentencesPerBatch,
    maxCharsPerBatch,
  );

  // 最大 3 バッチ以内に収まるなら全候補をそのまま返す
  if (directBatches.length <= maxBatches) {
    return directBatches;
  }

  // 上限を超える長いページはルールスコアで優先順位づけし、3 バッチに収まる分を採用する
  const maxTotalSentences = maxSentencesPerBatch * maxBatches;
  const maxTotalChars = maxCharsPerBatch * maxBatches;

  const prioritized = [...eligible].sort((a, b) => {
    const scoreDiff = computeHardRuleScore(b.text) - computeHardRuleScore(a.text);
    if (scoreDiff !== 0) return scoreDiff;
    return a.viewportOrder - b.viewportOrder;
  });

  const selected: T[] = [];
  let totalChars = 0;
  for (const item of prioritized) {
    if (selected.length >= maxTotalSentences) break;
    if (selected.length > 0 && totalChars + item.text.length > maxTotalChars) {
      continue;
    }
    selected.push(item);
    totalChars += item.text.length;
  }

  // 採用した候補を読む順（画面に見えている部分から）に戻して最大 maxBatches へ分割する
  selected.sort((a, b) => a.viewportOrder - b.viewportOrder);
  return packIntoBatches(
    selected,
    maxSentencesPerBatch,
    maxCharsPerBatch,
  ).slice(0, maxBatches);
}

/**
 * API キー未設定時（クラウド未使用）のルールベース暫定マーク用。
 * ルールスコアから暫定の markLevel（0..2）と difficulty（1..5）を返す。
 */
export function computeRuleFallbackMark(sentence: string): {
  difficulty: number;
  markLevel: MarkLevel;
  constructs: ConstructId[];
} {
  const score = computeHardRuleScore(sentence);
  const longSubj = detectLongSubjectFromSentence(sentence);
  const constructs: ConstructId[] = longSubj ? ['long_subject'] : [];

  if (score >= 6) {
    return { difficulty: 4, markLevel: 2, constructs };
  }
  if (score >= 4) {
    return { difficulty: 3, markLevel: 1, constructs };
  }
  return { difficulty: 1, markLevel: 0, constructs };
}
