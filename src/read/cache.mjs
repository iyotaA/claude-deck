/**
 * ファイルの内容をキーにした memo。
 *
 * 会話ログは追記しか起きないので、サイズと mtime が変わっていなければ
 * 前回のパース結果をそのまま使える。一覧を毎秒引いても重くならないための土台。
 */

const MAX_ENTRIES = 240;
const store = new Map();

/**
 * stamp が前回と同じなら compute を呼ばずに前回の値を返す。
 *
 * @param {string} key 何のキャッシュか（ファイルパス＋用途）
 * @param {string} stamp 内容が変わったかを表す印（サイズと mtime を連結したもの）
 * @param {() => Promise<any>} compute 値の作り方
 */
export async function memo(key, stamp, compute) {
  const hit = store.get(key);
  if (hit && hit.stamp === stamp) {
    // 参照されたものを末尾へ動かし、古いものから捨てられるようにする
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }

  const value = await compute();
  store.set(key, { stamp, value });

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }

  return value;
}

/** stat の結果から印を作る。 */
export function stampOf(stat) {
  return `${stat.size}:${stat.mtimeMs}`;
}

export function clearCache() {
  store.clear();
}
