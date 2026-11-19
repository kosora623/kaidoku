# χ読 プロジェクトルール
- 仕様は必ずリポジトリ直下の SPEC.md に従う。仕様と違う判断が必要なときは、実装前に理由を書いて確認を取る
- Chrome拡張 Manifest V3、Vite + TypeScript、Dexie、Vitest を使う
- UIの文言とコードのコメントは日本語で書く
- Gemini Nano（Prompt API）には「文の構造をJSONで返す」仕事だけを任せる。日本語の解説文をNanoに自由に書かせない。解説は構文の種類ごとのテンプレートで組み立てる
- 権限は最小限にする。全サイトへの常時アクセスは取らない
- 外部サーバーにデータを送るのは、ユーザーがAPIキーを設定してクラウドのGeminiを使うときだけ
- 新しいロジックには Vitest のテストを付ける。作業の最後に npm test と npm run build が通ることを確認する
- Prompt API の使い方は推測せず、developer.chrome.com の公式ドキュメントを確認してから書く