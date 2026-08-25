/**
 * 枠の使用率を紙に1枚だけ落とす。
 *
 * この数の出どころは `rate_limit_event` ただ1つで、それが流れるのは
 * **この画面から起こした実行の stdout だけ**。会話ログにも `~/.claude` の下にも
 * 1件も無い（キーの形で総当たりして確認・claude 2.1.245）。
 * `claude` のサブコマンドにも数だけ取る口は無い（`usage` は存在しない）。
 *
 * 台帳はメモリなので、そのままだとサーバーを立て直すたびに数が消え、
 * 見るために毎回1本起こすことになる。だから最後に測った1件だけ紙にする。
 * これで「起こす」が要るのは**生涯で1回**になる。
 *
 * **`~/.claude` には書かない。** 置き場所は通知の設定と同じ appdata。
 *
 * ここは I/O だけを持つ。「どれが新しいか」「出してよいか」の判断は
 * 台帳（`ledger.mjs`）と画面（`public/js/runs.js` の `rateView`）が持つ。
 * `update/state.mjs` が `parseUpdateState`（判断）と `loadUpdateState`（I/O）を
 * 分けてあるのと同じ形にしてある。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

/**
 * 紙の置き場所。
 *
 * @param {object} [env] 環境変数。テストから差し替えられるように引数にしてある
 * @returns {string} 例: C:\Users\me\AppData\Local\ClaudeDeck\rate.json
 */
export function ratePath(env = process.env) {
  return appDataFile('rate.json', appRoot, env);
}

/**
 * 読んだ中身の形を確かめる。**判断はしないが、形だけは通す。**
 *
 * 紙は前の版が書いたものかもしれないし、途中で電源が落ちた残骸かもしれない。
 * 未知の形で落ちないように、読めない値は捨てて null に倒す。
 *
 * **`at`（測った時刻）が無いものは丸ごと捨てる。**
 * 何分前の数か言えないなら、それは古い数を今の数の顔で出すことになる。
 * 数だけ残して「いつのものか不明」で出す道は作らない（0 と不明を分ける）。
 *
 * @param {*} file JSON.parse の戻り
 * @returns {{fiveHour: ?number, sevenDay: ?number, resetsAt: ?number, at: number}|null}
 */
export function parseRate(file) {
  if (!file || typeof file !== 'object') return null;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const at = num(file.at);
  if (at === null) return null;

  const fiveHour = num(file.fiveHour);
  const sevenDay = num(file.sevenDay);
  if (fiveHour === null && sevenDay === null) return null;

  return { fiveHour, sevenDay, resetsAt: num(file.resetsAt), at };
}

/**
 * 紙を読む。無ければ・壊れていれば null。
 *
 * @param {object} [env] 環境変数
 * @returns {object|null} `parseRate` が通した形
 */
export function loadRate(env = process.env) {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(ratePath(env), 'utf8'));
  } catch {
    return null; // 無くてよい（まだ1本も起こしていないだけ）
  }
  return parseRate(file);
}

/**
 * 紙を書く。一時ファイルへ書いてから rename するので、途中で落ちても残骸にならない。
 *
 * **失敗しても投げない。** これは無くても本体が動く控えの紙で、
 * 書けないこと（フォルダが作れない・ディスクが一杯）を理由に
 * 実行そのものを止める筋合いが無い。
 *
 * @param {object} rl `{fiveHour, sevenDay, resetsAt, at}`
 * @param {object} [env] 環境変数
 * @returns {boolean} 書けたか
 */
export function saveRate(rl, env = process.env) {
  if (!rl || typeof rl.at !== 'number') return false;

  const target = ratePath(env);
  const tmp = `${target}.tmp`;
  const body = {
    fiveHour: rl.fiveHour ?? null,
    sevenDay: rl.sevenDay ?? null,
    resetsAt: rl.resetsAt ?? null,
    at: rl.at,
  };

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}
