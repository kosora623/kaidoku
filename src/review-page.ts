import {
  deleteReviewCardAndEntry,
  getHydratedReviewCards,
  getLearningSummary,
  submitReviewAnswer,
  type HydratedReviewCard,
} from './db';
import { EN_CONSTRUCTS, getConstructLabelJa } from './lang/en/constructs';
import { renderNotationHtml } from './notation';
import {
  isCardDue,
  previewNextIntervalLabels,
  sortDueReviewQueue,
  type ReviewRating,
} from './review';
import { loadSettings } from './settings';

type FilterKind = 'all' | 'word' | 'construct';

const statDueTotal = document.getElementById('stat-due-total') as HTMLSpanElement;
const statDueBreakdown = document.getElementById('stat-due-breakdown') as HTMLSpanElement;
const statTotalCards = document.getElementById('stat-total-cards') as HTMLSpanElement;
const statTotalBreakdown = document.getElementById('stat-total-breakdown') as HTMLSpanElement;
const weakConstructsList = document.getElementById('weak-constructs-list') as HTMLDivElement;

const tabStudy = document.getElementById('tab-study') as HTMLButtonElement;
const tabLibrary = document.getElementById('tab-library') as HTMLButtonElement;
const viewStudy = document.getElementById('view-study') as HTMLElement;
const viewLibrary = document.getElementById('view-library') as HTMLElement;

const includeUpcomingCheckbox = document.getElementById('include-upcoming') as HTMLInputElement;
const sessionProgress = document.getElementById('session-progress') as HTMLSpanElement;
const studyStage = document.getElementById('study-stage') as HTMLDivElement;

const librarySearch = document.getElementById('library-search') as HTMLInputElement;
const libraryList = document.getElementById('library-list') as HTMLDivElement;
const devDebugLink = document.getElementById('dev-debug-link') as HTMLAnchorElement | null;

let allItems: HydratedReviewCard[] = [];
let studyFilter: FilterKind = 'all';
let libraryFilter: FilterKind = 'all';
let studyQueue: HydratedReviewCard[] = [];
let completedInSession = 0;
let isAnswerRevealed = false;
let isSubmittingAnswer = false;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 元文の中で対象単語をハイライト表示する HTML を組み立てる */
function highlightWordInSentence(sentence: string, word: string): string {
  const escapedWord = escapeRegExp(word.trim());
  if (!escapedWord) return escapeHtml(sentence);
  const regex = new RegExp(`\\b(${escapedWord})\\b`, 'gi');
  let result = '';
  let lastIndex = 0;
  for (const match of sentence.matchAll(regex)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      result += escapeHtml(sentence.slice(lastIndex, start));
    }
    result += `<mark class="target-word-mark">${escapeHtml(match[0])}</mark>`;
    lastIndex = start + match[0].length;
  }
  if (lastIndex < sentence.length) {
    result += escapeHtml(sentence.slice(lastIndex));
  }
  return result;
}

function formatDueLabel(dueAt: string, nowMs = Date.now()): string {
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs) || dueMs <= nowMs) {
    return '復習待ち';
  }
  const diffHours = Math.round((dueMs - nowMs) / (60 * 60 * 1000));
  if (diffHours < 24) {
    return `約 ${Math.max(1, diffHours)} 時間後`;
  }
  const d = new Date(dueMs);
  return `${d.getMonth() + 1}/${d.getDate()} 予定`;
}

function matchesKindFilter(item: HydratedReviewCard, filter: FilterKind): boolean {
  if (filter === 'all') return true;
  return item.kind === filter;
}

function rebuildStudyQueue(): void {
  const nowMs = Date.now();
  const filtered = allItems.filter((item) => matchesKindFilter(item, studyFilter));

  if (includeUpcomingCheckbox.checked) {
    studyQueue = [...filtered].sort((a, b) => {
      if (b.card.lapses !== a.card.lapses) {
        return b.card.lapses - a.card.lapses;
      }
      return (Date.parse(a.card.dueAt) || 0) - (Date.parse(b.card.dueAt) || 0);
    });
  } else {
    studyQueue = sortDueReviewQueue(filtered, nowMs);
  }

  isAnswerRevealed = false;
  renderStudyCard();
}

async function refreshSummaryAndData(rebuildQueue = true): Promise<void> {
  const nowMs = Date.now();
  const [summary, hydrated] = await Promise.all([
    getLearningSummary(nowMs),
    getHydratedReviewCards(),
  ]);
  allItems = hydrated;

  statDueTotal.textContent = String(summary.dueTotal);
  statDueBreakdown.textContent = `単語 ${summary.dueWords} / 構文 ${summary.dueConstructs}`;
  statTotalCards.textContent = String(summary.totalCards);
  statTotalBreakdown.textContent = `単語 ${summary.totalWordCards} / 構文 ${summary.totalConstructCards}`;

  weakConstructsList.innerHTML = '';
  if (summary.weakConstructs.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'まだ記録がありません';
    weakConstructsList.appendChild(empty);
  } else {
    for (const item of summary.weakConstructs.slice(0, 6)) {
      const pill = document.createElement('span');
      pill.className = 'weak-pill';
      pill.textContent = `${getConstructLabelJa(item.construct)} ×${item.count}`;
      weakConstructsList.appendChild(pill);
    }
  }

  if (rebuildQueue) {
    rebuildStudyQueue();
  }
  renderLibrary();
}

function renderStudyCard(): void {
  sessionProgress.textContent = `残り ${studyQueue.length} 枚 / 今回完了 ${completedInSession} 枚`;
  studyStage.innerHTML = '';

  if (studyQueue.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const hasAnyCards = allItems.some((item) => matchesKindFilter(item, studyFilter));
    empty.innerHTML = hasAnyCards
      ? `<h2>いま復習待ちのカードはありません</h2><p>期限が来るとここに表示されます。「期限前のカードも練習する」にチェックを入れると先取り復習もできます。</p>`
      : `<h2>まだ復習カードがありません</h2><p>英語記事や論文で難文をタップし、分からない単語を記録するか、構文パネルで「まだ怪しい」を押すとカードが追加されます。</p>`;
    studyStage.appendChild(empty);
    return;
  }

  const current = studyQueue[0];
  const cardEl = document.createElement('article');
  cardEl.className = 'flashcard';

  // メタ情報バッジ
  const metaRow = document.createElement('div');
  metaRow.className = 'card-meta-row';

  const kindBadge = document.createElement('span');
  kindBadge.className = `kind-badge kind-badge-${current.kind}`;
  kindBadge.textContent = current.kind === 'word' ? '単語カード' : '構文カード';
  metaRow.appendChild(kindBadge);

  if (current.kind === 'construct') {
    const hintBadge = document.createElement('span');
    hintBadge.className = 'hint-badge';
    hintBadge.textContent = `構文: ${getConstructLabelJa(current.constructEntry.construct)}`;
    metaRow.appendChild(hintBadge);
  }

  if (current.card.lapses > 0) {
    const lapsesBadge = document.createElement('span');
    lapsesBadge.className = 'lapses-badge';
    lapsesBadge.textContent = `間違い ${current.card.lapses}回`;
    metaRow.appendChild(lapsesBadge);
  }

  cardEl.appendChild(metaRow);

  // 表面：元の英文
  const promptEl = document.createElement('div');
  promptEl.className = 'sentence-prompt';
  if (current.kind === 'word') {
    promptEl.innerHTML = highlightWordInSentence(
      current.sentence.text,
      current.wordEntry.word,
    );
  } else {
    promptEl.textContent = current.sentence.text;
  }
  cardEl.appendChild(promptEl);

  const guide = document.createElement('p');
  guide.className = 'study-guide';
  guide.textContent =
    current.kind === 'word'
      ? `ハイライトされた単語「${current.wordEntry.word}」の、この文脈での意味を思い出しましょう。`
      : 'S・V・O・C と修飾のかたまりを頭の中で区切ってから、答えを確認しましょう。';
  cardEl.appendChild(guide);

  // 出典記事リンク
  const sourceRow = document.createElement('div');
  sourceRow.className = 'source-link-row';
  const sourceLabel = document.createTextNode('出典: ');
  const sourceLink = document.createElement('a');
  sourceLink.href = current.sentence.pageUrl;
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  sourceLink.textContent = current.sentence.pageTitle || current.sentence.pageUrl;
  sourceRow.appendChild(sourceLabel);
  sourceRow.appendChild(sourceLink);
  cardEl.appendChild(sourceRow);

  if (!isAnswerRevealed) {
    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'reveal-btn';
    revealBtn.textContent = '答えを見る';
    revealBtn.addEventListener('click', () => {
      isAnswerRevealed = true;
      renderStudyCard();
    });
    cardEl.appendChild(revealBtn);
  } else {
    const answerBox = document.createElement('div');
    answerBox.className = 'answer-box';

    if (current.kind === 'word') {
      const heading = document.createElement('div');
      heading.className = 'answer-word-heading';
      const wordSpan = document.createElement('span');
      wordSpan.className = 'answer-word';
      wordSpan.textContent = current.wordEntry.word;
      heading.appendChild(wordSpan);
      answerBox.appendChild(heading);

      const meaningEl = document.createElement('p');
      meaningEl.className = 'answer-meaning';
      meaningEl.textContent = current.wordEntry.meaning;
      answerBox.appendChild(meaningEl);

      if (current.sentence.analysis) {
        const details = document.createElement('details');
        details.className = 'notation-details';
        const summary = document.createElement('summary');
        summary.textContent = 'この文の英文解釈図解を表示';
        details.appendChild(summary);
        const box = document.createElement('div');
        box.className = 'notation-box';
        box.innerHTML = renderNotationHtml(
          current.sentence.text,
          current.sentence.analysis,
        );
        details.appendChild(box);
        answerBox.appendChild(details);
      }
    } else {
      if (current.sentence.analysis) {
        const box = document.createElement('div');
        box.className = 'notation-box';
        box.innerHTML = renderNotationHtml(
          current.sentence.text,
          current.sentence.analysis,
        );
        answerBox.appendChild(box);
      }

      const def = EN_CONSTRUCTS[current.constructEntry.construct];
      const explain = document.createElement('div');
      explain.className = 'construct-explain';
      const title = document.createElement('div');
      title.className = 'construct-explain-title';
      title.textContent = `${def.labelJa} (${current.constructEntry.construct})`;
      const body = document.createElement('p');
      body.className = 'construct-explain-body';
      body.textContent = def.explanationJa;
      explain.appendChild(title);
      explain.appendChild(body);
      answerBox.appendChild(explain);
    }

    // 3 段階評価ボタン
    const labels = previewNextIntervalLabels(current.card);
    const ratingRow = document.createElement('div');
    ratingRow.className = 'rating-row';

    const ratings: Array<{ key: ReviewRating; label: string; cls: string }> = [
      { key: 'again', label: '忘れた', cls: 'rating-btn rating-again' },
      { key: 'hard', label: '少し怪しい', cls: 'rating-btn rating-hard' },
      { key: 'good', label: '分かった', cls: 'rating-btn rating-good' },
    ];

    for (const r of ratings) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = r.cls;
      const mainLabel = document.createElement('span');
      mainLabel.textContent = r.label;
      const subLabel = document.createElement('span');
      subLabel.className = 'rating-sub';
      subLabel.textContent = labels[r.key];
      btn.appendChild(mainLabel);
      btn.appendChild(subLabel);

      btn.addEventListener('click', () => {
        void handleAnswer(current, r.key);
      });
      ratingRow.appendChild(btn);
    }

    answerBox.appendChild(ratingRow);
    cardEl.appendChild(answerBox);
  }

  studyStage.appendChild(cardEl);
}

async function handleAnswer(
  item: HydratedReviewCard,
  rating: ReviewRating,
): Promise<void> {
  if (isSubmittingAnswer) return;
  isSubmittingAnswer = true;
  for (const btn of studyStage.querySelectorAll<HTMLButtonElement>('.rating-btn')) {
    btn.disabled = true;
  }

  try {
    const updatedCard = await submitReviewAnswer(item.card.id, rating);

    // キューの先頭を取り出し、「忘れた」のときは同じセッションの末尾に再出題する
    studyQueue.shift();
    if (rating === 'again') {
      const updatedItem: HydratedReviewCard =
        item.kind === 'word'
          ? { ...item, card: updatedCard }
          : { ...item, card: updatedCard };
      studyQueue.push(updatedItem);
    } else {
      completedInSession += 1;
    }

    isAnswerRevealed = false;
    await refreshSummaryAndData(false);
    renderStudyCard();
  } finally {
    isSubmittingAnswer = false;
  }
}

function renderLibrary(): void {
  const query = librarySearch.value.trim().toLowerCase();
  const nowMs = Date.now();

  const filtered = allItems
    .filter((item) => matchesKindFilter(item, libraryFilter))
    .filter((item) => {
      if (!query) return true;
      const haystack = [
        item.sentence.text,
        item.sentence.pageTitle,
        item.sentence.pageUrl,
        item.kind === 'word'
          ? `${item.wordEntry.word} ${item.wordEntry.meaning}`
          : `${item.constructEntry.construct} ${getConstructLabelJa(item.constructEntry.construct)}`,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => {
      const dueA = isCardDue(a.card, nowMs) ? 0 : 1;
      const dueB = isCardDue(b.card, nowMs) ? 0 : 1;
      if (dueA !== dueB) return dueA - dueB;
      if (b.card.lapses !== a.card.lapses) return b.card.lapses - a.card.lapses;
      return (Date.parse(b.sentence.createdAt) || 0) - (Date.parse(a.sentence.createdAt) || 0);
    });

  libraryList.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<h2>該当する記録がありません</h2><p>検索条件を変えるか、記事を読みながら単語・構文を記録してください。</p>`;
    libraryList.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const row = document.createElement('article');
    row.className = 'library-item';

    const head = document.createElement('div');
    head.className = 'library-head';

    const left = document.createElement('div');
    left.className = 'library-head-left';

    const badge = document.createElement('span');
    badge.className = `kind-badge kind-badge-${item.kind}`;
    badge.textContent = item.kind === 'word' ? '単語' : '構文';
    left.appendChild(badge);

    const title = document.createElement('span');
    title.className = 'library-title';
    title.textContent =
      item.kind === 'word'
        ? item.wordEntry.word
        : getConstructLabelJa(item.constructEntry.construct);
    left.appendChild(title);

    if (item.kind === 'word') {
      const meaning = document.createElement('span');
      meaning.className = 'library-meaning';
      meaning.textContent = `— ${item.wordEntry.meaning}`;
      left.appendChild(meaning);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'delete-btn';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', () => {
      void deleteReviewCardAndEntry(item.card.id).then(() =>
        refreshSummaryAndData(true),
      );
    });

    head.appendChild(left);
    head.appendChild(delBtn);

    const sent = document.createElement('p');
    sent.className = 'library-sentence';
    if (item.kind === 'word') {
      sent.innerHTML = highlightWordInSentence(
        item.sentence.text,
        item.wordEntry.word,
      );
    } else {
      sent.textContent = item.sentence.text;
    }

    const foot = document.createElement('div');
    foot.className = 'library-foot';

    const sourceLink = document.createElement('a');
    sourceLink.href = item.sentence.pageUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = item.sentence.pageTitle || item.sentence.pageUrl;

    const status = document.createElement('span');
    status.textContent = `次回: ${formatDueLabel(item.card.dueAt, nowMs)} / 間隔: ${item.card.interval}日 / 間違い: ${item.card.lapses}回`;

    foot.appendChild(sourceLink);
    foot.appendChild(status);

    row.appendChild(head);
    row.appendChild(sent);
    row.appendChild(foot);
    libraryList.appendChild(row);
  }
}

// タブ切替
function switchTab(tab: 'study' | 'library'): void {
  const isStudy = tab === 'study';
  tabStudy.classList.toggle('is-active', isStudy);
  tabStudy.setAttribute('aria-selected', String(isStudy));
  tabLibrary.classList.toggle('is-active', !isStudy);
  tabLibrary.setAttribute('aria-selected', String(!isStudy));
  viewStudy.classList.toggle('hidden', !isStudy);
  viewLibrary.classList.toggle('hidden', isStudy);
}

tabStudy.addEventListener('click', () => switchTab('study'));
tabLibrary.addEventListener('click', () => switchTab('library'));

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-study-filter]')) {
  btn.addEventListener('click', () => {
    studyFilter = (btn.dataset.studyFilter as FilterKind) ?? 'all';
    for (const other of document.querySelectorAll('[data-study-filter]')) {
      other.classList.toggle('is-active', other === btn);
    }
    rebuildStudyQueue();
  });
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-lib-filter]')) {
  btn.addEventListener('click', () => {
    libraryFilter = (btn.dataset.libFilter as FilterKind) ?? 'all';
    for (const other of document.querySelectorAll('[data-lib-filter]')) {
      other.classList.toggle('is-active', other === btn);
    }
    renderLibrary();
  });
}

includeUpcomingCheckbox.addEventListener('change', () => rebuildStudyQueue());
librarySearch.addEventListener('input', () => renderLibrary());

void (async () => {
  const settings = await loadSettings();
  if (devDebugLink) {
    devDebugLink.classList.toggle('hidden', !settings.developerMode);
  }
})();
void refreshSummaryAndData(true);
