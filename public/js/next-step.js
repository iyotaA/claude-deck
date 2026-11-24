/* 詳細の頭の「次の一手」。
 *
 * 層0。**純関数**なので Node からテストできる（`test/next-step.test.mjs`）。
 * `groups.js` / `nav.js` と同じ形。import は同じ層0 の `run-over.js`（台帳の終わりの語）だけ。
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
 *
 * 見分けの材料は2つ。台帳（`runFor(...)?.state`）と、行に載った run（`overlay` が台帳の行を
 * `row.run` に丸ごと写し、`origin: 'deck'` を立てる）。**台帳だけに頼らない** … 起動直後や
 * SSE のつなぎ直しのあいだは台帳がまだ届かず `runFor()` が null を返すが、行のほうには
 * もう alive と子の pid が入っている。どちらか一方でも「動いている」と言えば出さない
 * （片方だけが遅れていても、別の窓を前に出さない）。
 */
import { RUN_OVER } from './run-over.js';

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
 * 画面から起こした実行が、このセッションでまだ動いているか。
 *
 * 台帳（`runState`）と行に載った run（`row.run.state`）のどちらか一方でも終わっていない語を
 * 言えば動いている。**`overlay` は終わった run にも `row.run` を付ける**ので、run が有るだけでは
 * 決めない（終わった実行のあとにターミナルで開き直したものは窓を持つ）。
 * 画面から起こしたと行が言う（`origin: 'deck'`）のに状態がどこからも読めないときは、
 * 動いているほうに倒す（押せる顔で出して別の窓を前に出すより、出さないほうが害が小さい）。
 *
 * @param {object} row 一覧の行
 * @param {string|null} runState 台帳の状態（`runFor(...)?.state`）。無ければ null
 * @returns {boolean}
 */
function deckRunLive(row, runState) {
  const states = [runState, row.run?.state].filter((s) => typeof s === 'string');
  if (states.some((s) => !RUN_OVER.has(s))) return true;
  return states.length === 0 && row.origin === 'deck';
}

/**
 * このセッションのターミナルの窓を前に出せるか。
 *
 * 頭の次の一手とパレット（Ctrl+K の「ターミナルを前面に」）が**同じこの判断**を通る。
 * パレットは自分では何も決めない約束なので、ここを2か所に書かない。
 *
 * @param {object|null} row 一覧の行（alive / pid / origin / run を見る）
 * @param {string|null} [runState] この画面から起こした実行の状態（`runFor(...)?.state`）。無ければ null
 * @returns {boolean}
 */
export function canFocusTerminal(row, runState = null) {
  if (!row || row.alive !== true) return false;
  if (!Number.isInteger(row.pid) || row.pid <= 0) return false;
  // 動いている実行の子は窓を持たない（冒頭の節）。終わった実行のあとに
  // ターミナルで開き直したものは、登録簿の alive / pid がそのまま残るのでターミナルとして扱う
  if (deckRunLive(row, runState)) return false;
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
 * @param {object} row 一覧の行（state / blocking / alive / pid / origin / run）
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
