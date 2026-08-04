/**
 * 表示用に文字列を詰める道具。
 *
 * もとは sessions.mjs・digest.mjs・summary.mjs の3箇所に同じ処理があった。
 * 切り方が1文字ずれると一覧と詳細で表示が食い違うので、1本にまとめている。
 *
 * どちらも非文字列を渡されたら null を返す。
 * 読んでいるのは Claude Code の内部データで、想定した型が来るとは限らないため。
 * 呼ぶ側で型を確かめずに渡してよい形にしてある。
 */

/**
 * 空白と改行を潰して1行にする。長ければ末尾を … にする。
 *
 * @param {*} text 詰めたい値
 * @param {number} max 最大の長さ（… を含む）
 * @returns {string|null} 中身が無ければ null
 */
export function oneLine(text, max = 160) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 改行を保ったまま切る。長ければ「…（以下省略）」を付ける。
 *
 * 指示やプランの本文のように、行の形そのものが情報になるものに使う。
 *
 * @param {*} text 切りたい値
 * @param {number} max 最大の長さ（末尾の断り書きは含まない）
 * @returns {string|null} 中身が無ければ null
 */
export function clip(text, max) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…（以下省略）` : t;
}
