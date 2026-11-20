/**
 * クラウド Gemini API 送信直前の同意ガードおよびキャッシュ利用可否判定。
 * background.ts のすべてのクラウド呼び出し経路から共通利用する。
 */

import type { KaidokuSettings } from './settings';
import type { PageMarkCache } from './types';

export const CLOUD_CONSENT_REQUIRED_ERROR =
  '外部データ送信への同意が未完了、または同意内容が更新されました。同意画面（consent.html）から再度同意してください。';

/**
 * クラウド API へ送信する直前に同意状態を確認する。
 * 同意が未完了・撤回済み・旧バージョンの場合はエラーを投げて送信を阻止する。
 */
export function assertCloudConsentForCloudCall(
  settings: Pick<KaidokuSettings, 'cloudConsent'>,
  willUseCloud: boolean,
): void {
  if (willUseCloud && !settings.cloudConsent.granted) {
    throw new Error(CLOUD_CONSENT_REQUIRED_ERROR);
  }
}

/**
 * 保存済みのページ判定キャッシュを再利用できるか判定する。
 * API キー未設定時に保存されたルール簡易キャッシュ（provider === 'rule'）は、
 * ユーザーが後から API キーを登録した場合には再利用せずクラウド判定へ自動昇格させる。
 */
export function shouldUseCachedPageMarks(
  cached: PageMarkCache | null,
  hasApiKey: boolean,
): cached is PageMarkCache {
  if (!cached) return false;
  if (cached.provider === 'rule' && hasApiKey) {
    return false;
  }
  return true;
}
