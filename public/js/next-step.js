/* 詳細の頭の「次の一手」。
 *
 * 層0。**import ゼロの純関数**なので Node からテストできる（`test/next-step.test.mjs`）。
 * `groups.js` / `nav.js` と同じ形。
 *
 * 判断をここに置くのは、頭を組む `detail-head.js`（層1）からは、画面から起こした実行
 * （`runs.js`・層2）も入力欄の有無（`run-resume.js`・層3）も見えないため。
 * 材料は `detail.js`（層4）が集めて渡し、ここは「何を出すか・塗るか」だけを決める。
 *
 * ## 決まり
 *
 * - **塗るのは1画面に1つ。** 入力欄が出ていれば、その「送る」「続きを起こす」が塗ってあるので、
 *   頭は塗らない。入力欄が無いときだけ頭を塗る
 * - **頭に出すのは「ターミナルの窓を前に出す」口だけ。** 押したときにやることは3つとも同じ
 *   （`POST /api/focus`）で、名前だけが場面で変わる。**許可・質問のボタンは頭に上げない**
 *   （コマンドを読む前に押せる位置に置かない。答えるのはカードかターミナル）
 * - **窓を前に出せない行には出さない。** 押せない顔のボタンを出さない
 *
 * ## 画面から起こした実行は頭に出さない
 *
 * 子は `src/os/claude.mjs` の `spawnClaude` が `windowsHide: true`・`shell: false`・
 * stdio を全部パイプにして起こすので、**自分の窓を持たない。** しかも
 * `scripts/focus.ps1` は窓が見つかるまで親を最大8段たどるので、押すと
 * サーバーの窓（`npm start` した端末）かランチャの窓が前に出る ―― 目当てのものではない。
 * 一覧へ混ぜるとき `merge.mjs` の `overlay` が `alive: true` と子の pid を入れるので、
 * 何もしないと「ターミナルを前面に」が出てしまう。
 * 許可・質問はカード、送る・割り込む・止めるは入力欄が持つので、頭に出すものが無い。
 */

/**
 * 画面から起こした実行が終わっているときの状態。
 *
 * **サーバーの `isRunOver`（`src/run/ledger.mjs`）と同じ3つ。** あちらは Node の層にあって
 * 画面からは import できないので持ち直している（`run-view.js` / `run-ask.js` /
 * `run-resume.js` の `RUN_OVER` と同じ事情）。台帳の全部の語で食い違わないことを
 * `test/next-step.test.mjs` が突き合わせている。
 */
const RUN_OVER = new Set(['stopped', 'failed', 'done']);

/**
 * 頭に出す一手の語。`kind` が鍵。
 *
 * 名前は「何をしに行くか」で言う。窓を前に出すだけなのは3つとも同じなので、
 * 吹き出しでそう断る。**「答える」で押しても許可にはならない**ことは必ず書く
 * （塗った面が「押せば答えられる」に見えるため）。
 */
export const NEXT_STEPS = Object.freeze({
  answer: {
    label: 'ターミナルで答える',
    title: 'ターミナルの窓を前面に出します。答えるのはターミナルで（ここを押しても許可にはなりません）',
  },
  reply: {
    label: 'ターミナルで返事をする',
    title: 'ターミナルの窓を前面に出します。次の指示はターミナルで打ちます',
  },
  front: {
    label: 'ターミナルを前面に',
    title: 'ターミナルの窓を前面に出します',
  },
});

/**
 * このセッションのターミナルの窓を前に出せるか。
 *
 * 頭の次の一手とパレット（Ctrl+K の「ターミナルを前面に」）が**同じこの判断**を通る。
 * パレットは自分では何も決めない約束なので、ここを2か所に書かない。
 *
 * @param {object|null} row 一覧の行（alive / pid を見る）
 * @param {string|null} [runState] この画面から起こした実行の状態（`runFor(...)?.state`）。無ければ null
 * @returns {boolean}
 */
export function canFocusTerminal(row, runState = null) {
  if (!row || row.alive !== true) return false;
  if (!Number.isInteger(row.pid) || row.pid <= 0) return false;
  // 動いている実行の子は窓を持たない（冒頭の節）。終わった実行のあとに
  // ターミナルで開き直したものは、登録簿の alive / pid がそのまま残るのでターミナルとして扱う
  if (typeof runState === 'string' && !RUN_OVER.has(runState)) return false;
  return true;
}

/**
 * 頭に出す次の一手。出さないなら null。
 *
 * | 場面 | 返すもの |
 * |---|---|
 * | 止まっている（ターミナル） | `answer`。塗る |
 * | 返信待ち（ターミナル） | `reply`。塗る |
 * | 実行中（ターミナル） | `front`。塗らない（あなたにやることは無い） |
 * | 画面から起こした実行・終了・不明・pid が無い | null |
 *
 * 止まっているかは `row.blocking`（サーバー由来）で見る。状態の名前を列挙しない
 * （どの状態が止まっているかを画面側に持たない約束）。返信待ちと実行中は名前で見る
 * （`detail.js` の `NOW_TONE` と一覧の「動いている行か」と同じ扱い）。
 *
 * @param {object} row 一覧の行（state / blocking / alive / pid）
 * @param {object} [opts]
 * @param {string|null} [opts.runState] この画面から起こした実行の状態。無ければ null
 * @param {boolean} [opts.composer] 入力欄が出ているか（出ていれば頭は塗らない）
 * @returns {{kind: 'answer'|'reply'|'front', label: string, title: string, lead: boolean}|null}
 */
export function nextStep(row, { runState = null, composer = false } = {}) {
  if (!canFocusTerminal(row, runState)) return null;
  let kind = null;
  if (row.blocking === true) kind = 'answer';
  else if (row.state === 'awaiting-reply') kind = 'reply';
  else if (row.state === 'running') kind = 'front';
  if (!kind) return null;
  // 塗るのは「あなたの番」の2つだけで、入力欄が無いときだけ
  const lead = kind !== 'front' && composer !== true;
  return { kind, ...NEXT_STEPS[kind], lead };
}
