/**
 * ファイルの内容をキーにした memo。
 *
 * 会話ログは追記しか起きないので、サイズと mtime が変わっていなければ
 * 前回のパース結果をそのまま使える。一覧を毎秒引いても重くならないための土台。
 *
 * **ここに全文を載せない。** 240 件しか持たないので、大きいログの中身で埋めると
 * 一覧が使う tail の memo が全部押し出される。集計は `view/usage.mjs` が
 * 自分の器（同じ `createLru`）を持っている。
 */
import { createLru } from '../shared/lru.mjs';

const MAX_ENTRIES = 240;
const store = createLru(MAX_ENTRIES);

/**
 * stamp が前回と同じなら compute を呼ばずに前回の値を返す。
 *
 * @param {string} key 何のキャッシュか（ファイルパス＋用途）
 * @param {string} stamp 内容が変わったかを表す印（サイズと mtime を連結したもの）
 * @param {() => Promise<any>} compute 値の作り方
 */
export async function memo(key, stamp, compute) {
  const hit = store.get(key);
  if (hit && hit.stamp === stamp) return hit.value;

  const value = await compute();
  store.set(key, { stamp, value });
  return value;
}

/** stat の結果から印を作る。 */
export function stampOf(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

/** memo を空にする。テストと、印が当てにならなくなったときのため。 */
export function clearCache() {
  store.clear();
}
