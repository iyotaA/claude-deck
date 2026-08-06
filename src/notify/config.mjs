/**
 * 通知の設定を読む。
 *
 * 環境変数を優先し、無ければ %LOCALAPPDATA%\ClaudeDeck\config.json を読む。
 * 起動時に1回だけ。再読み込みはしない（毎秒の経路で fs を叩かないため）。
 * 変えたら再起動してもらう。
 *
 * 設定が無いときは黙って無効になる。エラーも警告も出さない。
 * view/summary.mjs の「鍵が無ければ黙って素の要約に戻す」と同じ扱い。
 *
 * 判断（parseNotifyConfig）と読み取り（loadNotifyConfig）を分けてある。
 * 前者が純関数なので、優先順と URL 検証だけをテストできる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';
import { maskWebhook } from './message.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの控え。アプリ直下に置く */
const appRoot = path.resolve(here, '..', '..');

/** 送り先はここに固定する。タイポで別のホストへ業務内容を POST する事故を機能で防ぐ。 */
const ALLOWED = /^https:\/\/hooks\.slack\.com\//;

/** 落ち着き待ちの既定（秒）。 */
const DEFAULT_SETTLE_SEC = 6;

/** 落ち着き待ちの上限（秒）。これ以上は設定ミスと見なして丸める。 */
const MAX_SETTLE_SEC = 600;

/**
 * 返信待ちの落ち着き待ちの既定（分）。
 *
 * 質問待ちは Claude Code が質問中の行をディスクに書かないため観測できない。
 * 実際に鳴るのはこちらなので、既定を無効にしてしまうと通知が丸ごと効かなくなる。
 */
const DEFAULT_IDLE_MIN = 2;

/** 返信待ちの落ち着き待ちの上限（分）。 */
const MAX_IDLE_MIN = 1440;

/** 放置リマインドの上限（分）。 */
const MAX_REMIND_MIN = 1440;

/**
 * 候補を順に見て、最初に見つかった 0 以上の数を返す。
 *
 * 空文字は「無い」として飛ばす。`set X=` のように空で立っていることがあり、
 * Number('') は 0 になるので、素直に通すと 0 を設定したことになってしまう。
 *
 * @param {...*} candidates 環境変数・設定ファイルの順で渡す
 * @returns {number|null} どれも使えなければ null
 */
function firstNumber(...candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
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
 * @returns {object} enabled / url / urlMasked / source / settleMs / idleSettleMs / remindMs / detail / error
 */
export function parseNotifyConfig({ env = {}, file = null } = {}) {
  const notify = (file && typeof file.notify === 'object' && file.notify) || {};

  const fromEnv = typeof env.CLAUDE_DECK_SLACK_WEBHOOK === 'string'
    ? env.CLAUDE_DECK_SLACK_WEBHOOK.trim() : '';
  const fromFile = typeof notify.slackWebhookUrl === 'string'
    ? notify.slackWebhookUrl.trim() : '';

  const url = fromEnv || fromFile || null;
  const source = fromEnv ? 'env' : (fromFile ? 'config' : 'none');

  const settleSec = clampNum(
    firstNumber(env.CLAUDE_DECK_NOTIFY_SETTLE, notify.settleSec) ?? DEFAULT_SETTLE_SEC,
    0,
    MAX_SETTLE_SEC,
  );
  const remindMin = clampNum(
    firstNumber(env.CLAUDE_DECK_NOTIFY_REMIND, notify.remindMin) ?? 0,
    0,
    MAX_REMIND_MIN,
  );
  const idleMin = clampNum(
    firstNumber(env.CLAUDE_DECK_NOTIFY_IDLE, notify.idleMin) ?? DEFAULT_IDLE_MIN,
    0,
    MAX_IDLE_MIN,
  );

  // 知らない値は full に倒す。none だけを特別扱いする
  const rawDetail = env.CLAUDE_DECK_NOTIFY_DETAIL || notify.detail || 'full';
  const detail = String(rawDetail).trim().toLowerCase() === 'none' ? 'none' : 'full';

  const base = {
    source,
    settleMs: settleSec * 1000,
    idleSettleMs: idleMin * 60 * 1000,
    remindMs: remindMin * 60 * 1000,
    detail,
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

  return { ...base, enabled: true, url, urlMasked: maskWebhook(url), error: null };
}

/**
 * 設定ファイルを1回だけ読んで、parseNotifyConfig に渡す薄い殻。
 *
 * @param {object} [env] 環境変数
 * @returns {object} parseNotifyConfig の戻り
 */
export function loadNotifyConfig(env = process.env) {
  let file = null;
  try {
    const p = appDataFile('config.json', appRoot, env);
    file = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // 無くてよい。壊れていても黙って無視する（設定なし＝通知しない、で困らない）
  }
  return parseNotifyConfig({ env, file });
}

/**
 * 設定ファイルの置き場所。診断のときに人へ見せる。
 *
 * @param {object} [env] 環境変数
 * @returns {string}
 */
export function notifyConfigPath(env = process.env) {
  return appDataFile('config.json', appRoot, env);
}
