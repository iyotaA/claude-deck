/**
 * 起こすときの既定値。**紙（`config.json`）に置いて、設定画面から変えられるようにする。**
 *
 * 置き場所は `run.defaults`。同じ紙の `run.dirs`（起こしてよいフォルダ）の隣で、
 * 作法も `run/dirs.mjs` に揃えてある ―― 判断（純関数）と I/O（薄い殻）を分け、
 * 書き戻すときは**知らないキーを残す**（通知の設定が同じ紙に入っている）。
 *
 * 持つのは4つ。権限モード・モデル・思考量・予算。
 * どれも「起こすフォームの欄に最初から入る値」で、**それ以上の意味は持たせない。**
 * 実際に何で走るかを決めるのは `spec.mjs` の検証で、こちらが通した値も
 * 向こうでもう一度確かめられる（設定の紙は人が手で書き換えられる場所なので、
 * ここを通ったことを安全の根拠にしない）。
 *
 * **`null` は「指定なし」。** 語彙の外の値・範囲の外の数は、黙って `null` に倒す。
 * 紙が壊れていても起こせなくならないほうが大事で、そこは `parseRunDirs` と同じ判断。
 */
import { isPlainObject } from '../shared/objects.mjs';
import { readConfigFile, writeConfigFile } from '../shared/configfile.mjs';
import {
  PERMISSION_MODES,
  EFFORTS,
  BUDGET_MIN_USD,
  BUDGET_MAX_USD,
  checkModel,
} from './spec.mjs';

/**
 * 何も設定していないときの既定。**`spec.mjs` の既定とは別物。**
 *
 * あちらは「フォームが空で送られてきたときに倒す先」で、こちらは
 * 「フォームの欄に最初から入れておく値」。いまはどちらも同じ顔になるが、
 * 混ぜると設定で `plan` 以外を既定にした人の指定が、空送信のときだけ無視される。
 */
export const RUN_DEFAULTS_EMPTY = Object.freeze({
  permissionMode: null,
  model: null,
  effort: null,
  budgetUsd: null,
});

/**
 * 語彙の中の1語か確かめる。外れていれば `null`。
 *
 * @param {*} v 紙から来た値
 * @param {readonly string[]} vocab 許す語
 * @returns {string|null}
 */
function pick(v, vocab) {
  return typeof v === 'string' && vocab.includes(v) ? v : null;
}

/**
 * モデル名を確かめる。**判定は `spec.mjs` の `checkModel` に任せる。**
 *
 * ここで別の正規表現を書かない ―― 2箇所に持つと、片方だけ緩めた日に
 * 「設定には書けるのに起こすと断られる」が生まれる。
 * 違うのは断り方だけで、あちらは理由を返し、こちらは `null`（指定なし）へ倒す。
 *
 * **語彙では縛らない。** `/api/runs/options` の `models` は「実際に使われたモデル」を
 * 集めた候補であって許可リストではない（`recentModels` の説明を見よ）。
 * 縛ると、新しいモデルが出た日に設定へ書けなくなる。
 *
 * @param {*} v
 * @returns {string|null}
 */
function model(v) {
  const checked = checkModel(v);
  return checked.ok ? checked.model : null;
}

/**
 * 予算を確かめる。**範囲の外は `null`（＝上限なし）に倒さない。丸める。**
 *
 * 倒すと、$100 と書いた人の意図（上限を掛けたい）が「上限なし」に化ける。
 * 逆向きに間違えるほうが危ないので、`budgetUsd()` と同じく範囲へ収める。
 *
 * @param {*} v
 * @returns {number|null}
 */
function budget(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const clamped = Math.min(BUDGET_MAX_USD, Math.max(BUDGET_MIN_USD, n));
  // 浮動小数のごみを残さない（0.1+0.2 の類）
  return Math.round(clamped * 100) / 100;
}

/**
 * 紙から既定値を読む。純関数。**投げない。**
 *
 * `bypassPermissions` は**紙に書いてあっても読まない。**
 * あれは環境変数が立っているときだけ語彙に入るもので、
 * 紙に書けてしまうと「設定ファイルを1行足すだけで最も危険なモードが既定になる」
 * 道ができる。環境変数という関門を、紙で迂回させない。
 *
 * @param {*} file 読み込んだ config.json。無ければ null
 * @returns {{permissionMode: string|null, model: string|null, effort: string|null, budgetUsd: number|null}}
 */
export function parseRunDefaults(file) {
  const run = isPlainObject(file) && isPlainObject(file.run) ? file.run : {};
  const d = isPlainObject(run.defaults) ? run.defaults : {};
  return {
    // PERMISSION_MODES に BYPASS_MODE は入っていない。これがその関門
    permissionMode: pick(d.permissionMode, PERMISSION_MODES),
    model: model(d.model),
    effort: pick(d.effort, EFFORTS),
    budgetUsd: budget(d.budgetUsd),
  };
}

/**
 * 送られてきた指定を、いまの既定へ重ねる。純関数。
 *
 * **キーが無いものは触らない。** 画面は変えた欄だけを送れるし、
 * 版が違って知らないキーが来ても既存の設定を落とさない
 * （`notify/settings.mjs` の `mergeSettings` と同じ作法）。
 *
 * **`null` は「消す（指定なしへ戻す）」。** 空文字も同じ扱いにする ――
 * 画面の欄を空にしたときに来るのがそちらなので、両方を同じ意味にしないと
 * 「消したのに消えない」になる。
 *
 * @param {object} current いまの既定（`parseRunDefaults` の戻り）
 * @param {*} patch 画面から来た指定
 * @returns {object} 重ねたあとの既定
 */
export function applyRunDefaults(current, patch) {
  const src = isPlainObject(patch) ? patch : {};
  const next = { ...RUN_DEFAULTS_EMPTY, ...current };
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);

  if (has('permissionMode')) next.permissionMode = pick(src.permissionMode, PERMISSION_MODES);
  if (has('model')) next.model = model(src.model);
  if (has('effort')) next.effort = pick(src.effort, EFFORTS);
  if (has('budgetUsd')) next.budgetUsd = budget(src.budgetUsd);
  return next;
}

/**
 * 紙に書き戻す形を組む。純関数。
 *
 * **知らないキーは残す**（`mergeRunDirs` と同じ理由。同じ紙に通知の設定と
 * 起こしてよいフォルダが入っている）。
 *
 * **`null` の項目はキーごと落とす。** 残すと、紙を読んだ人が
 * 「わざわざ null を指定してある」と読めてしまう。指定なしは書かないことで表す。
 *
 * @param {*} file 読み込んだ config.json。無ければ null
 * @param {object} defaults 書き込む既定
 * @returns {object} 書き戻す全体
 */
export function mergeRunDefaults(file, defaults) {
  const base = isPlainObject(file) ? file : {};
  const run = isPlainObject(base.run) ? base.run : {};
  const kept = isPlainObject(run.defaults) ? run.defaults : {};

  // 知らないキーは既存のものを残したうえで、こちらが持つ4つだけ上から書く
  const next = { ...kept };
  for (const key of Object.keys(RUN_DEFAULTS_EMPTY)) {
    const v = defaults?.[key] ?? null;
    if (v === null) delete next[key];
    else next[key] = v;
  }

  // 4つとも指定なしなら、空のかたまりを紙に残さない
  if (Object.keys(next).length === 0) {
    const { defaults: _drop, ...restRun } = run;
    return { ...base, run: restRun };
  }
  return { ...base, run: { ...run, defaults: next } };
}

/**
 * 紙から既定値を読む。薄い殻。
 *
 * @param {object} [env] 環境変数
 * @returns {object}
 */
export function loadRunDefaults(env = process.env) {
  return parseRunDefaults(readConfigFile(env));
}

/**
 * 紙へ既定値を書く。薄い殻。
 *
 * **投げる。** 保存できなかったことは画面に出す必要がある
 * （`saveRunDirs` と同じ。人が入れた設定が黙って消えるのがいちばん困る）。
 *
 * @param {object} defaults 書き込む既定
 * @param {object} [env] 環境変数
 * @returns {string} 書いたファイルのパス
 */
export function saveRunDefaults(defaults, env = process.env) {
  return writeConfigFile(mergeRunDefaults(readConfigFile(env), defaults), env);
}
