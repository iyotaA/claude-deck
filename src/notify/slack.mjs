/**
 * Slack へ投げる薄い殻。
 *
 * 送るのは { text } の素の mrkdwn 1本。Block Kit は使わない。
 * Block Kit にすると通知プレビュー用の text を別に持つことになり、
 * 同じ文言を2箇所で直すはめになるため。
 *
 * 応答の意味づけ（classifyResponse）だけを純関数として切り出してテストする。
 * 実際の POST はテストしない。read/ の薄い殻と同じ割り切り。
 */
import { errText, oneLine } from '../shared/text.mjs';
import { scrubError } from './message.mjs';

/** 送信のタイムアウト。server.mjs の 1500ms は localhost 向けで、社外 HTTPS には短い。 */
export const TIMEOUT_MS = 5000;

/**
 * 応答から「次にどうするか」を決める。純関数。
 *
 * @param {number} status HTTP のステータス
 * @param {string} [body] 本文。Slack は ok / invalid_payload などの短い語を返す
 * @returns {object} ok（成功） / retry（再送する） / stop（機能ごと止める） / reason
 */
export function classifyResponse(status, body = '') {
  const detail = oneLine(body, 80);

  if (status >= 200 && status < 300) {
    return { ok: true, retry: false, stop: false, reason: null };
  }

  // Slack がこれを返すのは Webhook が削除・無効化されたときだけ。繰り返す意味がない
  if (status === 404 || status === 410) {
    return {
      ok: false,
      retry: false,
      stop: true,
      reason: 'Webhook が見つかりません。削除されたか URL が違います',
    };
  }

  // 設定が間違っている。何度投げても同じなので機能ごと止める
  if (status === 401 || status === 403) {
    return {
      ok: false,
      retry: false,
      stop: true,
      reason: `Slack に断られました（${status}${detail ? ` ${detail}` : ''}）`,
    };
  }

  // 本文の組み立てがおかしい。こちらのバグなので再送しないが、
  // 1通だけの問題かもしれないので機能は止めない
  if (status === 400) {
    return {
      ok: false,
      retry: false,
      stop: false,
      reason: `本文を受け付けてもらえませんでした（400${detail ? ` ${detail}` : ''}）`,
    };
  }

  if (status === 429) {
    return { ok: false, retry: true, stop: false, reason: 'Slack から送りすぎと言われました（429）' };
  }

  if (status >= 500) {
    return { ok: false, retry: true, stop: false, reason: `Slack 側が不調です（${status}）` };
  }

  return { ok: false, retry: false, stop: false, reason: `想定外の応答です（${status}）` };
}

/**
 * Slack へ1通投げる。
 *
 * 例外は投げない。失敗も戻り値で返す。通知は一覧より格下なので、
 * ここから上へ例外が漏れて本体が落ちることがあってはいけない。
 *
 * reason は必ず scrubError を通してから返す。fetch の失敗メッセージには
 * URL がそのまま埋め込まれ得るので、呼ぶ側に伏せ忘れの余地を残さない。
 *
 * @param {string} url Webhook の URL
 * @param {string} text 本文
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] タイムアウト
 * @param {Function} [opts.fetchImpl] テストから差し替えるための口
 * @returns {Promise<object>} classifyResponse と同じ形
 */
export async function postToSlack(url, text, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    const verdict = classifyResponse(res.status, body);
    return { ...verdict, reason: verdict.reason ? scrubError(verdict.reason, url) : null };
  } catch (err) {
    // Node の fetch は HTTPS_PROXY を見ない。プロキシ環境ではここに来るので、
    // 気づけるように一言添える（依存を増やせない以上、対応はできない）
    const raw = err?.name === 'TimeoutError'
      ? `${timeoutMs}ms 以内に応答がありませんでした`
      : `送信できませんでした: ${errText(err)}`;
    return {
      ok: false,
      retry: true,
      stop: false,
      reason: `${scrubError(raw, url)}（プロキシ環境では届きません）`,
    };
  }
}
