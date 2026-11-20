# χ読（かいどく）仕様書

Nov 19, 2026 · @kosora

## 概要

χ読は、英語の記事や論文を読みながら「読む力」そのものを育てるChrome拡張です。翻訳ツールが答えを渡すのに対し、χ読は誤読しやすい文に先回りで印をつけ、構造を図解して、自分で読めるように導きます。

- **名前**：χ読（かいどく / Kaidoku）。未知数のχと「解読」をかけ、未知の文章を読み解く意味を込めた
- **キャッチコピー**：絡まった英文を、ほどいて読む。
- **応募先**：Google AI Challenge（締切 2026年11月30日 23:59）、はたらく・まなぶ部門
- **位置づけ**：2作品応募のうちの「無難枠」。尖った枠はTSUMIKI（余力があれば）

| 審査基準 | χ読での打ち出し方 |
| --- | --- |
| 独創性 | 翻訳ではなく構造を見せる。日本の「英文解釈」の記法で図解し、自分の誤読パターンを学習する |
| 社会・暮らしへの貢献度 | 英語の壁は日本全体の課題。論文・技術記事を読む学生や社会人の学びを支える |
| AI活用の有効性 | 30文の実測評価に基づき、精度と応答速度に優れるクラウドのGemini（Flash-Lite）を既定にしつつ、APIキー未設定環境では手元のGemini Nano（実験モード）でも動作するハイブリッド構成 |
| 展開可能性 | 言語を増やせる作り（中国語など）。学校の授業や社内の英語資料にも使える |

既存の類似ツール（FlowReader、StructRead、LexiScopeなど）は「選択した文を解析・翻訳する」形が中心。χ読は自分で選ぶ前にAIが印をつけ、単語ではなく構文のつまずきを記録する点で差別化する。

## 機能と使う流れ

使う流れは「読む → つまずきに気づく → 記録する → 自分の文で復習する」の1本道です。

1. 英語の記事や論文を開き、拡張のボタンを押す
2. 誤読しやすい文の本文左側の余白に紫の縦線（ガター）がつく。そのまま読み進める
3. 引っかかった文をタップすると、英文解釈の図と短い解説が出る。日本語訳は「訳を見る」を押したときだけ出す
4. 「分かった／まだ怪しい」を押すと、その構文が自分の苦手として記録される
5. 知らない単語をタップすると意味が出て、元の文と記事ごと記録できる
6. 復習画面で、単語と構文を元の文のカードで確かめる。間違えたカードほど早く出てくる

| 機能 | 内容 | 優先度 |
| --- | --- | --- |
| 難文の自動マーク | ページ内の文を判定し、誤読しやすい文を本文左余白の紫の縦線（ガター）で表示。苦手な構文を含む文は太く濃くする | 必須 |
| 英文解釈の図解 | \[ \] ( ) < > とS・V・O・Cで文の構造を表示 | 必須 |
| 構文のつまずき記録 | 関係詞の省略、長い主語など、構文の種類ごとに記録 | 必須 |
| 単語の記録 | 意味に加え、元の文・記事URL・タイトルを一緒に保存 | 必須 |
| 復習 | 単語と構文を元の文のカードで出題。間隔反復で出す順を決める | 必須 |
| 訳の表示 | ボタンを押したときだけ日本語訳を出す | 必須 |
| PDF対応 | pdf.jsで自前のPDFビューアを作り、同じ機能を使えるようにする | 余力があれば |
| 他言語対応 | 言語ごとの処理を差し替えられる作りにしておき、応募後に追加 | 将来 |

最初に対応するページは、Webの記事とarXivのHTML版の論文です。Chrome内蔵のPDFビューアの中には拡張から印をつけられないため、PDFは自前ビューアで対応します。

## AIの構成

AIには「構造をJSONで返す」狭い仕事だけを任せます。日本語の自由な解説はAIに書かせず、構文の種類ごとに用意した日本語のテンプレートで組み立てます。誤りのある解説は、精読を学ぶ道具として致命的だからです。

**30文評価による構成見直し（2026-11-19、詳細は [docs/eval-report.md](docs/eval-report.md) を参照）**

- 当初は手元の Gemini Nano を主系として検証した（ThinkPad E14 Gen 6、Chrome 157、メモリ約31GB・8コアCPU）。Service Worker 上で `LanguageModel` の動作と JSON 構造化出力を確認できたが、論文寄りの30文（プロンプト調整には未使用）で定量評価したところ以下の結果となった：
  - **Gemini Nano**：S・V 両方一致 **16.7%**、検証通過率 50.0%、2回目以降の中央値 **25.7秒/文**
  - **クラウド（`gemini-3.1-flash-lite`）**：改善前は S・V 両方一致 **73.3%**（検証通過率 86.7%）、スキーマ・ルール改善後（`dev-sentences.json` 10文のみで調整）は S・V 両方一致 **96.7%**・主節 V 一致 **100.0%**・スパン厳密 F1 **95.8%**・構文検出 F1 **98.9%**・検証通過率 **100.0%**、2回目以降の中央値 **1.7秒/文**
- この結果に基づき、**構造の解析および難文判定はクラウドの Gemini（`gemini-3.1-flash-lite`）を既定**とする。
- ユーザーが API キーを設定していない場合のみ、手元の Gemini Nano にフォールバックし、画面上に「精度が低い実験的なモード」であることを明示する。
- クラウドへ英文やページ本文を送信することになるため、初回利用時にデータ送信の同意画面を表示して明示的な承諾を得る（無料枠では送信内容が製品改善に使われる場合がある旨も表示する）。

| 処理 | 担当 | 呼ぶタイミング |
| --- | --- | --- |
| 難文の判定 | 8語以上の文を候補とし、1回あたり最大80文・約12,000文字（1ページ最大3回、画面に見えている位置から読む順）でクラウドの Gemini（Flash-Lite）へまとめて送信して各文の `constructs` のみを判定。難易度・マーク濃さはコード側で計算し、URLごとにキャッシュ | ボタンを押したとき（キャッシュがないURLのみ） |
| 構造の解析 | クラウドの Gemini（Flash-Lite、JSONスキーマで出力を固定）。APIキー未設定時のみ Gemini Nano（実験モード） | 文をタップしたとき |
| 日本語の解説 | テンプレート（AIを使わない） | 解析結果が出たとき |
| 日本語訳 | クラウドの Gemini（Flash-Lite）または Gemini Nano（ページ内の略語定義を反映） | 「訳を見る」を押したとき |
| 単語の意味 | クラウドの Gemini（Flash-Lite）または Gemini Nano（文脈に合う意味を1つ。略語はページ内定義を優先し、未定義時は推測せず明示） | 単語をタップしたとき |

**難文マークのスコア・相対順位・描画方式（コード側で確定計算）**

バッチ判定では AI に `difficulty` を出させず `constructs`（`long_subject` を除く 9 種）だけを返させ、`long_subject` のコード判定・構文ごとの誤読重み・文の長さ・ユーザーの苦手構文（`ConstructEntry` の `unsure` 記録）からページ内の相対順位でマーク対象と濃さを決める。

- **構文ごとの重み**：誤読しやすい構文（`omitted_relative`・`inversion`: 3.0、`participle_modifier`・`apposition`・`formal_it`・`participial_construction`: 2.5）を高くし、`long_subject`・`comparative`（1.5）、`coordination`（1.0）、論文で頻出する `relative_clause`（0.8）および文の長さ（20 語超から緩やかに最大 +1.5）の重みを抑える。苦手構文（`unsure` あり）は +2.0/種（上限 +4.0）を加算する
- **ページ内上位のみマーク**：ページ全体（全 N 文）のうち、難度スコア上位 **20%**（ステータスバーで「少なめ 10% / ふつう 20% / 多め 40%」を API 再呼び出しなしで即時切替・保存可能）だけをマークし、濃さ（レベル 1〜3）もマークした文の中での順位（上位 20%＝レベル 3、20〜60%＝レベル 2、60〜100%＝レベル 1、苦手構文ヒット時は +1 強調）で決定する
- **描画方式**：本文には常時の下線・背景色を付けず、マークした文の `Range.getClientRects()` から本文左側の余白（余白がないページでは本文左端）に行の高さに合わせた **紫系 1 色の縦線（ガター）** を Shadow DOM オーバーレイに描画し、濃さ 1〜3 を太さと不透明度で区別する（スクロール・リサイズ・DOM 変化に追従）。文や縦線にマウスを乗せたときだけ `CSS Custom Highlight API`（`kaidoku-hover`）で薄い点線下線＋半透明背景を表示し、クリックで選択中の文（`kaidoku-active`）にのみ半透明背景色を付ける。arXiv HTML の文中数式（`.ltx_Math` 等）は送信テキストでは `[MATH]` に置換し、元の DOM `Range` をそのまま保つ（`.ltx_equation`・コード・参考文献は対象外）。
- **API レート制御**：難文マークバッチ・構造解析・単語の意味取得・日本語訳のすべてのクラウド呼び出しを合算して 1 分あたり 15 回以内に共有レートリミッタで制御する。また、すべてのクラウド送信直前に外部データ送信の同意状態を確認する。

**APIキーとプライバシー**：APIキーは今動いているものとは別のプロジェクトで発行する。無料枠では送った内容が製品改善に使われる場合があるため、初回同意画面および設定画面にその旨を表示する。

**精度の確かめ方**：簡単な文から論文の難文まで30文の評価データ（`tests/eval/sentences.json`）で正解率を測り、応募文に数字で載せる。プロンプトの調整には別の10文（`tests/eval/dev-sentences.json`）のみを使い、本番30文は最終確認にのみ使用する。

## 英文解釈の記法と出力形式

記法は日本の参考書でよく使われる形に合わせます。名詞のかたまりは \[ \]、形容詞的な修飾は ( )、副詞的な修飾は < > でくくり、文の要素にS・V・O・Cを振ります。

```
[The method (that we propose)] S
  achieves V
  [higher accuracy] O
  <than existing approaches (trained on larger datasets)>.
```

Nanoには次のJSONスキーマで返させます（Prompt APIの`responseConstraint`で固定）。位置は文字列ではなく文字の位置で持ち、元の文と照らし合わせて崩れを検出します。

```json
{
  "spans": [
    { "start": 0, "end": 34, "role": "S", "bracket": "noun" },
    { "start": 11, "end": 33, "role": "modifier", "bracket": "adj", "modifies": 0 },
    { "start": 35, "end": 43, "role": "V" }
  ],
  "constructs": ["relative_clause", "comparative", "participle_modifier"],
  "difficulty": 3
}
```

- `role`：S / V / O / C / modifier
- `bracket`：noun（\[ \]）/ adj（( )）/ adv（< >）
- `modifies`：修飾先のspanの番号
- `constructs`：解説テンプレートと苦手の記録に使う構文の種類
- `difficulty`：1〜5。難文マークの濃さに使う

記法上の統一ルール：
- **1 語の S・O・C**：`We`・`It`・`D-Adaptation`・`[MATH]` のように 1 語だけで構成される S・O・C には `[ ]`（`bracket: "noun"`）を付けず、2 語以上の名詞句・名詞節にのみ `[ ]` を付ける（AI 出力・正解ラベルともコード側で統一正規化する）
- **同格の that 節（`apposition`）**：関係詞節 `( )` と見た目で区別するため、`bracket: "noun"`（`[ ]`）・`role: "modifier"` とし、`modifies` に先行する名詞（外側の名詞句）を指定する
- **前置詞句**：名詞を修飾する前置詞句は括弧を付けない。動詞・文全体を修飾する前置詞句は `< >`（`bracket: "adv"`）で囲む。どちらにもかかりうる曖昧な文は評価セットに入れない

最初に用意する構文の種類（各種類に日本語の解説テンプレートを書く）：

| 種類 | 例 |
| --- | --- |
| relative\_clause（関係詞節） | the method that we propose |
| omitted\_relative（関係詞の省略） | the data we collected |
| participle\_modifier（分詞の後置修飾） | models trained on larger datasets |
| long\_subject（長い主語） | What the results suggest is ... |
| formal\_it（形式主語it） | It is known that ... |
| inversion（倒置） | Only then did we notice ... |
| comparative（比較構文） | higher accuracy than ... |
| apposition（同格・`bracket: "noun"`, `role: "modifier"` で `[ ]` 表示） | the idea [that ...] |
| participial\_construction（分詞構文） | Given these results, ... |
| coordination（並列） | A and B of C |

## データと保存

データはすべて手元のIndexedDB（Dexie）に保存し、外部サーバーには送りません。JSONでのエクスポート・インポートを用意します。

```ts
// 読んだ文（単語・構文の記録が共通で参照する）
interface SourceSentence {
  id: string;
  text: string;          // 元の文
  pageUrl: string;
  pageTitle: string;
  lang: 'en';            // 将来の多言語対応用
  analysis?: Analysis;   // Nanoの解析結果（前節のJSON）
  createdAt: string;
}

// 記録した単語
interface WordEntry {
  id: string;
  word: string;
  meaning: string;       // 文脈に合う意味
  sentenceId: string;
}

// つまずいた構文
interface ConstructEntry {
  id: string;
  construct: string;     // relative_clause など
  sentenceId: string;
  result: 'understood' | 'unsure';
}

// 復習の状態（間隔反復）
interface ReviewCard {
  id: string;
  kind: 'word' | 'construct';
  refId: string;         // WordEntry か ConstructEntry の id
  dueAt: string;
  interval: number;      // 日数
  ease: number;
  lapses: number;
}
```

苦手な構文は、ConstructEntryの「unsure」の件数を構文の種類ごとに集計して決めます。その構文を含む文は、難文マークで濃く表示します。

## 拡張機能の構成

Manifest V3、Vite＋TypeScript、Dexie、Vitestで作ります。ビルド構成、background経由でDBを読み書きする形、CIとリリースのワークフローは、Bookmark Sorterと同じ形を踏襲します。

| ファイル | 役割 |
| --- | --- |
| `src/content.ts` | ページ本文の文分割、左ガター描画、タップで出る解析パネル、単語のタップ、「訳を見る」折りたたみ表示 |
| `src/gutter.ts` | マーク文の `Range.getClientRects()` から左余白ガター縦線の座標を計算 |
| `src/background.ts` | DBの読み書き、同意ガード、AI呼び出しの取り次ぎ |
| `src/ai/nano.ts` | Prompt API（Gemini Nano）の呼び出しとJSONスキーマ |
| `src/ai/cloud.ts` | クラウドのGemini APIの呼び出し（構造解析・バッチ難文判定） |
| `src/ai/word-meaning.ts` | 文脈に合う単語・略語の意味取得（クラウド／Nano） |
| `src/ai/translate.ts` | 「訳を見る」押下時の1文日本語訳生成（ページ内略語定義を反映） |
| `src/ai/router.ts` | クラウド優先／Nanoフォールバックの切り替えと利用可否判定 |
| `src/lang/en/` | 英語専用の処理（文分割、難文のルール、解説テンプレート、略語定義探索 `acronym.ts`）。言語を増やすときはここを足す |
| `src/notation.ts` | 解析JSONから \[ \] ( ) < > とS・V・O・Cの表示を作る |
| `src/review.ts` | 間隔反復の計算 |
| `src/db.ts` | Dexieのスキーマ |
| `consent.html` | 初回利用時の外部データ送信の同意画面 |
| `review.html` | 復習画面（単語・構文カード） |
| `options.html` | 設定画面（APIキー、無料枠の注意書き、開発者モード、エクスポート） |
| `viewer.html` | 自前のPDFビューア（pdf.js、余力があれば） |

**最初に確かめること**：Prompt APIを拡張のどこから呼べるか。service workerから呼べない場合は、offscreen documentか拡張のページで呼ぶ。

**権限**：`storage`、`unlimitedStorage`、`activeTab`、`scripting`。全サイトへの常時アクセスは取らず、ボタンを押したページにだけ注入する。クラウドを使うときだけ `https://generativelanguage.googleapis.com/*` を追加。

## スケジュールと応募準備

χ読は11月25日に応募し、残りの5日をTSUMIKIに回します。共通部分（Nanoとクラウドの切り替え）はTSUMIKIでも使い回します。

&#91;embedded content: χ読とTSUMIKIの制作予定 · 11/19〜11/30\]

応募前にやること：

- [ ] Google AI Studioで、今動いているものとは別のプロジェクトのAPIキーを発行する
- [ ] テスト用の30文でNanoの正解率を測る
- [ ] 自分で毎日使い、記録した単語・構文の数を集める
- [ ] 90秒以内のデモ動画を作る
- [ ] エントリーシートと「作品のPR」を書く
- [ ] GitHubのリポジトリを公開し、成果物URLに載せる（コミットにClaudeの署名は付けない）
- [ ] 「主に使用したAIツール」にGeminiとGoogle Antigravityを書く。実装は実際にAntigravityを中心に進める
