/**
 * 画面から来た通知の設定を、検証して config.json へ書く。
 *
 * このアプリで唯一、利用者の入力を受けてディスクへ書く場所。
 * なので判断（validateSettings / mergeSettings）と書き込み（writeSettings）を
 * はっきり分け、判断のほうは純関数にしてテストで全分岐を通す。
 *
 * 書く先は %LOCALAPPDATA%\ClaudeDeck\config.json だけ。
 * ~/.claude 配下へは何があっても書かない。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED,
  MAX_IDLE_MIN,
  MAX_REMIND_MIN,
  MAX_SETTLE_SEC,
  notifyConfigPath,
} from './config.mjs';
import { NOTIFY_STATES } from './watch.mjs';

/**
 * 数値の項目。名前・上限・単位のラベルをここ1箇所で持つ。
 *
 * 画面とサーバーで別々に上限を書くと、必ず片方が古くなる。
 */
const NUMBERS = [
  { key: 'settleSec', max: MAX_SETTLE_SEC, label: '落ち着き待ち（秒）' },
  { key: 'idleMin', max: MAX_IDLE_MIN, label: '返信待ち（分）' },
  { key: 'remindMin', max: MAX_REMIND_MIN, label: 'リマインド（分）' },
];

/**
 * 画面から来た本文を検証し、config.json へ入れる形に整える。純関数。
 *
 * キーが無い項目は触らない。「変えない」を、値を送らないことで表せる。
 * slackWebhookUrl だけ扱いが違い、空文字が「消す」の意味になる。
 * これで `****` のような偽の値を画面に置かずに済む
 * （置くと、それをそのまま保存して URL を壊す事故が起きる）。
 *
 * @param {*} body 受け取った JSON
 * @returns {{ok: true, patch: object}|{ok: false, error: string}}
 */
export function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '設定の形が違います' };
  }

  const patch = {};

  if ('slackWebhookUrl' in body) {
    const raw = body.slackWebhookUrl;
    if (raw === null || raw === '') {
      // 明示的に消す。「消す」ボタンだけがここへ来る
      patch.slackWebhookUrl = '';
    } else if (typeof raw !== 'string') {
      return { ok: false, error: 'Webhook の URL が文字列ではありません' };
    } else {
      const url = raw.trim();
      if (!ALLOWED.test(url)) {
        // 弾いた URL は返さない。別サービスの鍵を貼り間違えている可能性がある
        return { ok: false, error: 'Webhook の URL が https://hooks.slack.com/ で始まっていません' };
      }
      patch.slackWebhookUrl = url;
    }
  }

  for (const { key, max, label } of NUMBERS) {
    if (!(key in body)) continue;
    const raw = body[key];
    // 型を先に絞る。Number(null) と Number([]) は 0 になるので、
    // 素直に通すと「0 を設定した」ことにされてしまう
    const numeric = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
    const n = numeric ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${label}は 0 以上の数で入れてください` };
    }
    if (n > max) {
      return { ok: false, error: `${label}は ${max} までです` };
    }
    // 小数を入れられても困らないよう丸める。秒・分の単位に端数の意味は無い
    patch[key] = Math.round(n);
  }

  if ('detail' in body) {
    const d = String(body.detail ?? '').trim().toLowerCase();
    if (d !== 'full' && d !== 'none') {
      return { ok: false, error: '質問文の扱いは full か none です' };
    }
    patch.detail = d;
  }

  if ('states' in body) {
    const raw = body.states;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '通知する状態の形が違います' };
    }
    const states = {};
    for (const [key, value] of Object.entries(raw)) {
      // 知らないキーは黙って落とす。増えた状態を古い画面が消してしまわないように、
      // 逆に消えた状態が残り続けないように、どちらもここで断ち切る
      if (!NOTIFY_STATES.has(key)) continue;
      if (typeof value !== 'boolean') {
        return { ok: false, error: '通知する状態は true か false で入れてください' };
      }
      states[key] = value;
    }
    patch.states = states;
  }

  return { ok: true, patch };
}

/**
 * いまの config.json に、検証済みの差分を重ねる。純関数。
 *
 * 知らないキーは残す。config.json はこの機能だけのものではないため。
 * notify の中も同じで、触っていない項目は元のまま持ち越す。
 *
 * @param {*} file 読み込んだ config.json。無ければ null
 * @param {object} patch validateSettings が返した差分
 * @returns {object} 書き戻す全体
 */
export function mergeSettings(file, patch) {
  const base = file && typeof file === 'object' && !Array.isArray(file) ? file : {};
  const notify = base.notify && typeof base.notify === 'object' && !Array.isArray(base.notify)
    ? base.notify : {};

  const next = { ...notify, ...patch };

  // states は上書きではなく重ねる。画面が一部だけ送ってきても、
  // 送られなかった状態の設定が消えないようにする
  if (patch.states) next.states = { ...(notify.states ?? {}), ...patch.states };

  // 空文字は「消す」の意味なので、キーごと落とす。
  // 残すと、環境変数の初期値まで空文字に負けて効かなくなる
  if (next.slackWebhookUrl === '') delete next.slackWebhookUrl;

  return { ...base, notify: next };
}

/**
 * 検証済みの差分を config.json へ書く。薄い殻。
 *
 * 一時ファイルへ書いてから rename する。途中で落ちても壊れたファイルを残さない。
 * フォルダはここで作る（appdata.mjs は場所を決めるだけ、を守る）。
 *
 * @param {object} patch validateSettings が返した差分
 * @param {object} [env] 環境変数
 * @returns {string} 書いたファイルのパス
 */
export function writeSettings(patch, env = process.env) {
  const target = notifyConfigPath(env);

  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    // 無くてよい。壊れていたら作り直す（読めない設定を残しても誰も得しない）
  }

  const next = mergeSettings(file, patch);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);

  return target;
}
