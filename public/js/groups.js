/* 一覧の「どの行をどの束へ置くか」。層0。
 *
 * **import ゼロの純関数。** だから Node からテストできる（`test/groups.test.mjs`）。
 * 描くのは `list.js`、拡大モーダルの「次の待ち」（`zoom.js`）も止まっている状態の集合をここから引く。
 *
 * 束は上から **あなたの番 → ピン留め → 実行中 → 終了 → そのほか。**
 * 枠「あなたの番」は**ボールの所在**の束で、許可・質問で止まっているものと返信待ちの両方が入る。
 * 左のレールの作業台のバッジ（止まっているものだけを数える。`nav.js` の `blockingCount`）とは
 * 別の数になるが、レールの札の名前は「止まっているもの N 件」と言っているので食い違わない。
 *
 * 状態ラベルの日本語を画面側に持たない決まりの**例外**になる。
 * サーバが渡す `meta.stateLabels` は状態1つずつの名前で、
 * 「返信待ち」「許可・質問で止まっている」のような**まとめた名前**は向こうに無い
 * （前に `store.js` に置いていた見出しの表も、監視盤の COLUMNS も同じ理由）。
 *
 * ここに書くのは「どこへ置くか」の割り当てで、急ぎかどうかの判定ではない
 * （そちらは行の `blocking` ＝ サーバ由来を見る。`meta.stateBlocking` が出どころ）。
 * 状態が1つ増えたときは、どの束にも入らず `rest`（「そのほか」）へ落ちる。消えはしない。
 */

/*
 * 束の定義はどれも同じ形で持つ。描く側（list.js）は定義を読むだけで、id の文字列で分岐しない。
 *
 *   id       束の名前（groupRows が返す鍵・開け閉めの印）
 *   label    見出しの字
 *   states   入る状態。見出しの点と色はこの先頭の状態から引く（無ければ「不明」と同じ顔）
 *   icon     状態でない束（ピン留め）だけ。点の代わりに出す絵の名前（icons.js の鍵）
 *   wants    行の2行目に「何を求めているか」を出す束（止まっているものだけ）
 *   foldable 見出しの右に開け閉めを置き、たたんだ形で始める束（終了だけ）
 */

/**
 * 枠「あなたの番」の中の小見出し。上から手をつける順。
 *
 * **止まっているものを先に置く。** 答えないと1行も進まないので、返信待ち
 * （Claude は応答を返し終えていて、放っておいても壊れない）より急ぐ。
 * 2行目に何を求めているかを出すのも止まっている束だけ（返信待ちは求めているものが無い）。
 */
export const YOURS_GROUPS = [
  { id: 'stop', label: '許可・質問で止まっている', states: ['needs-answer', 'needs-plan-approval', 'needs-approval'], wants: true },
  { id: 'reply', label: '返信待ち', states: ['awaiting-reply'] },
];

/**
 * 枠の外の見出し。上から手をつける順（サーバ側の STATE_RANK と同じ考え）。
 *
 * **これは監視盤の COLUMNS を引き継いだもの。** あちらは列への割り当てで、
 * こちらは縦一覧への割り当て。材料（store.rows）も並び順も同じ。
 * **1つの状態を2つの表（ここと `YOURS_GROUPS`）に書かない**（同じ行が2か所に出ると
 * 選んだときの aria-current が二重になる）。
 *
 * 終了は**たたんだ形で始める**（`foldable`）。動いている2件が、何十件もの終わったものの
 * 上の小さな島にならないように。開いたら全部出す（もっと古いものは書庫にある）。
 */
export const STATE_GROUPS = [
  { id: 'run', label: '実行中', states: ['running'] },
  { id: 'done', label: '終了', states: ['ended'], foldable: true },
];

/**
 * ピン留めの束。**状態の束ではない**ので `states` を持たず、点の代わりに星の絵を出す。
 * 入るのは、枠「あなたの番」に入らないピンの行だけ（`groupRows`）。
 */
export const PINNED_GROUP = { id: 'pinned', label: 'ピン留め', icon: 'star' };

/**
 * どの束にも入らない状態の受け皿。`states` を持たないので、見出しの点は「不明」と同じ顔になる。
 * サーバが状態を1つ足した日に、一覧から行が黙って消えないための束。
 */
export const REST_GROUP = { id: 'rest', label: 'そのほか' };

/**
 * 止まっている状態の集合。**`YOURS_GROUPS` の stop から作る**（手で書き写すと、
 * 状態を1つ足した日に枠と「次の待ち」が食い違う）。
 * 拡大モーダルの「← 前／次の待ち →」はこの顔ぶれを回る（返信待ちは回らない）。
 */
export const STOP_STATES = new Set(YOURS_GROUPS.find((g) => g.id === 'stop').states);

/**
 * 行を束へ振り分ける。
 *
 * **並べ替えない。** `store.rows` はサーバが STATE_RANK と開始時刻（終了済みは idleMs）で
 * 並べたものなので、前から拾えばそのまま「先に手をつける順」になる。
 * 比較器を画面側に持つと、2箇所に並び順ができる。
 *
 * - 枠に入る状態の行は、**ピンが付いていても枠へ。** ボールの所在が先で、ピンは
 *   「覚えておきたい」の印にすぎない（描く側が行に星を出して、ピンは失わない）
 * - ピン留めには、枠に入らないピンの行だけが入る。そこへ入った行は状態の見出しに出さない
 * - どの束にも入らない状態は `rest`。**黙って落とさない**
 *
 * `groups` は `STATE_GROUPS` の順に全部並べる（空でも入れる）。空の見出しを出すかどうかは描く側が決める。
 *
 * @param {object[]} rows 一覧の行（`state` と `pinned` だけを見る）
 * @returns {{
 *   yours: {stop: object[], reply: object[]},
 *   pinned: object[],
 *   groups: {group: object, rows: object[]}[],
 *   rest: object[],
 * }}
 */
export function groupRows(rows) {
  const yours = Object.fromEntries(YOURS_GROUPS.map((g) => [g.id, []]));
  const pinned = [];
  const groups = STATE_GROUPS.map((group) => ({ group, rows: [] }));
  const rest = [];
  for (const row of rows) {
    const mine = YOURS_GROUPS.find((g) => g.states.includes(row.state));
    if (mine) {
      yours[mine.id].push(row);
      continue;
    }
    if (row.pinned) {
      pinned.push(row);
      continue;
    }
    const bin = groups.find((x) => x.group.states.includes(row.state));
    if (bin) bin.rows.push(row);
    else rest.push(row);
  }
  return { yours, pinned, groups, rest };
}
