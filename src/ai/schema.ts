import { AI_CONSTRUCT_IDS, CONSTRUCT_IDS } from '../lang/en/constructs';
import type {
  Analysis,
  AnalysisSpan,
  AnalyzeTiming,
  BracketType,
  ConstructId,
  RetryErrorRecord,
  SpanRole,
} from '../types';

const VALID_ROLES = new Set<SpanRole>(['S', 'V', 'O', 'C', 'modifier']);
const VALID_BRACKETS = new Set<BracketType>(['noun', 'adj', 'adv']);
const VALID_CONSTRUCTS = new Set<ConstructId>(CONSTRUCT_IDS);

/**
 * Prompt API の responseConstraint に渡す JSON Schema（単語番号ベース）
 * - 主節の動詞はトップレベルの必須項目 mainVerbs（最低1個）で返させ、spans からは V を外す
 * - long_subject はコード側で判定するため constructs の enum から除外する
 */
export const WORD_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    mainVerbs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          startWord: { type: 'integer', minimum: 0 },
          endWord: { type: 'integer', minimum: 0 },
        },
        required: ['startWord', 'endWord'],
        additionalProperties: false,
      },
    },
    spans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startWord: { type: 'integer', minimum: 0 },
          endWord: { type: 'integer', minimum: 0 },
          role: { type: 'string', enum: ['S', 'O', 'C', 'modifier'] },
          bracket: { type: 'string', enum: ['noun', 'adj', 'adv'] },
          modifies: { type: 'integer', minimum: 0 },
        },
        required: ['startWord', 'endWord', 'role'],
        additionalProperties: false,
      },
    },
    constructs: {
      type: 'array',
      items: {
        type: 'string',
        enum: [...AI_CONSTRUCT_IDS],
      },
    },
    difficulty: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
    },
  },
  required: ['mainVerbs', 'spans', 'constructs', 'difficulty'],
  additionalProperties: false,
};

/**
 * 2段階プロンプトの 1 段目用 JSON Schema（主節の動詞の単語番号のみ抽出する）
 */
export const MAIN_VERB_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    mainVerbs: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          startWord: { type: 'integer', minimum: 0 },
          endWord: { type: 'integer', minimum: 0 },
        },
        required: ['startWord', 'endWord'],
        additionalProperties: false,
      },
    },
  },
  required: ['mainVerbs'],
  additionalProperties: false,
};

/**
 * Gemini REST API (generationConfig.responseSchema) 用のスキーマ定義
 */
export const CLOUD_WORD_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    mainVerbs: {
      type: 'ARRAY',
      minItems: 1,
      items: {
        type: 'OBJECT',
        properties: {
          startWord: { type: 'INTEGER' },
          endWord: { type: 'INTEGER' },
        },
        required: ['startWord', 'endWord'],
      },
    },
    spans: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startWord: { type: 'INTEGER' },
          endWord: { type: 'INTEGER' },
          role: { type: 'STRING', enum: ['S', 'O', 'C', 'modifier'] },
          bracket: { type: 'STRING', enum: ['noun', 'adj', 'adv'] },
          modifies: { type: 'INTEGER' },
        },
        required: ['startWord', 'endWord', 'role'],
      },
    },
    constructs: {
      type: 'ARRAY',
      items: {
        type: 'STRING',
        enum: [...AI_CONSTRUCT_IDS],
      },
    },
    difficulty: {
      type: 'INTEGER',
    },
  },
  required: ['mainVerbs', 'spans', 'constructs', 'difficulty'],
};

/** 検証エラー種別コード */
export type AnalysisValidationErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'EMPTY_SPANS'
  | 'WORD_INDEX_OUT_OF_RANGE'
  | 'SPAN_OUT_OF_RANGE'
  | 'SPAN_WHITESPACE_BOUNDARY'
  | 'SPAN_WORD_BOUNDARY'
  | 'SPAN_DUPLICATE'
  | 'SPAN_CROSSING_OVERLAP'
  | 'INVALID_ROLE'
  | 'INVALID_BRACKET'
  | 'INVALID_MODIFIES'
  | 'INVALID_CONSTRUCT'
  | 'INVALID_DIFFICULTY'
  | 'MISSING_MAIN_VERB'
  | 'MULTIPLE_MAIN_VERBS';

/** 解析結果の検証失敗を表すエラー */
export class AnalysisValidationError extends Error {
  readonly code: AnalysisValidationErrorCode;
  readonly rawOutput?: unknown;
  /** AI が返した生の JSON テキスト（誤り分析・評価ログ用） */
  rawText?: string;
  /** 再試行した回数 */
  attempts?: number;
  /** 初回失敗時のエラー記録 */
  firstAttemptError?: RetryErrorRecord;
  /** 計測済みタイミング情報 */
  timing?: AnalyzeTiming;

  constructor(
    code: AnalysisValidationErrorCode,
    message: string,
    rawOutput?: unknown,
  ) {
    super(message);
    this.name = 'AnalysisValidationError';
    this.code = code;
    this.rawOutput = rawOutput;
  }
}

/** Unicode の文字または数字かどうかを判定する（単語途中での分断検出に使用） */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * 主節の V を抽出する。
 * 定義：S・O・C・modifier のどのスパンにも含まれない V。
 */
export function findMainVerbSpans(spans: AnalysisSpan[]): AnalysisSpan[] {
  return spans.filter(
    (v) =>
      v.role === 'V' &&
      !spans.some(
        (other) =>
          other.role !== 'V' && other.start <= v.start && v.end <= other.end,
      ),
  );
}

/**
 * 文字位置ベースの解析結果（SPEC.md の Analysis 形式）を元の文と照合して検証する。
 * start / end の範囲外、空白混入、単語途中での分断、交差オーバーラップ、
 * および文法上の整合性（主節の V の有無・重複）を検出してエラーを投げる。
 */
export function validateAnalysis(sentence: string, raw: unknown): Analysis {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnalysisValidationError(
      'INVALID_SHAPE',
      '解析結果がオブジェクト形式ではありません。',
      raw,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.spans)) {
    throw new AnalysisValidationError(
      'INVALID_SHAPE',
      '解析結果の spans が配列ではありません。',
      raw,
    );
  }
  if (obj.spans.length === 0) {
    throw new AnalysisValidationError(
      'EMPTY_SPANS',
      '解析結果の spans が空です。',
      raw,
    );
  }

  if (!Array.isArray(obj.constructs)) {
    throw new AnalysisValidationError(
      'INVALID_SHAPE',
      '解析結果の constructs が配列ではありません。',
      raw,
    );
  }

  const constructs: ConstructId[] = [];
  const seenConstructs = new Set<ConstructId>();
  for (const item of obj.constructs) {
    if (typeof item !== 'string' || !VALID_CONSTRUCTS.has(item as ConstructId)) {
      throw new AnalysisValidationError(
        'INVALID_CONSTRUCT',
        `未定義の構文IDが含まれています: ${String(item)}`,
        raw,
      );
    }
    const cid = item as ConstructId;
    if (!seenConstructs.has(cid)) {
      seenConstructs.add(cid);
      constructs.push(cid);
    }
  }

  if (
    typeof obj.difficulty !== 'number' ||
    !Number.isInteger(obj.difficulty) ||
    obj.difficulty < 1 ||
    obj.difficulty > 5
  ) {
    throw new AnalysisValidationError(
      'INVALID_DIFFICULTY',
      `difficulty は 1〜5 の整数である必要があります（受信値: ${String(obj.difficulty)}）。`,
      raw,
    );
  }

  const spans: AnalysisSpan[] = [];
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

    if (
      typeof s.start !== 'number' ||
      typeof s.end !== 'number' ||
      !Number.isInteger(s.start) ||
      !Number.isInteger(s.end)
    ) {
      throw new AnalysisValidationError(
        'SPAN_OUT_OF_RANGE',
        `spans[${i}] の start / end は整数である必要があります。`,
        raw,
      );
    }

    if (s.start < 0 || s.end > sentence.length || s.start >= s.end) {
      throw new AnalysisValidationError(
        'SPAN_OUT_OF_RANGE',
        `spans[${i}] の文字範囲 [${s.start}, ${s.end}) が元の文（長さ ${sentence.length}）と合いません。`,
        raw,
      );
    }

    const slice = sentence.slice(s.start, s.end);
    if (slice.length === 0 || slice !== slice.trim()) {
      throw new AnalysisValidationError(
        'SPAN_WHITESPACE_BOUNDARY',
        `spans[${i}] の範囲 [${s.start}, ${s.end})（"${slice}"）の先頭または末尾に空白が含まれています。`,
        raw,
      );
    }

    if (
      (s.start > 0 &&
        isWordChar(sentence[s.start - 1]) &&
        isWordChar(sentence[s.start])) ||
      (s.end < sentence.length &&
        isWordChar(sentence[s.end - 1]) &&
        isWordChar(sentence[s.end]))
    ) {
      throw new AnalysisValidationError(
        'SPAN_WORD_BOUNDARY',
        `spans[${i}] の範囲 [${s.start}, ${s.end})（"${slice}"）が単語の途中で分断されています。`,
        raw,
      );
    }

    if (typeof s.role !== 'string' || !VALID_ROLES.has(s.role as SpanRole)) {
      throw new AnalysisValidationError(
        'INVALID_ROLE',
        `spans[${i}] の role が不正です: ${String(s.role)}`,
        raw,
      );
    }

    let bracket: BracketType | undefined;
    if (s.bracket !== undefined) {
      if (
        typeof s.bracket !== 'string' ||
        !VALID_BRACKETS.has(s.bracket as BracketType)
      ) {
        throw new AnalysisValidationError(
          'INVALID_BRACKET',
          `spans[${i}] の bracket が不正です: ${String(s.bracket)}`,
          raw,
        );
      }
      bracket = s.bracket as BracketType;
    }

    if (s.role === 'modifier' && bracket === undefined) {
      throw new AnalysisValidationError(
        'INVALID_BRACKET',
        `spans[${i}] は role="modifier" ですが bracket（noun / adj / adv）が指定されていません。`,
        raw,
      );
    }

    let modifies: number | undefined;
    if (s.modifies !== undefined) {
      if (
        typeof s.modifies !== 'number' ||
        !Number.isInteger(s.modifies) ||
        s.modifies < 0 ||
        s.modifies >= obj.spans.length ||
        s.modifies === i
      ) {
        throw new AnalysisValidationError(
          'INVALID_MODIFIES',
          `spans[${i}] の modifies（${String(s.modifies)}）が有効なスパン番号ではありません。`,
          raw,
        );
      }
      modifies = s.modifies;
    }

    const span: AnalysisSpan = {
      start: s.start,
      end: s.end,
      role: s.role as SpanRole,
    };
    if (bracket !== undefined) {
      span.bracket = bracket;
    }
    if (modifies !== undefined) {
      span.modifies = modifies;
    }
    spans.push(span);
  }

  // スパン同士の重複・交差オーバーラップを検出する（入れ子は許可、交差は禁止）
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.start === b.start && a.end === b.end) {
        throw new AnalysisValidationError(
          'SPAN_DUPLICATE',
          `spans[${i}] と spans[${j}] が同じ範囲 [${a.start}, ${a.end}) を重複指定しています。`,
          raw,
        );
      }
      const crosses =
        (a.start < b.start && b.start < a.end && a.end < b.end) ||
        (b.start < a.start && a.start < b.end && b.end < a.end);
      if (crosses) {
        throw new AnalysisValidationError(
          'SPAN_CROSSING_OVERLAP',
          `spans[${i}] [${a.start}, ${a.end}) と spans[${j}] [${b.start}, ${b.end}) が交差しています。`,
          raw,
        );
      }
    }
  }

  // 文法整合チェック：
  // 主節の V ＝ S・O・C・modifier のどのスパンにも含まれない V
  // （名詞節主語や that 節などの S / O の中に別の V が含まれること自体は許可する）
  const mainVerbs = findMainVerbSpans(spans);
  if (mainVerbs.length === 0) {
    throw new AnalysisValidationError(
      'MISSING_MAIN_VERB',
      'S・O・C・modifier のいずれにも含まれない主節の動詞（V）が見つかりません。',
      raw,
    );
  }
  if (mainVerbs.length > 1 && !constructs.includes('coordination')) {
    throw new AnalysisValidationError(
      'MULTIPLE_MAIN_VERBS',
      `主節の動詞（V）が ${mainVerbs.length} 個ありますが、constructs に coordination が含まれていません。`,
      raw,
    );
  }

  return {
    spans,
    constructs,
    difficulty: obj.difficulty,
  };
}
