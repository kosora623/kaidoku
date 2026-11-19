/**
 * χ読（かいどく）共通データ型定義
 * SPEC.md の「英文解釈の記法と出力形式」「データと保存」に準拠する。
 */

/** 文の要素または修飾の役割 */
export type SpanRole = 'S' | 'V' | 'O' | 'C' | 'modifier';

/** 英文解釈の括弧の種類（noun: [ ], adj: ( ), adv: < >） */
export type BracketType = 'noun' | 'adj' | 'adv';

/** 最初に用意する10種類の英語構文ID */
export type ConstructId =
  | 'relative_clause'
  | 'omitted_relative'
  | 'participle_modifier'
  | 'long_subject'
  | 'formal_it'
  | 'inversion'
  | 'comparative'
  | 'apposition'
  | 'participial_construction'
  | 'coordination';

/** 文字位置（0始まり・endは排他）で表現される解析スパン */
export interface AnalysisSpan {
  start: number;
  end: number;
  role: SpanRole;
  bracket?: BracketType;
  /** 修飾先となる spans 配列内のインデックス */
  modifies?: number;
}

/** SPEC.md 準拠の構文解析結果（文字位置ベース） */
export interface Analysis {
  spans: AnalysisSpan[];
  constructs: ConstructId[];
  /** 難易度（1〜5の整数） */
  difficulty: number;
}

/** AI 出力用の中間スパン（0始まり・endWordは包含の単語インデックス） */
export interface WordSpan {
  startWord: number;
  endWord: number;
  role: SpanRole;
  bracket?: BracketType;
  modifies?: number;
}

/** AI 出力用の中間解析結果（単語番号ベース） */
export interface WordBasedAnalysis {
  spans: WordSpan[];
  constructs: ConstructId[];
  difficulty: number;
}

/** 読んだ文（単語・構文の記録が共通で参照する） */
export interface SourceSentence {
  id: string;
  text: string;
  pageUrl: string;
  pageTitle: string;
  /** 将来の多言語対応用 */
  lang: 'en';
  analysis?: Analysis;
  createdAt: string;
}

/** 記録した単語 */
export interface WordEntry {
  id: string;
  word: string;
  /** 文脈に合う意味 */
  meaning: string;
  sentenceId: string;
}

/** つまずいた構文 */
export interface ConstructEntry {
  id: string;
  construct: ConstructId;
  sentenceId: string;
  result: 'understood' | 'unsure';
}

/** 復習の状態（間隔反復） */
export interface ReviewCard {
  id: string;
  kind: 'word' | 'construct';
  /** WordEntry か ConstructEntry の id */
  refId: string;
  dueAt: string;
  /** 日数 */
  interval: number;
  ease: number;
  lapses: number;
}

/** 実際に解析を実行した AI プロバイダ */
export type AiProvider = 'nano' | 'cloud';

/** ユーザーが選択する AI モード */
export type AiProviderPreference = 'auto' | 'nano' | 'cloud';

/** Gemini Nano のプロンプト方式（1段階 / 2段階実験） */
export type NanoPromptMode = 'one-stage' | 'two-stage';

/** 2段階プロンプトの 1 段目で抽出した主節動詞スパン（単語番号ベース） */
export interface MainVerbWordSpan {
  startWord: number;
  endWord: number;
  text: string;
}

/** 土台セッション作成時間と解析時間の内訳 */
export interface AnalyzeTiming {
  /** 土台セッションの新規作成にかかった時間（ms）。再利用時・Cloud時は 0 */
  sessionCreateMs: number;
  /** 解析（clone + prompt + 再試行 + 変換・検証・待機込み）にかかった時間（ms） */
  analyzeMs: number;
  /** 合計時間（ms） */
  totalMs: number;
  /** 2段階解析の 1 段目（骨格抽出）にかかった時間（ms、レート制限待機を除く） */
  stage1Ms?: number;
  /** 本解析（1段階、または 2段階の 2 段目初回）にかかった時間（ms、レート制限待機を除く） */
  stage2Ms?: number;
  /** 検証エラーによる再試行にかかった時間（ms、レート制限待機を除く） */
  retryMs?: number;
  /** RPM 制御および 429 / 503 リトライによる待ち時間合計（ms） */
  waitMs?: number;
}

/** 再試行時に発生した初回検証エラーの記録 */
export interface RetryErrorRecord {
  code: string;
  message: string;
  rawText?: string;
}

/** 1文の解析結果とメタ情報 */
export interface AnalyzeResult {
  analysis: Analysis;
  provider: AiProvider;
  /** AI が返した生のテキスト（デバッグ・誤り分析用） */
  rawText: string;
  /** 合計所要時間（ミリ秒・後方互換用） */
  elapsedMs: number;
  /** 土台作成時間と解析時間の分離計測結果 */
  timing: AnalyzeTiming;
  /** 今回の解析で土台セッションを新規作成したか */
  sessionCreated: boolean;
  /** 試行回数（1 = 初回成功、2 = 1回再試行で成功） */
  attempts: number;
  /** 軽い検証エラー（不正な modifies・modifier の bracket 欠落）を自動修復した内容 */
  repaired?: string[];
  /** 再試行が発生した場合の初回失敗情報 */
  firstAttemptError?: RetryErrorRecord;
  /** Nano 失敗などにより別プロバイダへ切り替わった理由 */
  fallbackReason?: string;
  /** API キー未設定時など、精度が低い実験的な Nano モードで実行したか */
  isExperimentalNano?: boolean;
  /** 画面上に表示すべき注意メッセージ（実験モード警告など） */
  noticeMessage?: string;
  /** Nano 実行時のプロンプト方式 */
  nanoPromptMode?: NanoPromptMode;
  /** 2段階プロンプト 1 段目の主節動詞検出結果（デバッグ・分析用） */
  stage1MainVerbs?: MainVerbWordSpan[];
  /** 使用したモデル名 */
  modelName: string;
}

/** Prompt API 実機検証の結果 */
export interface PromptApiProbeResult {
  context: 'service_worker' | 'extension_page' | 'offscreen';
  hasLanguageModel: boolean;
  availability: string | null;
  params: {
    defaultTopK?: number;
    maxTopK?: number;
    defaultTemperature?: number;
    maxTemperature?: number;
  } | null;
  promptTestOk: boolean;
  promptTestOutput?: string;
  error?: string;
}

/** 難文ハイライトの濃さ段階（0: マークなし / 1: 薄め / 2: 標準 / 3: 濃い・苦手構文強調） */
export type MarkLevel = 0 | 1 | 2 | 3;

/** ページ内マーク密度のユーザー設定（low: 上位10% / normal: 上位20% / high: 上位40%） */
export type MarkDensity = 'low' | 'normal' | 'high';

/** 外部（Google Gemini API）データ送信の同意状態 */
export interface CloudConsentState {
  granted: boolean;
  version: string;
  grantedAt: string | null;
}

/** URL ごとにキャッシュする 1 文分の難文判定結果 */
export interface CachedSentenceMark {
  sentenceHash: string;
  text: string;
  constructs: ConstructId[];
  difficulty: number;
}

/** Dexie に保存するページ単位の難文判定キャッシュ */
export interface PageMarkCache {
  /** 正規化 URL（ハッシュ・utm_* 等除去） */
  url: string;
  pageTitle: string;
  /** 候補文全体のハッシュ（記事更新検知用） */
  contentHash: string;
  provider: 'cloud' | 'rule';
  modelName: string;
  batchCallCount: number;
  marks: CachedSentenceMark[];
  createdAt: string;
  expiresAt: string;
}

/** Content Script へ返す 1 文分の判定結果（密度切替時の再計算に使うスコアも含む） */
export interface MarkedSentencePayload {
  id: string;
  sentenceHash: string;
  text: string;
  constructs: ConstructId[];
  difficulty: number;
  /** ページ内相対順位づけ用の難度スコア（高いほど難文） */
  hardnessScore: number;
  markLevel: MarkLevel;
  weakConstructsHit: ConstructId[];
}

