# χ読 評価データ正解ラベル確認シート

このファイルは `npm run eval:labels` で自動生成されています。
正解ラベルを修正する場合は `tests/eval/sentences.json` または `tests/eval/dev-sentences.json` を編集し、`npm run eval:labels` と `npm test` を再実行してください。

## 本番評価セット（sentences.json）（30 文）

元ファイル: `tests/eval/sentences.json`

### eval-01（カテゴリ: `simple` / 難易度: 1）

> The experiment confirms our initial hypothesis.

```text
[The experiment] S
  confirms V
  [our initial hypothesis] O.
```

- **constructs**: なし（`[]`）

### eval-04（カテゴリ: `relative_clause` / 難易度: 2）

> The architecture that we introduce improves translation quality substantially.

```text
[The architecture (that we introduce)] S
  improves V
  [translation quality] O
  <substantially>.
```

- **constructs**: `relative_clause`（関係詞節）
- **modifies**: `that we introduce` → `The architecture that we introduce` / `substantially` → `improves`

### eval-05（カテゴリ: `relative_clause` / 難易度: 2）

> Researchers who study neural networks often encounter vanishing gradients.

```text
[Researchers (who study neural networks)] S
  <often>
  encounter V
  [vanishing gradients] O.
```

- **constructs**: `relative_clause`（関係詞節）
- **modifies**: `who study neural networks` → `Researchers who study neural networks` / `often` → `encounter`

### eval-07（カテゴリ: `omitted_relative` / 難易度: 3）

> The features we extracted capture subtle temporal dependencies.

```text
[The features (we extracted)] S
  capture V
  [subtle temporal dependencies] O.
```

- **constructs**: `omitted_relative`（関係詞の省略）
- **modifies**: `we extracted` → `The features we extracted`

### eval-08（カテゴリ: `omitted_relative` / 難易度: 3）

> The latency users experience depends on network congestion.

```text
[The latency (users experience)] S
  depends V
  <on network congestion>.
```

- **constructs**: `omitted_relative`（関係詞の省略）
- **modifies**: `users experience` → `The latency users experience` / `on network congestion` → `depends`

### eval-09（カテゴリ: `omitted_relative` / 難易度: 3）

> The hyperparameters they selected yield stable convergence during training.

```text
[The hyperparameters (they selected)] S
  yield V
  [stable convergence] O
  <during training>.
```

- **constructs**: `omitted_relative`（関係詞の省略）
- **modifies**: `they selected` → `The hyperparameters they selected` / `during training` → `yield`

### eval-10（カテゴリ: `participle_modifier` / 難易度: 3）

> Models quantized to four bits preserve strong reasoning performance.

```text
[Models (quantized to four bits)] S
  preserve V
  [strong reasoning performance] O.
```

- **constructs**: `participle_modifier`（分詞の後置修飾）
- **modifies**: `quantized to four bits` → `Models quantized to four bits`

### eval-11（カテゴリ: `participle_modifier` / 難易度: 3）

> Approaches relying on synthetic labels struggle with domain shift.

```text
[Approaches (relying on synthetic labels)] S
  struggle V
  <with domain shift>.
```

- **constructs**: `participle_modifier`（分詞の後置修飾）
- **modifies**: `relying on synthetic labels` → `Approaches relying on synthetic labels` / `with domain shift` → `struggle`

### eval-12（カテゴリ: `participle_modifier` / 難易度: 3）

> The system evaluated on noisy speech benchmarks outperforms conventional pipelines.

```text
[The system (evaluated on noisy speech benchmarks)] S
  outperforms V
  [conventional pipelines] O.
```

- **constructs**: `participle_modifier`（分詞の後置修飾）, `long_subject`（長い主語）
- **modifies**: `evaluated on noisy speech benchmarks` → `The system evaluated on noisy speech benchmarks`

### eval-13（カテゴリ: `long_subject` / 難易度: 3）

> What these ablation studies demonstrate is the importance of careful regularization.

```text
[What these ablation studies demonstrate] S
  is V
  [the importance of careful regularization] C.
```

- **constructs**: `long_subject`（長い主語）

### eval-14（カテゴリ: `long_subject` / 難易度: 4）

> Whether sparse attention scales to million-token contexts remains an open question.

```text
[Whether sparse attention scales to million-token contexts] S
  remains V
  [an open question] C.
```

- **constructs**: `long_subject`（長い主語）

### eval-15（カテゴリ: `long_subject` / 難易度: 3）

> Training large foundation models on uncurated web corpora introduces severe calibration errors.

```text
[Training large foundation models on uncurated web corpora] S
  introduces V
  [severe calibration errors] O.
```

- **constructs**: `long_subject`（長い主語）

### eval-16（カテゴリ: `formal_it` / 難易度: 3）

> It is well established that deeper networks require residual connections.

```text
It S
  is <well> established V
  [that deeper networks require residual connections] S.
```

- **constructs**: `formal_it`（形式主語 it）
- **modifies**: `well` → `is well established`

### eval-17（カテゴリ: `formal_it` / 難易度: 3）

> It remains difficult to guarantee factual consistency without external retrieval.

```text
It S
  remains V
  difficult C
  [to guarantee factual consistency without external retrieval] S.
```

- **constructs**: `formal_it`（形式主語 it）

### eval-18（カテゴリ: `formal_it` / 難易度: 3）

> It is noteworthy that smaller distilled models match larger teachers on narrow tasks.

```text
It S
  is V
  noteworthy C
  [that smaller distilled models match larger teachers on narrow tasks] S.
```

- **constructs**: `formal_it`（形式主語 it）

### eval-19（カテゴリ: `inversion` / 難易度: 4）

> Only after extensive pruning did the model meet our latency budget.

```text
<Only after extensive pruning>
  did
  [the model] S
  meet V
  [our latency budget] O.
```

- **constructs**: `inversion`（倒置）
- **modifies**: `Only after extensive pruning` → `meet`

### eval-20（カテゴリ: `inversion` / 難易度: 4）

> Rarely do heuristic rules generalize across heterogeneous hardware platforms.

```text
<Rarely>
  do
  [heuristic rules] S
  generalize V
  <across heterogeneous hardware platforms>.
```

- **constructs**: `inversion`（倒置）
- **modifies**: `Rarely` → `generalize` / `across heterogeneous hardware platforms` → `generalize`

### eval-21（カテゴリ: `comparative` / 難易度: 3）

> Our decoder requires less memory than autoregressive models deployed on cloud servers.

```text
[Our decoder] S
  requires V
  [less memory] O
  <than autoregressive models (deployed on cloud servers)>.
```

- **constructs**: `comparative`（比較構文）, `participle_modifier`（分詞の後置修飾）
- **modifies**: `than autoregressive models deployed on cloud servers` → `less memory` / `deployed on cloud servers` → `than autoregressive models deployed on cloud servers`

### eval-22（カテゴリ: `comparative` / 難易度: 3）

> Sparse routing achieves higher throughput than dense layers trained under identical budgets.

```text
[Sparse routing] S
  achieves V
  [higher throughput] O
  <than dense layers (trained under identical budgets)>.
```

- **constructs**: `comparative`（比較構文）, `participle_modifier`（分詞の後置修飾）
- **modifies**: `than dense layers trained under identical budgets` → `higher throughput` / `trained under identical budgets` → `than dense layers trained under identical budgets`

### eval-23（カテゴリ: `comparative` / 難易度: 3）

> The lightweight classifier runs faster than standard baselines evaluated on mobile chips.

```text
[The lightweight classifier] S
  runs V
  <faster than standard baselines (evaluated on mobile chips)>.
```

- **constructs**: `comparative`（比較構文）, `participle_modifier`（分詞の後置修飾）
- **modifies**: `faster than standard baselines evaluated on mobile chips` → `runs` / `evaluated on mobile chips` → `faster than standard baselines evaluated on mobile chips`

### eval-24（カテゴリ: `apposition` / 難易度: 4）

> The assumption that input tokens are independent breaks down in long documents.

```text
[The assumption [that input tokens are independent]] S
  breaks down V
  <in long documents>.
```

- **constructs**: `apposition`（同格）, `long_subject`（長い主語）
- **modifies**: `that input tokens are independent` → `The assumption that input tokens are independent` / `in long documents` → `breaks down`

### eval-25（カテゴリ: `apposition` / 難易度: 4）

> Our finding that early layers encode syntactic roles aligns with prior probing work.

```text
[Our finding [that early layers encode syntactic roles]] S
  aligns V
  <with prior probing work>.
```

- **constructs**: `apposition`（同格）, `long_subject`（長い主語）
- **modifies**: `that early layers encode syntactic roles` → `Our finding that early layers encode syntactic roles` / `with prior probing work` → `aligns`

### eval-26（カテゴリ: `apposition` / 難易度: 4）

> The hypothesis that scaling laws plateau under data scarcity motivates our analysis.

```text
[The hypothesis [that scaling laws plateau under data scarcity]] S
  motivates V
  [our analysis] O.
```

- **constructs**: `apposition`（同格）, `long_subject`（長い主語）
- **modifies**: `that scaling laws plateau under data scarcity` → `The hypothesis that scaling laws plateau under data scarcity`

### eval-27（カテゴリ: `participial_construction` / 難易度: 3）

> Given limited labeled samples, semi-supervised learning provides substantial gains.

```text
<Given limited labeled samples>,
  [semi-supervised learning] S
  provides V
  [substantial gains] O.
```

- **constructs**: `participial_construction`（分詞構文）
- **modifies**: `Given limited labeled samples` → `provides`

### eval-28（カテゴリ: `participial_construction` / 難易度: 4）

> Combining local caching with asynchronous prefetching, the engine eliminates disk bottlenecks.

```text
<Combining local caching with asynchronous prefetching>,
  [the engine] S
  eliminates V
  [disk bottlenecks] O.
```

- **constructs**: `participial_construction`（分詞構文）
- **modifies**: `Combining local caching with asynchronous prefetching` → `eliminates`

### eval-29（カテゴリ: `coordination` / 難易度: 3）

> The framework parses raw logs and detects anomalous latency spikes in real time.

```text
[The framework] S
  parses V
  [raw logs] O
  and
  detects V
  [anomalous latency spikes] O
  <in real time>.
```

- **constructs**: `coordination`（並列）
- **modifies**: `in real time` → `detects`

### eval-30（カテゴリ: `coordination` / 難易度: 3）

> The authors collect diverse clinical records and validate their predictions against expert diagnoses.

```text
[The authors] S
  collect V
  [diverse clinical records] O
  and
  validate V
  [their predictions] O
  <against expert diagnoses>.
```

- **constructs**: `coordination`（並列）
- **modifies**: `against expert diagnoses` → `validate`

### eval-31（カテゴリ: `complex` / 難易度: 5）

> Although recent work has shown that larger models generalize better, the gains we observe on tasks requiring multi-step reasoning remain limited.

```text
<Although recent work has shown [that larger models generalize better]>,
  [the gains (we observe on tasks (requiring multi-step reasoning))] S
  remain V
  limited C.
```

- **constructs**: `omitted_relative`（関係詞の省略）, `participle_modifier`（分詞の後置修飾）, `long_subject`（長い主語）
- **modifies**: `Although recent work has shown that larger models generalize better` → `remain` / `that larger models generalize better` → `Although recent work has shown that larger models generalize better` / `we observe on tasks requiring multi-step reasoning` → `the gains we observe on tasks requiring multi-step reasoning` / `requiring multi-step reasoning` → `we observe on tasks requiring multi-step reasoning`

### eval-32（カテゴリ: `complex` / 難易度: 5）

> The results reported in Table 3, which were obtained without any task-specific tuning, suggest that the proposed objective is robust to label noise.

```text
[The results (reported in Table 3), (which were obtained without any task-specific tuning),] S
  suggest V
  [that the proposed objective is robust to label noise] O.
```

- **constructs**: `participle_modifier`（分詞の後置修飾）, `relative_clause`（関係詞節）, `long_subject`（長い主語）
- **modifies**: `reported in Table 3` → `The results reported in Table 3, which were obtained without any task-specific tuning,` / `which were obtained without any task-specific tuning` → `The results reported in Table 3, which were obtained without any task-specific tuning,`

### eval-33（カテゴリ: `complex` / 難易度: 5）

> Not only does the proposed method reduce memory usage, but it also improves the stability of training on long sequences.

```text
<Not only>
  does
  [the proposed method] S
  reduce V
  [memory usage] O,
  but
  [it] S
  <also>
  improves V
  [the stability of training on long sequences] O.
```

- **constructs**: `inversion`（倒置）, `coordination`（並列）
- **modifies**: `Not only` → `reduce` / `also` → `improves`

## プロンプト調整セット（dev-sentences.json）（10 文）

元ファイル: `tests/eval/dev-sentences.json`

### dev-01（カテゴリ: `comparative` / 難易度: 3）

> The method that we propose achieves higher accuracy than existing approaches trained on larger datasets.

```text
[The method (that we propose)] S
  achieves V
  [higher accuracy] O
  <than existing approaches (trained on larger datasets)>.
```

- **constructs**: `relative_clause`（関係詞節）, `comparative`（比較構文）, `participle_modifier`（分詞の後置修飾）
- **modifies**: `that we propose` → `The method that we propose` / `than existing approaches trained on larger datasets` → `higher accuracy` / `trained on larger datasets` → `than existing approaches trained on larger datasets`

### dev-02（カテゴリ: `simple` / 難易度: 1）

> The server processes incoming requests quickly.

```text
[The server] S
  processes V
  [incoming requests] O
  <quickly>.
```

- **constructs**: なし（`[]`）
- **modifies**: `quickly` → `processes`

### dev-03（カテゴリ: `relative_clause` / 難易度: 2）

> The metric that the committee adopted measures structural fidelity.

```text
[The metric (that the committee adopted)] S
  measures V
  [structural fidelity] O.
```

- **constructs**: `relative_clause`（関係詞節）, `long_subject`（長い主語）
- **modifies**: `that the committee adopted` → `The metric that the committee adopted`

### dev-04（カテゴリ: `omitted_relative` / 難易度: 3）

> The evidence we gathered supports an alternative explanation.

```text
[The evidence (we gathered)] S
  supports V
  [an alternative explanation] O.
```

- **constructs**: `omitted_relative`（関係詞の省略）
- **modifies**: `we gathered` → `The evidence we gathered`

### dev-05（カテゴリ: `participle_modifier` / 難易度: 3）

> Algorithms optimized for edge devices consume minimal battery power.

```text
[Algorithms (optimized for edge devices)] S
  consume V
  [minimal battery power] O.
```

- **constructs**: `participle_modifier`（分詞の後置修飾）
- **modifies**: `optimized for edge devices` → `Algorithms optimized for edge devices`

### dev-06（カテゴリ: `long_subject` / 難易度: 3）

> What the reviewers noticed is a subtle flaw in the baseline setup.

```text
[What the reviewers noticed] S
  is V
  [a subtle flaw in the baseline setup] C.
```

- **constructs**: `long_subject`（長い主語）

### dev-07（カテゴリ: `formal_it` / 難易度: 3）

> It is essential to verify output offsets against the original text.

```text
It S
  is V
  essential C
  [to verify output offsets against the original text] S.
```

- **constructs**: `formal_it`（形式主語 it）

### dev-08（カテゴリ: `inversion` / 難易度: 4）

> Only then did the team discover the hidden synchronization bug.

```text
<Only then>
  did
  [the team] S
  discover V
  [the hidden synchronization bug] O.
```

- **constructs**: `inversion`（倒置）
- **modifies**: `Only then` → `discover`

### dev-09（カテゴリ: `apposition` / 難易度: 3）

> The idea that compact models can run locally changes software design.

```text
[The idea [that compact models can run locally]] S
  changes V
  [software design] O.
```

- **constructs**: `apposition`（同格）, `long_subject`（長い主語）
- **modifies**: `that compact models can run locally` → `The idea that compact models can run locally`

### dev-10（カテゴリ: `coordination` / 難易度: 2）

> The parser splits long paragraphs and marks complex clauses automatically.

```text
[The parser] S
  splits V
  [long paragraphs] O
  and
  marks V
  [complex clauses] O
  <automatically>.
```

- **constructs**: `coordination`（並列）
- **modifies**: `automatically` → `marks`
