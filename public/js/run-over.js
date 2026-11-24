/* 画面から起こした実行が終わっているときの状態（台帳の終わりの語）。
 *
 * 層0。**import ゼロ**なので Node から読める（`test/next-step.test.mjs` が突き合わせている）。
 *
 * **サーバーの `isRunOver`（`src/run/ledger.mjs`）と同じ3つ。** あちらは Node の層にあって
 * 画面からは import できないので、画面側ではここ1か所に持ち直す。
 * 使うのは `next-step.js`（層0）・`run-view.js` / `run-ask.js` / `run-resume.js`（層3）。
 *
 * 前はこの4枚が1つずつ書き写していた。層3の3枚は「同じ層どうしで import の向きを作らない」ために
 * 写していたが、置き場所が層0なら向きは下へ1本で済む（どの層からも層0は見てよい）。
 * 台帳が状態を1つ足した日に、写しの1枚だけが古くなる形をやめた。
 *
 * - **stopping と switching を入れない。** どちらも途中の姿で、そこから running へ戻る
 * - **budget（予算切れ）も入れない。** 上限を上げれば続けられる。子がいないことは
 *   `run-view.js` の `RUN_NO_CHILD` が別に持つ（サーバーの `isChildDone` と同じ線）
 */
export const RUN_OVER = new Set(['stopped', 'failed', 'done']);
