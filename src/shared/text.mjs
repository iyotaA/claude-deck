/**
 * 文字列の小道具。
 *
 * `oneLine` と `clip` はもとは sessions.mjs・digest.mjs・summary.mjs の3箇所に
 * 同じ処理があった。切り方が1文字ずれると一覧と詳細で表示が食い違うので、1本にまとめている。
 *
 * この2つは非文字列を渡されたら null を返す。
 * 読んでいるのは Claude Code の内部データで、想定した型が来るとは限らないため。
 * 呼ぶ側で型を確かめずに渡してよい形にしてある。
 *
 * **`os/` からは呼ばない。** `os/claude.mjs` と `os/focus.mjs` は
 * プロジェクト内 import ゼロ（`node:` だけ）という約束にしてあるので、
 * あちらの `String(e?.message ?? e)` は重複のまま残してある。
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

/**
 * 例外を表示用の1行にする。
 *
 * **投げられるものは Error とは限らない。** 文字列も undefined も来るので、
 * `message` があればそれを、無ければ値そのものを文字列にする。
 * 32 箇所に同じ式が散っていたのをここへ寄せた。
 *
 * @param {*} err catch が受け取った値
 * @returns {string}
 */
export function errText(err) {
  return String(err?.message ?? err);
}

/**
 * 作業フォルダから、いちばん下のフォルダ名を取る。
 *
 * 区切りは `/` と `\` の両方を見る。Windows のパスと POSIX のパスが混ざるため。
 *
 * **取れなかったときに何を返すかは呼ぶ側で違う**（`projectDir` へ落とす・`null` にする）。
 * だから既定値を持たせず、引数で受ける。
 *
 * @param {*} cwd 作業フォルダ
 * @param {*} [fallback] 取れなかったときに返すもの
 * @returns {*} フォルダ名、または fallback
 */
export function projectNameOf(cwd, fallback = null) {
  if (typeof cwd !== 'string' || !cwd) return fallback;
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? fallback;
}
