import { describe, expect, it } from 'vitest';
import { normalizePageUrl } from '../src/db';
import { hashCandidateList, hashSentenceText } from '../src/lang/en/sentence-splitter';

describe('URL キャッシュキー正規化とハッシュ', () => {
  it('normalizePageUrl がハッシュフラグメントとトラッキングパラメータを除きクエリ順を正規化する', () => {
    const a = normalizePageUrl(
      'https://arxiv.org/html/2501.00001v1?utm_source=x&b=2&a=1#S2.SS1',
    );
    const b = normalizePageUrl(
      'https://arxiv.org/html/2501.00001v1?a=1&b=2&fbclid=abc#S3',
    );
    expect(a).toBe('https://arxiv.org/html/2501.00001v1?a=1&b=2');
    expect(a).toBe(b);
  });

  it('hashSentenceText と hashCandidateList が空白差を吸収し本文変更を検知できる', () => {
    expect(hashSentenceText('The   method works.')).toBe(
      hashSentenceText('The method works.'),
    );
    expect(hashCandidateList(['Sentence A.', 'Sentence B.'])).not.toBe(
      hashCandidateList(['Sentence A.', 'Sentence C.']),
    );
  });
});
