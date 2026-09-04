/**
 * 形の見張り。
 *
 * 読んでいるのは Claude Code の内部データで、公開された仕様が無い。
 * 「オブジェクトのはずの場所に配列や null が来る」を前提にした防御が要る。
 */

/**
 * プレーンなオブジェクトか。**配列と null を弾く。**
 *
 * `typeof null === 'object'` なので素の typeof では足りず、
 * 配列も object なので `Array.isArray` も要る。
 * この3つが揃った式が 18 箇所に散っていたのでここへ寄せた。
 *
 * **`Object.getPrototypeOf` までは見ない。** ここで欲しいのは
 * 「`x.foo` と書いて安全か」であって、素性の証明ではない。
 * `JSON.parse` が返すものしか通らない場所なので、これで足りる。
 *
 * @param {*} v 何か
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
