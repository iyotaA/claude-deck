/**
 * 環境変数のスイッチを読む。
 *
 * このアプリには「画面から触らせないスイッチ」がいくつかある。
 * 自分を締め出せる口（更新の停止）や、いちばん危ない選択肢を出す口（bypass）は、
 * ブラウザからではなく環境変数だけで入り切りする、と決めてある。
 *
 * - `CLAUDE_DECK_NOTIFY_OFF` … 通知を全部止める
 * - `CLAUDE_DECK_UPDATE_OFF` … 更新の確認をしない（読むのは C# 側）
 * - `CLAUDE_DECK_RUN_ALLOW_BYPASS` … 権限モードに bypassPermissions を出す
 *
 * **語彙をここ1本にまとめてある。** 同じ判定を各所に書き写すと、
 * 片方だけ直したときに「あっちは 0 で止まるのに、こっちは止まらない」という
 * 説明のつかない差になる。しかも気づくのは踏んだときだけ。
 */

/**
 * スイッチが立っているか。
 *
 * `0` `false` `no` を「立っていない」とするのは、`set X=0` で止めたつもりになる
 * 勘違いを防ぐため。空文字も立っていない扱いにする（`set X=` で消したときにここへ落ちる）。
 *
 * @param {*} raw 環境変数の値。未設定（undefined）も文字列以外も受ける
 * @returns {boolean}
 */
export function isSwitchOn(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}
