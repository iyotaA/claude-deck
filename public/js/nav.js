/* 左のレール（画面の切り替え）の判断。層0。
 *
 * **import ゼロの純関数。** DOM も store も触らないので、Node から import して
 * テストできる（`test/navrail.test.mjs`。`update-banner.js` / `today-md.js` と同じ形）。
 * 節点に書くのは `mode.js`（札の名前・吹き出し・数字キー）と `list.js`（作業台の札の件数）。
 *
 * ## モードの名前とキーの出どころはここ1つ
 *
 * 前はモードの名前が3箇所にあった（`index.html` の札の字・`palette.js` の `MODE_DEFS`・
 * `store.js` の `MODES` の id）。レールの札は字を持たず、名前は `aria-label` と吹き出しが持つので、
 * 写しを残すと1つ足した日に「札の読み上げだけ古い」が起きても画面からは見えない。
 * `store.js` の `MODES` と `palette.js` の名前はここから作る。
 */

/**
 * 画面のモード。**並びがレールの並びで、キーは数字の 1・2・3。**
 *
 * キーを数字にしたのは、どのキーボード配列でも同じ位置にあり、
 * Ctrl や Alt と組まなくて済むから（Ctrl+数字はブラウザのタブ切り替えが先に取る）。
 *
 * `counts` は「その札が止まっている数を名前に持つか」。いまは作業台だけで、
 * 止まっているセッションが居るのは作業台だから。名前と吹き出しを組む口（`modeName` / `modeTip`）が
 * これを見るので、呼ぶ側（`mode.js`）はどの札が数を持つかを知らずに済む。
 */
export const MODE_LIST = Object.freeze([
  Object.freeze({ id: 'work', label: '作業台', key: '1', counts: true }),
  Object.freeze({ id: 'archive', label: '書庫', key: '2', counts: false }),
  Object.freeze({ id: 'usage', label: '数値', key: '3', counts: false }),
]);

/**
 * 押されたキーから、移る先のモードを決める。
 *
 * **効かせない場面を先に全部落とす。** 数字は打つ字そのものなので、
 * 取り違えると「書いている最中に画面が替わる」事故になる。
 *
 * - Ctrl / Meta / Alt を押している … ブラウザやOSの組み合わせを奪わない
 * - IME の変換中（`isComposing`） … 全角の数字を打っている途中
 * - 焦点が入力欄にある（`editable`） … 指示文やメモに数字を書いている
 * - `<dialog>` が開いている（`modal`） … 裏の画面を替えると、閉じたときに居場所が変わっている
 *
 * 入力欄かどうか・モーダルが開いているかは呼ぶ側が DOM から測って渡す
 * （ここを DOM に触らせないため）。
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, isComposing?: boolean}} ev
 * @param {object} [opts]
 * @param {boolean} [opts.editable] 焦点が入力欄（input / textarea / select / contenteditable）にあるか
 * @param {boolean} [opts.modal] `<dialog>` が開いているか
 * @returns {string|null} 移る先のモード id。移らないなら null
 */
export function modeOfKey(ev, { editable = false, modal = false } = {}) {
  if (!ev || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return null;
  if (editable || modal) return null;
  return MODE_LIST.find((m) => m.key === ev.key)?.id ?? null;
}

/**
 * 止まっている（答えないと1行も進まない）セッションの数。
 *
 * **どの状態が止まっているかを画面側に持たない。** サーバーの `meta.stateBlocking` から引く
 * （状態を1つ足した日に、レールの数だけ古くならないように）。真のキーだけを足す。
 *
 * **「無い」と「まだ知らない」を分ける。** `counts` が無い（meta をまだ受け取っていない）なら null。
 * `blocking` が無いときも null にする ―― 古いサーバーが表を返さないと、
 * 止まっているものが居ても 0 と読んで「ありません」と言ってしまう。
 *
 * @param {Record<string, number>|null|undefined} counts `meta.counts`（状態ごとの数）
 * @param {Record<string, boolean>|null|undefined} blocking `meta.stateBlocking`
 * @returns {number|null}
 */
export function blockingCount(counts, blocking) {
  if (!counts || typeof counts !== 'object') return null;
  if (!blocking || typeof blocking !== 'object') return null;
  let n = 0;
  for (const [state, value] of Object.entries(counts)) {
    if (blocking[state] === true && Number.isFinite(value)) n += value;
  }
  return n;
}

/**
 * 件数の言い方。null は「まだ知らない」なので言葉を付けない。
 * @param {number|null} n
 * @returns {string|null}
 */
function blockingText(n) {
  if (n === null || n === undefined) return null;
  return n === 0 ? '止まっているものはありません' : `止まっているもの ${n} 件`;
}

/**
 * 札の名前（`aria-label`）。数を持つ札（`counts`）だけ、件数の言い方を括弧で添える。
 *
 * **0 件のときも言う。** 書庫・数値のあいだは一覧の枠「あなたの番」が見えないので、
 * 「見ていない」と「無い」を分ける1行がどこかに要る（その役目をこの名前が持つ）。
 * **まだ知らない（null）ときは何も添えない。**
 *
 * 数えるのは止まっているものだけ。一覧の枠「あなたの番」は返信待ちも入れるので
 * 件数が違うことがあるが、名前が「止まっているもの N 件」と言っているので食い違わない。
 *
 * @param {{label: string, counts?: boolean}} m MODE_LIST の1つ
 * @param {number|null} [n] `blockingCount()` の戻り。数を持たない札では見ない
 * @returns {string}
 */
export function modeName(m, n = null) {
  const t = m.counts ? blockingText(n) : null;
  return t ? `${m.label}（${t}）` : m.label;
}

/**
 * 札の吹き出し。1行目が名前とキー（全角の空白で区切る。「作業台　1」）、
 * 数を持つ札だけ2行目に件数の言い方（CSS の `white-space: pre` で改行を活かす）。
 * まだ知らないときは1行だけ。
 *
 * @param {{label: string, key: string, counts?: boolean}} m MODE_LIST の1つ
 * @param {number|null} [n] `blockingCount()` の戻り。数を持たない札では見ない
 * @returns {string}
 */
export function modeTip(m, n = null) {
  const head = `${m.label}　${m.key}`;
  const t = m.counts ? blockingText(n) : null;
  return t ? `${head}\n${t}` : head;
}

/** 数を持つ札（作業台）。MODE_LIST から引く（写しを作らない） */
const COUNTED = MODE_LIST.find((m) => m.counts);

/**
 * 作業台の札の名前。`list.js` がバッジと一緒に書き替えるときの口（`modeName` の作業台ぶん）。
 * @param {number|null} n `blockingCount()` の戻り
 * @returns {string}
 */
export function workName(n) {
  return modeName(COUNTED, n);
}

/**
 * 作業台の札の吹き出し。`workName` と同じく `list.js` が使う（`modeTip` の作業台ぶん）。
 * @param {number|null} n `blockingCount()` の戻り
 * @returns {string}
 */
export function workTip(n) {
  return modeTip(COUNTED, n);
}
