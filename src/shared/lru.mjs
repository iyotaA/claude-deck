/**
 * 古いものから捨てる memo の器。
 *
 * `read/cache.mjs`（一覧・詳細のパース結果）と `view/usage.mjs`（集計結果）が
 * 同じ回し方を別々に書いていたので、器だけをここへ寄せた。
 *
 * **store は共有しない。** 呼ぶ側がそれぞれ `createLru()` を呼んで自分のものを持つ。
 * `view/usage.mjs` が `read/cache.mjs` を使わないのは
 * 「全文（1本で最大 42MB）を載せると一覧の memo が全部追い出される」からで、
 * 理由は器の共有ではなく**中身の同居**にある。器を1本にしてもその理由は残る。
 */

/**
 * 古いものから捨てる Map を作る。
 *
 * `Map` は挿入順を保つので、触ったものを末尾へ動かせば先頭が
 * 「いちばん長く触っていないもの」になる。
 *
 * @param {number} max 何件まで持つか
 * @returns {{get:Function, set:Function, clear:Function, size:Function}}
 */
export function createLru(max) {
  const store = new Map();

  return {
    /**
     * 取る。取れたものは末尾へ動かして「最近使った」印にする。
     *
     * @param {string} key
     * @returns {*} 無ければ undefined
     */
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },

    /**
     * 入れる。溢れたら、いちばん長く触っていないものから捨てる。
     *
     * `while` にしてあるのは、`max` を後から小さくした場合にも1回で収まるため。
     *
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
      store.delete(key);
      store.set(key, value);
      while (store.size > max) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },

    /** 空にする。 */
    clear() {
      store.clear();
    },

    /** いま何件持っているか。 */
    size() {
      return store.size;
    },
  };
}
