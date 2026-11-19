import type { AnalysisSpan, ConstructId } from '../../types';

/** 構文メタ情報と日本語解説テンプレートの定義 */
export interface ConstructDefinition {
  id: ConstructId;
  labelJa: string;
  example: string;
  /** 日本語の解説テンプレート（AI に自由記述させず定型文で説明する） */
  explanationJa: string;
}

/** SPEC.md で定義された10種類の英語構文ID一覧 */
export const CONSTRUCT_IDS: readonly ConstructId[] = [
  'relative_clause',
  'omitted_relative',
  'participle_modifier',
  'long_subject',
  'formal_it',
  'inversion',
  'comparative',
  'apposition',
  'participial_construction',
  'coordination',
] as const;

/** AI 出力スキーマで指定させる構文ID一覧（long_subject はコード側で確定判定するため除外） */
export const AI_CONSTRUCT_IDS: readonly ConstructId[] = CONSTRUCT_IDS.filter(
  (id) => id !== 'long_subject',
);

const LONG_SUBJECT_STARTERS = new Set([
  'what',
  'whether',
  'that',
  'how',
  'why',
  'to',
]);

const WORD_COUNT_REGEX =
  /(?:[$€£¥](?=\d))?[\p{L}\p{N}]+(?:['’\-./][\p{L}\p{N}]+)*%?/gu;

/**
 * 主節の S が長い主語（long_subject）に該当するかをコード側で判定する。
 * ルール：主節の V より前にある S スパンが次のいずれかに当てはまる場合 true
 * - what / whether / that / how / why / to で始まる
 * - -ing で始まる動名詞
 * - 6 語以上
 * （形式主語 it で V の後ろに後置された真の主語は対象外とする）
 */
export function detectLongSubject(
  sentence: string,
  spans: AnalysisSpan[],
): boolean {
  const mainVerbs = spans.filter(
    (v) =>
      v.role === 'V' &&
      !spans.some(
        (other) =>
          other.role !== 'V' && other.start <= v.start && v.end <= other.end,
      ),
  );
  const firstMainVerbStart =
    mainVerbs.length > 0
      ? Math.min(...mainVerbs.map((v) => v.start))
      : Number.POSITIVE_INFINITY;

  // 外側スパンに含まれない主節の S のうち、主節 V より前にあるものを対象とする
  const preVerbalSubjects = spans.filter(
    (s) =>
      s.role === 'S' &&
      s.end <= firstMainVerbStart &&
      !spans.some(
        (other) => other !== s && other.start <= s.start && s.end <= other.end,
      ),
  );

  for (const subj of preVerbalSubjects) {
    const text = sentence.slice(subj.start, subj.end);
    const words = text.match(WORD_COUNT_REGEX) ?? [];
    if (words.length === 0) continue;

    const firstWord = (words[0] ?? '').toLowerCase();
    // "that result" のような短い指示形容詞 that + 名詞（3語以下）は that 節の長い主語ではない
    if (LONG_SUBJECT_STARTERS.has(firstWord)) {
      if (!(firstWord === 'that' && words.length <= 3)) {
        return true;
      }
    }
    // 動名詞（-ing で始まる主語。先頭語が英字2文字以上 + ing）
    if (/^[a-z]{2,}ing$/.test(firstWord)) {
      return true;
    }
    if (words.length >= 6) {
      return true;
    }
  }

  return false;
}

/** 構文IDごとの日本語ラベル・例文・定型解説 */
export const EN_CONSTRUCTS: Record<ConstructId, ConstructDefinition> = {
  relative_clause: {
    id: 'relative_clause',
    labelJa: '関係詞節',
    example: 'the method that we propose',
    explanationJa:
      '関係詞（that / which / who など）で始まるかたまりが、直前の名詞を後ろから修飾しています。',
  },
  omitted_relative: {
    id: 'omitted_relative',
    labelJa: '関係詞の省略',
    example: 'the data we collected',
    explanationJa:
      '名詞の直後に主語＋動詞が続いており、目的格の関係代名詞が省略されて前の名詞を修飾しています。',
  },
  participle_modifier: {
    id: 'participle_modifier',
    labelJa: '分詞の後置修飾',
    example: 'models trained on larger datasets',
    explanationJa:
      '過去分詞（-ed）や現在分詞（-ing）のかたまりが、直前の名詞を後ろから修飾しています。',
  },
  long_subject: {
    id: 'long_subject',
    labelJa: '長い主語',
    example: 'What the results suggest is ...',
    explanationJa:
      '主語が長い名詞句や名詞節になっているため、本動詞（V）の位置を見極めるのがポイントです。',
  },
  formal_it: {
    id: 'formal_it',
    labelJa: '形式主語 it',
    example: 'It is known that ...',
    explanationJa:
      '文頭の it は仮の主語で、本当の主語は後ろの to 不定詞や that 節に置かれています。',
  },
  inversion: {
    id: 'inversion',
    labelJa: '倒置',
    example: 'Only then did we notice ...',
    explanationJa:
      '否定語や強調語句が文頭に出たことなどにより、助動詞（did / do など）が主語の前に出て語順が入れ替わっています。',
  },
  comparative: {
    id: 'comparative',
    labelJa: '比較構文',
    example: 'higher accuracy than ...',
    explanationJa:
      '比較級＋than や as ... as などで、何と何を比べているかを対比して読む構文です。',
  },
  apposition: {
    id: 'apposition',
    labelJa: '同格',
    example: 'the idea that ...',
    explanationJa:
      '前の抽象名詞の内容を、直後の that 節や名詞句がイコール関係で具体的に説明しています。',
  },
  participial_construction: {
    id: 'participial_construction',
    labelJa: '分詞構文',
    example: 'Given these results, ...',
    explanationJa:
      '分詞で始まる副詞的なかたまりが、主節に対して「時・理由・条件・付帯状況」などを補っています。',
  },
  coordination: {
    id: 'coordination',
    labelJa: '並列',
    example: 'A and B of C',
    explanationJa:
      'and / or / but などの等位接続詞が、どの語句・動詞・節どうしを対等に結んでいるかを意識して読みます。',
  },
};

/** 構文IDから日本語ラベルを取得する */
export function getConstructLabelJa(id: ConstructId): string {
  return EN_CONSTRUCTS[id]?.labelJa ?? id;
}
