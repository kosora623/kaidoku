import type { MainVerbWordSpan } from '../types';
import type { LanguageModelMessage } from './prompt-api';
import type { AnalysisValidationError } from './schema';
import type { WordToken } from './tokenizer';

/**
 * 英語の文構造解析用システムプロンプトを返す。
 * - 主節の動詞は必須項目 mainVerbs に出力させ、spans からは V を除外する
 * - long_subject はコード側で自動判定するため AI には出力させない
 * - 形式主語 it・受け身（be + 過去分詞）・節の内部に S/V/O/C を付けない方針を明記する
 */
export function buildAnalysisSystemPrompt(): string {
  return [
    'You are an English syntax analyzer for Japanese English-interpretation notation (英文解釈).',
    'Analyze ONE English sentence and output ONLY valid JSON matching the schema.',
    '',
    'Strict structural rules:',
    '1. Word indices: startWord and endWord are 0-based INCLUSIVE indices from the given numbered word list.',
    '2. Main clause verb(s) in "mainVerbs" (REQUIRED, at least 1):',
    '   - Output ONLY the main clause verb(s) in "mainVerbs" (do NOT put V in "spans").',
    '   - Passive voice ("be + past participle", e.g., "is well established", "was proposed"): include the entire passive verb phrase as ONE item in "mainVerbs" (do NOT mark the past participle as C). If an adverb is inside it (e.g., "well"), put that adverb in "spans" as role="modifier", bracket="adv".',
    '   - Phrasal main verbs (e.g., "breaks down"): include as ONE item in "mainVerbs".',
    '   - Separated auxiliary + main verb in inversion (e.g., "did ... meet", "do ... generalize", "does ... reduce"): put ONLY the main verb ("meet", "generalize", "reduce") in "mainVerbs" (omit the fronted auxiliary).',
    '   - Coordinated main verbs (joined by "and" / "but" / "or"): put each coordinated main verb in "mainVerbs" AND include "coordination" in "constructs".',
    '3. Full Subject (S) in "spans":',
    '   - Mark the main clause subject as role="S", bracket="noun" (omit bracket for bare pronoun "It" in formal_it). It MUST include any relative clause, appositive clause, or post-modifier attached to it, and MUST stop BEFORE the main verb.',
    '   - Formal subject "it" ("It ... that-clause" / "It ... to-infinitive"): mark "It" as role="S" (no bracket), mark the entire extraposed "that"-clause or "to"-infinitive phrase as role="S", bracket="noun" (true subject), and include "formal_it" in "constructs".',
    '4. Object (O) / Complement (C) in "spans":',
    '   - Mark the direct object of the main verb as role="O", bracket="noun", and a complement as role="C" (use bracket="noun" for noun phrases, omit bracket for bare adjectives).',
    '5. No S/V/O/C inside subordinate clauses:',
    '   - Do NOT label S, V, O, or C INSIDE noun clauses (that-clause, what-clause, whether-clause, to-infinitive) or INSIDE adverbial clauses (Although..., When..., Because...).',
    '   - DO keep nested modifiers (( ), < >, [ ]) inside noun phrases, comparative phrases, and subordinate clauses.',
    '6. Modifiers in "spans":',
    '   - bracket="adj" (( )): relative clauses and participial post-modifiers ("-ed / -ing ..." modifying a noun, including nested ones inside comparative/object phrases).',
    '   - bracket="noun" ([ ]): appositive "that"-clauses (role="modifier", modifies the outer noun phrase) and noun clauses nested inside adverbial clauses.',
    '   - bracket="adv" (< >): comparative "than..." phrases, adverbial clauses, participial constructions, adverbs, and prepositional phrases that modify a verb or the whole clause.',
    '   - Do NOT bracket prepositional phrases that modify a noun.',
    '7. Strict nesting and modifies:',
    '   - Every nested modifier MUST lie completely inside its parent span. Never create crossing spans or duplicate (startWord, endWord) pairs (including against mainVerbs).',
    '   - Set "modifies" ONLY when pointing to another span in "spans" (0 <= modifies < spans.length, modifies != current index). OMIT "modifies" when modifying a verb in "mainVerbs".',
    '8. constructs (do NOT output long_subject — it is computed by code):',
    '   - Choose only applicable IDs from: relative_clause, omitted_relative, participle_modifier, formal_it, inversion, comparative, apposition, participial_construction, coordination.',
    '9. difficulty: Integer 1 (simple) to 5 (complex).',
  ].join('\n');
}

/**
 * 1文と単語分割結果からユーザープロンプトを構築する。
 * 2段階プロンプトの 2 段目では、1 段目で確定した主節動詞を前提として与える。
 */
export function buildAnalysisUserPrompt(
  sentence: string,
  tokens: WordToken[],
  confirmedMainVerbs?: MainVerbWordSpan[],
): string {
  const wordList = tokens.map((t) => `${t.index}:${t.text}`).join(' ');
  const lines = [
    `Sentence: ${sentence}`,
    `Words (0..${Math.max(0, tokens.length - 1)}): ${wordList}`,
  ];

  if (confirmedMainVerbs && confirmedMainVerbs.length > 0) {
    const verbDesc = confirmedMainVerbs
      .map((v) => `word ${v.startWord}..${v.endWord} ("${v.text}")`)
      .join(', ');
    lines.push(
      `Premise — Main clause verb (mainVerbs): ${verbDesc}. Use this exact span in "mainVerbs", keep it OUTSIDE of S/O/C/modifier, and end S before it.`,
    );
  }

  lines.push('Return the JSON analysis.');
  return lines.join('\n');
}

/**
 * 2段階プロンプトの 1 段目用システムプロンプト（保留中の実験機能）。
 */
export function buildMainVerbSystemPrompt(): string {
  return [
    'You find ONLY the main clause verb(s) of an English sentence.',
    'Output ONLY JSON: {"mainVerbs":[{"startWord":i,"endWord":j}]} using 0-based inclusive word indices.',
    '',
    'Rules:',
    '- Return the main verb of the MAIN clause (the finite verb that governs the whole sentence).',
    '- EXCLUDE verbs inside relative clauses (that/which/who ...), omitted relative clauses ("the data we collected"), participial modifiers (-ed/-ing modifying a noun), that-clauses, or adverbial clauses (Although/When/Because ...).',
    '- For passive voice ("be + past participle"), include the full passive verb phrase.',
    '- For inverted auxiliary + verb ("did ... meet"), include ONLY the main verb ("meet").',
    '- Return 2 items ONLY when the main clause has coordinated main verbs joined by and/but/or.',
  ].join('\n');
}

/**
 * 2段階プロンプトの 1 段目用ユーザープロンプトを構築する。
 */
export function buildMainVerbUserPrompt(
  sentence: string,
  tokens: WordToken[],
): string {
  const wordList = tokens.map((t) => `${t.index}:${t.text}`).join(' ');
  return [
    `Sentence: ${sentence}`,
    `Words (0..${Math.max(0, tokens.length - 1)}): ${wordList}`,
    'Return ONLY the main clause verb word index(es) as JSON.',
  ].join('\n');
}

/**
 * 2段階プロンプト 1 段目の initialPrompts（本番30文・dev10文と一切重複させない）
 */
export function buildMainVerbInitialPrompts(): LanguageModelMessage[] {
  return [
    {
      role: 'system',
      content: buildMainVerbSystemPrompt(),
    },
    {
      role: 'user',
      content: [
        'Sentence: The model which they built yields better results than baselines published last year.',
        'Words (0..12): 0:The 1:model 2:which 3:they 4:built 5:yields 6:better 7:results 8:than 9:baselines 10:published 11:last 12:year',
        'Return ONLY the main clause verb word index(es) as JSON.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [{ startWord: 5, endWord: 5 }],
      }),
    },
    {
      role: 'user',
      content: [
        'Sentence: The tools we built analyze logs and report anomalies automatically.',
        'Words (0..9): 0:The 1:tools 2:we 3:built 4:analyze 5:logs 6:and 7:report 8:anomalies 9:automatically',
        'Return ONLY the main clause verb word index(es) as JSON.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [
          { startWord: 4, endWord: 4 },
          { startWord: 7, endWord: 7 },
        ],
      }),
    },
  ];
}

/**
 * バリデーション失敗時の 1 回再試行用フィードバックプロンプトを構築する。
 */
export function buildRetryFeedbackPrompt(
  error: AnalysisValidationError,
): string {
  const hintMap: Partial<Record<AnalysisValidationError['code'], string>> = {
    MISSING_MAIN_VERB:
      'Put the main clause verb(s) in "mainVerbs" (at least 1 item) OUTSIDE of S, O, C, and modifier spans. Make sure S ends BEFORE the main verb.',
    MULTIPLE_MAIN_VERBS:
      'Include multiple items in "mainVerbs" ONLY when main verbs are coordinated (and include "coordination" in constructs).',
    SPAN_CROSSING_OVERLAP:
      'Spans (and mainVerbs) must NOT partially overlap. Any inner modifier must lie completely inside its parent span.',
    INVALID_MODIFIES:
      'For every modifier in "spans", set "modifies" ONLY to another valid span index in "spans" (j != current index), or OMIT "modifies" when modifying a verb in "mainVerbs".',
    INVALID_BRACKET:
      'Every span with role="modifier" MUST specify a valid "bracket" ("adj", "adv", or "noun"). Do not output a modifier without a bracket.',
    WORD_INDEX_OUT_OF_RANGE:
      'All startWord and endWord indices must satisfy 0 <= startWord <= endWord < wordCount.',
    SPAN_DUPLICATE:
      'Do not output two spans (or a span and a mainVerb) with the exact same (startWord, endWord) range.',
  };

  const hint = hintMap[error.code] ?? 'Fix the invalid span indices and structure.';

  return [
    `Your previous JSON failed validation (${error.code}): ${error.message}`,
    `Correction required: ${hint}`,
    'Return the corrected JSON analysis for the same sentence.',
  ].join('\n');
}

/**
 * Prompt API / Cloud 共通のシステム指示＋マルチターン Few-shot 例を構築する。
 * （tests/eval/sentences.json の本番 30 文とは一切重複させない）
 */
export function buildAnalysisInitialPrompts(): LanguageModelMessage[] {
  return [
    {
      role: 'system',
      content: buildAnalysisSystemPrompt(),
    },
    // 例1: 関係詞節 + 比較 + 分詞の後置修飾
    {
      role: 'user',
      content: [
        'Sentence: The model which they built yields better results than baselines published last year.',
        'Words (0..12): 0:The 1:model 2:which 3:they 4:built 5:yields 6:better 7:results 8:than 9:baselines 10:published 11:last 12:year',
        'Return the JSON analysis.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [{ startWord: 5, endWord: 5 }],
        spans: [
          { startWord: 0, endWord: 4, role: 'S', bracket: 'noun' },
          { startWord: 2, endWord: 4, role: 'modifier', bracket: 'adj', modifies: 0 },
          { startWord: 6, endWord: 7, role: 'O', bracket: 'noun' },
          { startWord: 8, endWord: 12, role: 'modifier', bracket: 'adv', modifies: 2 },
          { startWord: 10, endWord: 12, role: 'modifier', bracket: 'adj', modifies: 3 },
        ],
        constructs: ['relative_clause', 'comparative', 'participle_modifier'],
        difficulty: 3,
      }),
    },
    // 例2: 形式主語 it（to 不定詞を真の主語 S にする）
    {
      role: 'user',
      content: [
        'Sentence: It is important to check boundary indices before rendering.',
        'Words (0..8): 0:It 1:is 2:important 3:to 4:check 5:boundary 6:indices 7:before 8:rendering',
        'Return the JSON analysis.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [{ startWord: 1, endWord: 1 }],
        spans: [
          { startWord: 0, endWord: 0, role: 'S' },
          { startWord: 2, endWord: 2, role: 'C' },
          { startWord: 3, endWord: 8, role: 'S', bracket: 'noun' },
        ],
        constructs: ['formal_it'],
        difficulty: 3,
      }),
    },
    // 例3: 形式主語 it（that 節）＋ 受け身（be + 副詞 + 過去分詞を 1 つの V にまとめる）＋ 節内部に S/V/O/C を付けない
    {
      role: 'user',
      content: [
        'Sentence: It is widely known that compact decoders require less memory.',
        'Words (0..9): 0:It 1:is 2:widely 3:known 4:that 5:compact 6:decoders 7:require 8:less 9:memory',
        'Return the JSON analysis.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [{ startWord: 1, endWord: 3 }],
        spans: [
          { startWord: 0, endWord: 0, role: 'S' },
          { startWord: 2, endWord: 2, role: 'modifier', bracket: 'adv' },
          { startWord: 4, endWord: 9, role: 'S', bracket: 'noun' },
        ],
        constructs: ['formal_it'],
        difficulty: 3,
      }),
    },
    // 例4: 並列動詞（coordination）
    {
      role: 'user',
      content: [
        'Sentence: The tool reads raw traces and flags unusual delays automatically.',
        'Words (0..9): 0:The 1:tool 2:reads 3:raw 4:traces 5:and 6:flags 7:unusual 8:delays 9:automatically',
        'Return the JSON analysis.',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
        mainVerbs: [
          { startWord: 2, endWord: 2 },
          { startWord: 6, endWord: 6 },
        ],
        spans: [
          { startWord: 0, endWord: 1, role: 'S', bracket: 'noun' },
          { startWord: 3, endWord: 4, role: 'O', bracket: 'noun' },
          { startWord: 7, endWord: 8, role: 'O', bracket: 'noun' },
          { startWord: 9, endWord: 9, role: 'modifier', bracket: 'adv' },
        ],
        constructs: ['coordination'],
        difficulty: 2,
      }),
    },
  ];
}
