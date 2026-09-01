/**
 * 同じポートに ClaudeDeck が居たとき、譲るかずらすかを決める。
 *
 * 実測で踏んだ形はこう。
 * リポジトリから `npm start` した開発サーバーが 4317 を握っている状態で、
 * 入れた版の `ClaudeDeck.exe` を起動すると、ランチャは「すでに動いています」と見て
 * 窓（Edge）を開くだけで終わる。画面が映すのは開発サーバーで、そちらには
 * `CLAUDE_DECK_LAUNCHER` が無いので `canApply` が false になり、更新ボタンが押せない。
 * 「入れた版を起動したのに更新できない」という、いちばん理由の見えない壊れ方になる。
 * 版が同じ日は `launcher/ServerProcess.cs` の「別の場所の server.mjs が動いています」も出ない。
 *
 * **相手を止めるのは選ばない。** 何日も動いているものを別のプロセスが黙って落とすほうが
 * 行儀が悪い（`EnsureRunningAsync` も同じ判断をしている）。
 * ずらして自分の番号で立てれば、どちらも生きたまま済む。
 *
 * **ずらす先はここで決めない。** 返すのは「譲るか・ずらすか」だけで、
 * 何番にするかは `server.mjs` の `listen`（+1 を12回）に任せる。
 * ポートの決め方を2箇所に置くと、片方だけ直った日に食い違う。
 */

/** ランチャが立てたもの。`CLAUDE_DECK_LAUNCHER` がある起動 */
export const VIA_LAUNCHER = 'launcher';

/** それ以外。`npm start` や `node server.mjs` で手で立てたもの */
export const VIA_MANUAL = 'manual';

/**
 * ポートの取り合いをどう畳むか。
 *
 * @param {object} p
 * @param {string|null} p.mine 自分の経路。`VIA_LAUNCHER` か `VIA_MANUAL`
 * @param {string|null} p.theirs 相手の経路。`/api/health` の `startedBy`。
 *   これを返さない古い版が相手だと null になる。
 *   **null を manual に倒さない**（0 と不明を分けるのと同じ。倒すと、
 *   古いインストール版が動いている手元で二重に立ち上がる）
 * @returns {'yield'|'shift'} `yield`=画面を開いて終わる / `shift`=ずらして自分で立つ
 */
export function decidePortClash({ mine, theirs }) {
  // 開発側は譲る。手で立てたものが、入れた版の窓を奪う筋合いはない。
  // ここを変えると `npm start` が勝手に 4318 へ回り、コンソールを見ない人が混乱する
  if (mine !== VIA_LAUNCHER) return 'yield';

  // 相手が手で立てたものなら、こちらはずらす。相乗りすると冒頭の事故になる
  if (theirs === VIA_MANUAL) return 'shift';

  // 相手もランチャ経由（＝同じ入れた版）なら、二重に立てる意味がない。
  // 不明も譲る側へ倒す。startedBy を返さないのは 0.9.0 より前の版で、
  // それが動いているのはインストール版である見込みのほうが高い
  return 'yield';
}
