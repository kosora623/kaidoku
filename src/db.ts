import Dexie, { type EntityTable } from 'dexie';
import type {
  ConstructEntry,
  ReviewCard,
  SourceSentence,
  WordEntry,
} from './types';

/**
 * χ読のローカル IndexedDB（Dexie）スキーマ
 * すべての学習データは手元のブラウザにのみ保存する。
 */
export class KaidokuDatabase extends Dexie {
  sentences!: EntityTable<SourceSentence, 'id'>;
  words!: EntityTable<WordEntry, 'id'>;
  constructs!: EntityTable<ConstructEntry, 'id'>;
  reviewCards!: EntityTable<ReviewCard, 'id'>;

  constructor(name = 'kaidoku') {
    super(name);
    this.version(1).stores({
      sentences: 'id, pageUrl, lang, createdAt',
      words: 'id, word, sentenceId',
      constructs: 'id, construct, sentenceId, result',
      reviewCards: 'id, kind, refId, dueAt',
    });
  }
}

export const db = new KaidokuDatabase();
