/**
 * クエリ文字列を、丸めた形の指定に直す小道具。
 *
 * 書庫（`archive.mjs`）と数値（`usage.mjs`）が同じものを別々に持っていた。
 * 片方だけ上限を変えると、同じ `?days=` が窓口によって違う意味になる。
 *
 * **変な値で 400 を返さない。** URL を手で書き換えて壊れるより、
 * 黙って既定へ丸めるほうが親切。これはこのアプリ全体の方針
 * （未知の形で落ちない）を、入力の側にも当てたもの。
 *
 * fs を触らないのでそのままテストできる。
 */

/** 文字列のパラメータの上限。長すぎる値は意味を持たないので頭だけ見る。 */
export const TEXT_MAX = 200;

/** 1日のミリ秒。`?days=` の換算に使う。 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 数値のパラメータを範囲に収める。
 *
 * @param {string|null} raw クエリの生の値
 * @param {*} fallback 取れなかったときの値
 * @param {number} min 下限
 * @param {number} max 上限
 * @returns {*} 丸めた数、または fallback
 */
export function intOf(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 文字列のパラメータ。空白だけなら null にする（「指定なし」と同じ扱い）。
 *
 * @param {*} raw クエリの生の値
 * @returns {string|null}
 */
export function textOf(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  return t.slice(0, TEXT_MAX);
}

/**
 * `params.get` を安全に呼ぶ関数を作る。
 *
 * `URLSearchParams` が来ない場合（テストからの手渡しや、
 * 窓口の組み替えで null が入る場合）でも落とさず null を返す。
 *
 * @param {URLSearchParams|null} params
 * @returns {(key: string) => string|null}
 */
export function getter(params) {
  return (key) => (params && typeof params.get === 'function' ? params.get(key) : null);
}
