/**
 * 通知の設定を読む。
 *
 * 画面から保存した値（%LOCALAPPDATA%\ClaudeDeck\config.json）を優先し、
 * 無ければ環境変数を見る。環境変数は「まだ画面で設定していないとき」の初期値。
 *
 * 順番はここだけで決まる。
 *
 *   画面（config.json） > 環境変数 > 既定
 *
 * 反転したことで、環境変数から通知を止める手段が無くなった。
 * config.json に URL が入っている限り、環境変数を空にしても止まらないため。
 * そこで止めるためだけの環境変数を1本置いてある。
 *
 *   CLAUDE_DECK_NOTIFY_OFF=1   何より強い。全部止める
 *
 * 規則を1行で言うと、環境変数は値を上書きできないが、機能ごと止めることはできる。
 *
 * 読むのは起動時と、画面から保存されたときだけ。毎秒の経路では読まない。
 * 設定が無いときは黙って無効になる。エラーも警告も出さない。
 * view/summary.mjs の「鍵が無ければ黙って素の要約に戻す」と同じ扱い。
 *
 * 判断（parseNotifyConfig）と読み取り（loadNotifyConfig）を分けてある。
 * 前者が純関数なので、優先順と URL 検証だけをテストできる。
 */
import { configFilePath, readConfigFile } from '../shared/configfile.mjs';
import { isSwitchOn } from '../shared/env.mjs';
import { maskWebhook } from './message.mjs';
import { normalizeStates } from './watch.mjs';

/** 送り先はここに固定する。タイポで別のホストへ業務内容を POST する事故を機能で防ぐ。 */
export const ALLOWED = /^https:\/\/hooks\.slack\.com\//;

/** 落ち着き待ちの既定（秒）。 */
export const DEFAULT_SETTLE_SEC = 6;

/** 落ち着き待ちの上限（秒）。これ以上は設定ミスと見なして丸める。 */
export const MAX_SETTLE_SEC = 600;

/**
 * 返信待ちの落ち着き待ちの既定（分）。
 *
 * 質問待ちは Claude Code が質問中の行をディスクに書かないため観測できない。
 * 実際に鳴るのはこちらなので、既定を無効にしてしまうと通知が丸ごと効かなくなる。
 */
export const DEFAULT_IDLE_MIN = 2;

/** 返信待ちの落ち着き待ちの上限（分）。 */
export const MAX_IDLE_MIN = 1440;

/** 放置リマインドの上限（分）。 */
export const MAX_REMIND_MIN = 1440;

/**
 * 文字列として使える値だけを取り出す。前後の空白は落とす。
 *
 * @param {*} v 元の値
 * @returns {string} 使えなければ空文字
 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 0 以上の数として使える値だけを取り出す。
 *
 * 空文字は「無い」として飛ばす。`set X=` のように空で立っていることがあり、
 * Number('') は 0 になるので、素直に通すと 0 を設定したことになってしまう。
 *
 * @param {*} v 元の値
 * @returns {number|null} 使えなければ null
 */
function usableNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 画面の値を先に見て、次に環境変数を見る。
 *
 * どちらから来たかを一緒に返すのは、モーダルで
 * 「環境変数も立っていますが、画面の値を使っています」と書き分けるため。
 * 黙って勝つと「設定したのに効かない」と同じ迷い方になる。
 *
 * @param {*} fileVal config.json の値
 * @param {*} envVal 環境変数の値
 * @returns {{value: number|null, source: 'config'|'env'|'none'}}
 */
function pickNumber(fileVal, envVal) {
  const f = usableNumber(fileVal);
  if (f !== null) return { value: f, source: 'config' };
  const e = usableNumber(envVal);
  if (e !== null) return { value: e, source: 'env' };
  return { value: null, source: 'none' };
}

/**
 * 値を範囲に丸める。
 *
 * @param {number} n 元の値
 * @param {number} min 下限
 * @param {number} max 上限
 * @returns {number}
 */
function clampNum(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * 環境変数と設定ファイルから、通知の設定を組み立てる。純関数。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 環境変数
 * @param {object|null} [opts.file] config.json をパースしたもの。読めなければ null
 * @param {string|null} [opts.configPath] 設定ファイルの置き場所。人に見せる用
 * @returns {object} enabled / url / urlMasked / source / settleMs / idleSettleMs /
 *                   remindMs / detail / states / sources / envSet / off / configPath / error
 */
export function parseNotifyConfig({ env = {}, file = null, configPath = null } = {}) {
  const notify = (file && typeof file.notify === 'object' && file.notify) || {};

  const fromEnv = str(env.CLAUDE_DECK_SLACK_WEBHOOK);
  const fromFile = str(notify.slackWebhookUrl);
  const url = fromFile || fromEnv || null;
  const webhookSource = fromFile ? 'config' : (fromEnv ? 'env' : 'none');

  const settle = pickNumber(notify.settleSec, env.CLAUDE_DECK_NOTIFY_SETTLE);
  const remind = pickNumber(notify.remindMin, env.CLAUDE_DECK_NOTIFY_REMIND);
  const idle = pickNumber(notify.idleMin, env.CLAUDE_DECK_NOTIFY_IDLE);

  const settleSec = clampNum(settle.value ?? DEFAULT_SETTLE_SEC, 0, MAX_SETTLE_SEC);
  const remindMin = clampNum(remind.value ?? 0, 0, MAX_REMIND_MIN);
  const idleMin = clampNum(idle.value ?? DEFAULT_IDLE_MIN, 0, MAX_IDLE_MIN);

  // 知らない値は full に倒す。none だけを特別扱いする
  const fileDetail = str(notify.detail);
  const envDetail = str(env.CLAUDE_DECK_NOTIFY_DETAIL);
  const rawDetail = fileDetail || envDetail || 'full';
  const detail = rawDetail.toLowerCase() === 'none' ? 'none' : 'full';
  const detailSource = fileDetail ? 'config' : (envDetail ? 'env' : 'none');

  // 止めるスイッチ。環境変数だけに置く（画面から自分を締め出せてしまうため）。
  // 値の書き方は他のスイッチと共通なので shared/env.mjs に寄せてある
  const off = isSwitchOn(env.CLAUDE_DECK_NOTIFY_OFF);

  const base = {
    source: webhookSource,
    settleMs: settleSec * 1000,
    idleSettleMs: idleMin * 60 * 1000,
    remindMs: remindMin * 60 * 1000,
    detail,
    // どの状態を送るかは画面と config.json だけで決める。
    // 組み合わせを文字列で表す環境変数は、書き間違えても気づけない
    states: normalizeStates(notify.states),
    sources: {
      webhook: webhookSource,
      settle: settle.source,
      idle: idle.source,
      remind: remind.source,
      detail: detailSource,
    },
    // 立っている環境変数。画面の値に負けているものを知らせるために持つ
    envSet: {
      webhook: fromEnv !== '',
      settle: usableNumber(env.CLAUDE_DECK_NOTIFY_SETTLE) !== null,
      idle: usableNumber(env.CLAUDE_DECK_NOTIFY_IDLE) !== null,
      remind: usableNumber(env.CLAUDE_DECK_NOTIFY_REMIND) !== null,
      detail: envDetail !== '',
    },
    off,
    configPath,
  };

  if (!url) return { ...base, enabled: false, url: null, urlMasked: null, error: null };

  if (!ALLOWED.test(url)) {
    // 弾いた URL そのものは返さない。別サービスの鍵が入っている可能性がある
    return {
      ...base,
      enabled: false,
      url: null,
      urlMasked: null,
      error: 'Webhook の URL が https://hooks.slack.com/ で始まっていません',
    };
  }

  // 止められているときは url を持たせない。持たせると送れてしまう。
  // urlMasked は残す。モーダルで「何が保存されているか」は見せてよい
  if (off) {
    return {
      ...base,
      enabled: false,
      url: null,
      urlMasked: maskWebhook(url),
      error: '環境変数 CLAUDE_DECK_NOTIFY_OFF で止めています',
    };
  }

  return { ...base, enabled: true, url, urlMasked: maskWebhook(url), error: null };
}

/**
 * 設定ファイルを1回だけ読んで、parseNotifyConfig に渡す薄い殻。
 *
 * @param {object} [env] 環境変数
 * @returns {object} parseNotifyConfig の戻り
 */
export function loadNotifyConfig(env = process.env) {
  // 無くてよい。壊れていても黙って無視する（設定なし＝通知しない、で困らない）。
  // 読めなかったときに null が返るのは shared/configfile.mjs の約束
  return parseNotifyConfig({ env, file: readConfigFile(env), configPath: notifyConfigPath(env) });
}

/**
 * 設定ファイルの置き場所。診断のときに人へ見せる。
 *
 * 実体は `shared/configfile.mjs`。**口はここに残す。**
 * 通知の側から見える名前を消すと、呼んでいる場所を全部書き換えることになる。
 *
 * @param {object} [env] 環境変数
 * @returns {string}
 */
export function notifyConfigPath(env = process.env) {
  return configFilePath(env);
}
