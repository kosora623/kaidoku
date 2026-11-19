import { CONSTRUCT_IDS } from './constructs';
import type { ConstructId, MarkDensity, MarkLevel } from '../../types';

/** 候補抽出の最小単語数（8 語以上の文は原則すべて候補にする） */
export const MIN_CANDIDATE_WORDS = 8;

/** 1 回のクラウドバッチ呼び出しあたりの最大文数 */
export const MAX_SENTENCES_PER_BATCH = 80;

/** 1 回のクラウドバッチ呼び出しあたりの最大文字数目安 */
export const MAX_CHARS_PER_BATCH = 12000;

/** 1 ページあたりのクラウドバッチ呼び出し最大回数 */
export const MAX_BATCHES_PER_PAGE = 3;

/** ページ内マーク密度ごとの上位割合（少なめ 10% / ふつう 20% / 多め 40%） */
export const MARK_DENSITY_RATIO: Record<MarkDensity, number> = {
  low: 0.1,
  normal: 0.2,
  high: 0.4,
};

/**
 * 構文ごとの誤読しやすさ重み。
 * 誤読しやすい構文（関係詞省略・倒置・分詞後置修飾・同格・形式主語 it・分詞構文）を高くし、
 * 論文で頻出する relative_clause は抑える。
 */
export const CONSTRUCT_WEIGHTS: Record<ConstructId, number> = {
  omitted_relative: 3.0,
  inversion: 3.0,
  participle_modifier: 2.5,
  apposition: 2.5,
  formal_it: 2.5,
  participial_construction: 2.5,
  long_subject: 1.5,
  comparative: 1.5,
  coordination: 1.0,
  relative_clause: 0.8,
};

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
    // "that result neither gives ..." のような指示形容詞 that + 名詞は除外（that 節なら動詞の前に複数語）
    if (first === 'that') {
      const firstVerbIdx = words.findIndex(
        (w, idx) => idx >= 1 && FINITE_VERB_HINT_REGEX.test(w),
      );
      if (firstVerbIdx > 0 && firstVerbIdx <= 3) {
        return false;
      }
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
  /** 1〜5 の難易度 */
  difficulty: number;
  /** ページ内相対順位づけに使う難度スコア（誤読しやすい構文ほど高い） */
  hardnessScore: number;
  /** 単文評価時の仮マーク濃さ（ページ全体では applyRelativePageMarks で順位決定する） */
  markLevel: MarkLevel;
  /** ユーザーの苦手構文に該当した構文一覧 */
  weakConstructsHit: ConstructId[];
}

/**
 * constructs・文の長さ・long_subject（コード判定）・ユーザーの苦手構文から
 * 難度スコア（hardnessScore）・difficulty（1〜5）・単文基準の markLevel を算出する。
 * 誤読しやすい構文の重みを高くし、文の長さと relative_clause の重みは低く抑える。
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

  // 構文重みの合計
  let constructScore = 0;
  for (const cid of constructs) {
    constructScore += CONSTRUCT_WEIGHTS[cid] ?? 1.0;
  }

  // 文の長さの重みは低く抑える（20語未満 0、30語 +0.5、40語 +1.0、上限 +1.5）
  const lengthScore =
    wordCount <= 20 ? 0 : Math.min(1.5, (wordCount - 20) * 0.05);

  // 苦手構文ブースト：unsure 記録が 1 件以上ある構文を含めばスコアを加算（上限 +4.0）
  const weakConstructsHit = constructs.filter(
    (cid) => (weakConstructCounts[cid] ?? 0) > 0,
  );
  const weakBoost = Math.min(4.0, weakConstructsHit.length * 2.0);

  // 構文が 0 個かつ 25 語未満の単純文はスコア 0（マーク対象外）
  const rawScore =
    constructs.length === 0 && wordCount < 25
      ? 0
      : constructScore + lengthScore + weakBoost;
  const hardnessScore = Math.round(rawScore * 100) / 100;

  // difficulty (1..5) は難度スコアから決定
  let difficulty = 1;
  if (hardnessScore >= 7.0) {
    difficulty = 5;
  } else if (hardnessScore >= 4.5) {
    difficulty = 4;
  } else if (hardnessScore >= 2.5) {
    difficulty = 3;
  } else if (hardnessScore > 0) {
    difficulty = 2;
  }

  // 単文基準の仮 markLevel（ページ全体では applyRelativePageMarks が順位で確定する）
  let baseLevel: MarkLevel;
  if (hardnessScore <= 0) {
    baseLevel = 0;
  } else if (hardnessScore >= 4.5) {
    baseLevel = 2;
  } else {
    baseLevel = 1;
  }

  let markLevel: MarkLevel = baseLevel;
  if (weakConstructsHit.length > 0 && hardnessScore > 0) {
    markLevel = Math.min(3, Math.max(1, baseLevel) + 1) as MarkLevel;
  }

  return {
    constructs,
    difficulty,
    hardnessScore,
    markLevel,
    weakConstructsHit,
  };
}

export interface RelativeRankInput {
  id: string;
  hardnessScore: number;
  weakConstructsHit: readonly ConstructId[];
  viewportOrder?: number;
}

/**
 * ページ内の全判定文から、難度スコア上位（low: 10% / normal: 20% / high: 40%）だけをマーク対象とし、
 * マークした文の中での順位に応じて濃さ（1: 軽め / 2: 標準 / 3: 濃い）を決定する。
 * 戻り値は各文 id → MarkLevel（マーク対象外は 0）の Map。
 */
export function applyRelativePageMarks(
  items: readonly RelativeRankInput[],
  options: {
    totalPageSentences: number;
    density: MarkDensity;
  },
): Map<string, MarkLevel> {
  const result = new Map<string, MarkLevel>();
  for (const item of items) {
    result.set(item.id, 0);
  }

  const eligible = items.filter((item) => item.hardnessScore > 0);
  if (eligible.length === 0) {
    return result;
  }

  const ratio = MARK_DENSITY_RATIO[options.density] ?? MARK_DENSITY_RATIO.normal;
  const baseTotal = Math.max(options.totalPageSentences, items.length);
  const targetCount = Math.min(
    eligible.length,
    Math.max(1, Math.round(baseTotal * ratio)),
  );

  const sorted = [...eligible].sort((a, b) => {
    if (b.hardnessScore !== a.hardnessScore) {
      return b.hardnessScore - a.hardnessScore;
    }
    if (b.weakConstructsHit.length !== a.weakConstructsHit.length) {
      return b.weakConstructsHit.length - a.weakConstructsHit.length;
    }
    return (a.viewportOrder ?? 0) - (b.viewportOrder ?? 0);
  });

  const selected = sorted.slice(0, targetCount);
  const count = selected.length;

  for (let rank = 0; rank < count; rank++) {
    const item = selected[rank];
    let level: MarkLevel;
    if (count === 1) {
      level = item.weakConstructsHit.length > 0 ? 3 : 2;
    } else {
      const pct = rank / count;
      if (pct < 0.2) {
        level = 3;
      } else if (pct < 0.6) {
        level = 2;
      } else {
        level = 1;
      }
      if (item.weakConstructsHit.length > 0 && level < 3) {
        level = (level + 1) as MarkLevel;
      }
    }
    result.set(item.id, level);
  }

  return result;
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
 * ルールスコアから暫定の markLevel（0..2）・difficulty（1..5）・hardnessScore を返す。
 */
export function computeRuleFallbackMark(sentence: string): {
  difficulty: number;
  hardnessScore: number;
  markLevel: MarkLevel;
  constructs: ConstructId[];
} {
  const score = computeHardRuleScore(sentence);
  const longSubj = detectLongSubjectFromSentence(sentence);
  const constructs: ConstructId[] = longSubj ? ['long_subject'] : [];
  const hardnessScore = score >= 4 ? score : 0;

  if (score >= 6) {
    return { difficulty: 4, hardnessScore, markLevel: 2, constructs };
  }
  if (score >= 4) {
    return { difficulty: 3, hardnessScore, markLevel: 1, constructs };
  }
  return { difficulty: 1, hardnessScore: 0, markLevel: 0, constructs };
}
