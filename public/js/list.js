/* 稼働中の一覧（左のペイン）と、左のレールに出す数（止まっているものの数・枠の輪）。
 *
 * 層6。押されたときに select（session.js）と setListOpen（drawer.js）を呼ぶ。
 * setListOpen が drawer.js に居るのは、main.js に置くとここと循環するため。
 *
 * **どの行をどの束へ置くか**（枠「あなたの番」・ピン留め・状態の見出し・そのほか）と、
 * 束ごとの出し方（点か絵か・2行目に何を求めているかを出すか・開け閉めするか）は
 * groups.js（層0）の定義が決める。ここは定義を読んで描くだけで、**状態の名前も束の id も列挙しない**
 * （列挙すると、状態や束を1つ足した日にここだけ古くなる）。
 *
 * 書庫と数値のカードはここから借りていない。定型は card.js に置き、何を出すかは各自が持つ。
 */
import { el, since, stamp } from './util.js';
import { store, colorOf, toneOf } from './store.js';
import { dom } from './dom.js';
import { YOURS_GROUPS, PINNED_GROUP, REST_GROUP, groupRows } from './groups.js';
import { blockingCount, workName, workTip } from './nav.js';
import { idleOf, headOf, visibleRows } from './rows.js';
import { newestRateLimit, rateView, ringView, runFor } from './runs.js';
import { rateRing } from './usage-chart.js';
import { closeListAfterPick } from './drawer.js';
import { select } from './session.js';
import { icon } from './icons.js';

/* ── 一覧 ─────────────────────────────────────────────── */

/**
 * 開いている束（`foldable` の束の id）。**localStorage に残さない。**
 * 開き直したらたたんだ形から始める（覚えると、いちど開いただけで既定が崩れる）。
 *
 * **開いたら全部出す。** 最初の N 件だけ出して継ぎ足す段を作ると、
 * どこまで出ているかを二度読むことになる。もっと古いものは書庫にある。
 */
const openFolds = new Set();

/**
 * 見出しと、その配下の行を1かたまりにする。
 *
 * 見出しの形は監視盤の列の頭（`.col-head`）から借りている。点・名前・件数の並びも
 * 太さも同じで、違うのは横に置くか縦に置くかだけ。枠「あなたの番」の中の小見出しも
 * この形を借りる（`buildYours`）。
 *
 * **かたまりで包むのは sticky のため。** 見出しをカードと同じ高さに並べると、
 * 貼り付く範囲が一覧の全体になり、**4本の見出しが上端で積み重なる**（実測）。
 * 内側の `<ul>` に入れておけば、次のかたまりが来たときに前の見出しを押し出す。
 *
 * 出し方は束の定義が持つ（点か絵か＝`states` / `icon`、開け閉め＝`foldable`、
 * 2行目＝`wants`）。ここで分岐するのは「枠の中か」の1つだけで、これは束の性質ではなく置き場所の話。
 *
 * @param {object} group groups.js の束の定義
 * @param {object[]} rows そこに入る行（groupRows が振り分けたもの）
 * @param {boolean} [inYours] 枠「あなたの番」の中の小見出しか（行に星と札「画面」を出す）
 * @returns {HTMLElement} `<li>` に入れたかたまり
 */
function buildGroup(group, rows, inYours = false) {
  const li = el('li', 'group');
  // 色は束の先頭の状態から引く。見出しのために新しい色を作らない
  // （states を持たない束は undefined → 「不明」と同じ色。colorOf が倒す）
  li.style.setProperty('--state-color', colorOf(group.states?.[0]));

  const head = el('div', 'group-head');
  head.append(headMark(group), el('span', null, group.label));
  // **件数は全件を出す。たたんでいても。** 数を消すと「無い」と「たたんでいる」が同じ顔になる
  head.append(el('span', 'n', String(rows.length)));
  const open = !group.foldable || openFolds.has(group.id);
  if (group.foldable) head.append(foldButton(group, open));
  li.append(head);

  // たたんでいるあいだは行を組まない。上下キー（main.js）も経過の差し替え（refreshTimes）も
  // 出ていない行を相手にせずに済む
  if (!open) return li;
  const body = el('ul', 'group-body');
  for (const row of rows) body.append(buildRow(row, { inYours, wants: Boolean(group.wants) }));
  li.append(body);
  return li;
}

/**
 * 見出しの頭の印。状態の束は状態の点、状態でない束（ピン留め）は絵。
 *
 * @param {object} group groups.js の束の定義
 * @returns {Element}
 */
function headMark(group) {
  if (group.icon) return icon(group.icon, 13);
  const mark = el('span', 'state');
  mark.dataset.s = toneOf(group.states?.[0]);
  return mark;
}

/**
 * 開け閉めできる見出し（`foldable`）の右に置くボタン。
 *
 * **絵（chevron）だけ。** たたんでいるときは右向き、開いたら下向き（CSS が aria-expanded から回す）。
 * 名前は title と aria-label が持つ（アイコンだけのボタンの約束）。
 *
 * 押すと一覧ごと組み直すので、このボタンの節点も替わる。**焦点は名前で拾い直す**
 * （`data-refocus`。拾うのは `renderList` の出口）。やらないと、キーボードで押した瞬間に
 * 焦点が body へ落ちて、続けて押せない。
 *
 * @param {object} group groups.js の束の定義
 * @param {boolean} open いま開いているか
 * @returns {HTMLButtonElement}
 */
function foldButton(group, open) {
  const name = `${group.label}を${open ? 'たたむ' : '開く'}`;
  const btn = el('button', 'ibtn fold-btn');
  btn.type = 'button';
  btn.title = name;
  btn.setAttribute('aria-label', name);
  btn.setAttribute('aria-expanded', String(open));
  btn.dataset.refocus = `fold:${group.id}`;
  // 形は新しく作らない。右向きの chevron を、開いたときだけ CSS で下へ回す
  btn.append(icon('chevron', 14));
  btn.addEventListener('click', () => {
    if (openFolds.has(group.id)) openFolds.delete(group.id);
    else openFolds.add(group.id);
    renderList();
  });
  return btn;
}

/**
 * 枠「あなたの番」。**ボールが自分にあるセッションを、一覧のいちばん上の1つの枠にまとめる。**
 * 作業台を開けば最初に目に入る。
 *
 * 中は小見出し2つ（`YOURS_GROUPS`。許可・質問で止まっている → 返信待ち）。0 件の小見出しは出さない。
 * 左のレールの作業台のバッジ（止まっているものだけ）とは別の数になる。
 *
 * **0 件でも枠は残す。** 中に「いま返事を待っているセッションはありません」の1行を置く。
 * 枠ごと消すと、静かな日に「見ていない」と「無い」が同じ顔になる。
 * 枠を出さないのは、meta をまだ受け取っていなくて枠に入る行も無いときと、一覧が丸ごと空のとき
 * （どちらも `renderList` が決める）。
 *
 * **`role="group"` は内側の器に付ける。** `<li>` に付けると一覧（`<ul>`）の子が
 * 項目でなくなり、一覧としての読み上げが崩れる。名前は頭の見出し（件数ごと）から引く。
 *
 * @param {{stop: object[], reply: object[]}} yours `groupRows()` の yours
 * @param {number} total 枠に入る行の数（`yoursTotal`）
 * @returns {HTMLElement} `<li>` に入れた枠
 */
function buildYours(yours, total) {
  const li = el('li', 'group is-yours');
  const frame = el('div', 'yours-frame');
  frame.setAttribute('role', 'group');
  frame.setAttribute('aria-labelledby', 'yours-title');
  if (total === 0) frame.classList.add('is-empty');

  const title = el('h2', 'yours-title');
  title.id = 'yours-title';
  title.append(
    el('span', 'yours-label', 'あなたの番'),
    el('b', 'yours-count', String(total)),
    el('span', 'yours-unit', '件'),
  );
  frame.append(title);

  if (total === 0) {
    const none = el('p', 'yours-none');
    // 点は「通って済んだ」の --done の塗った丸（色は CSS）。呼ばれていないことを形でも示す
    none.append(el('span', 'state'), document.createTextNode('いま返事を待っているセッションはありません'));
    frame.append(none);
  } else {
    const body = el('ul', 'group-body');
    for (const g of YOURS_GROUPS) {
      if (yours[g.id].length) body.append(buildGroup(g, yours[g.id], true));
    }
    frame.append(body);
  }
  li.append(frame);
  return li;
}

/**
 * 枠「あなたの番」に入る行の数。
 * @param {{stop: object[], reply: object[]}} yours `groupRows()` の yours
 * @returns {number}
 */
function yoursTotal(yours) {
  return YOURS_GROUPS.reduce((n, g) => n + yours[g.id].length, 0);
}

/**
 * 圧縮した1行。
 *
 * 1行目は点・題・置き場所・右の端（印と経過）。**置き場所は消さない** ――
 * 同じ題（「セキュリティレビュー」など）が並ぶと見分けられない（UI レビューの F4）。
 * 2行目には置かない（どの行も2行になると、全体が一度に見えなくなる）。
 *
 * **2行目を出すのは2つだけ。** `wants` の束（止まっているもの）の行は「何を求めているか」（`wantsLine`）、
 * 動いている行は「いま何をしているか」（`.now`）。返信待ちと終了は1行のまま ――
 * 役目は「全体が一度に見えること」で、ほかは選んだときに詳細ペインで読める。
 * どちらを出すかの材料（束と state）はどちらも一覧の鍵（`listKey`）に入っているので、
 * 変われば組み直される。
 *
 * 右の端の印は3つ。どれも押せない札か絵で、名前は行の読み上げにも乗る。
 * - 札「画面」… 枠の中で、この画面から起こしたもの（`runFor` がある）。ここから答えられるのはそれだけ
 *   （ターミナルで走っているものには答える窓口そのものが無い）
 * - 星（ピン留め）… 枠の中の行だけ。ピンの行は普段ピン留めの見出しに居て星は要らないが、
 *   待たせているあいだは枠へ移るので、ピンが付いていることをここで残す
 * - メモの絵 … **本文は出さない。** 吹き出し（title）と読み上げ（aria-label）と詳細の頭で読む
 *
 * **カード（card.js）を使わない。** カードは書庫と数値の定型で、出す項目が5つある。
 * ここは絞ることそのものが役目なので、カードに載せると「何を出さないか」を毎回打ち消すことになる。
 *
 * @param {object} row 一覧の行
 * @param {object} [opts]
 * @param {boolean} [opts.inYours] 枠「あなたの番」の中の行か
 * @param {boolean} [opts.wants] 2行目に何を求めているかを出す束の行か（束の定義の `wants`）
 * @returns {HTMLElement} `<li>` に入れた行
 */
function buildRow(row, { inYours = false, wants = false } = {}) {
  const li = el('li');
  const node = el('button', 'row');
  node.type = 'button';
  node.dataset.sessionId = row.sessionId ?? '';
  node.dataset.s = toneOf(row.state);
  node.style.setProperty('--state-color', colorOf(row.state));
  node.setAttribute('aria-current', String(row.sessionId === store.selected));

  node.append(el('i', 'dot'));
  const title = el('span', 't', row.title ?? row.name ?? row.sessionId);
  if (!row.title) title.classList.add('is-empty');
  // 題は1行で切るので、全文は title 属性に残す
  if (row.title) title.title = row.title;
  node.append(title);

  // **置き場所を題の右に薄く出す。** 書庫とコマンド入力には出ているのに、ここだけ無かった。
  // 取れない行も空の節点を置く（列の数を行ごとに変えない）
  const proj = el('span', 'p', row.project ?? '');
  if (row.cwd) proj.title = row.cwd;
  node.append(proj);

  // 右の端。印と経過を1つの器に入れる（印の有無で列の数を変えない。空の列にも gap が付くため）
  const end = el('span', 'end');
  if (inYours && runFor(row.sessionId)) {
    const here = el('span', 'here-badge', '画面');
    here.title = 'この画面から起こしたセッション。ここから答えられます';
    end.append(here);
  }
  if (inYours && row.pinned) end.append(markIcon('star', 'pin-mark', 'ピン留め'));
  if (row.memo) end.append(markIcon('pencil', 'memo-mark', `メモ: ${row.memo}`, row.memo));
  const idle = el('span', 'm', agoText(row));
  if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
  end.append(idle);
  node.append(end);

  if (wants) {
    const line = wantsLine(row);
    if (line) node.append(line);
  } else if (isRunning(row)) {
    // **動いている行にだけ、いま何をしているかを2行目に添える**（UI レビューの段7。
    // ボール板を作る代わりに、あちらにしか無かった中身だけをここへ持ち込んだ）。
    // 中身は数秒ごとに変わるので、**一覧の鍵（listKey）に混ぜない。** 混ぜると組み直しのたびに
    // スクロールと焦点が飛ぶ。節点だけ置いておき、文字は refreshTimes() が差し替える
    // （経過時間と同じ扱い）。空のあいだは hidden で、行は1行のまま
    const nowLine = el('span', 'now');
    paintNow(nowLine, row);
    node.append(nowLine);
  }

  node.addEventListener('click', () => {
    select(row.sessionId, 'live');
    closeListAfterPick();
  });
  li.append(node);
  return li;
}

/**
 * 行の右の端に置く絵の印。押せないので span（role="img"）にして、名前は aria-label に入れる。
 * 行そのものが `<button>` なので、ここの名前は行の読み上げにそのまま乗る
 * （中にボタンを入れると押せるものの入れ子になる。付け外しは詳細の頭の ☆ と Ctrl+K）。
 *
 * @param {string} name icons.js の鍵
 * @param {string} cls クラス名
 * @param {string} label 読み上げる名前
 * @param {string} [tip] 吹き出し。省けば label と同じ
 * @returns {HTMLElement}
 */
function markIcon(name, cls, label, tip = label) {
  const mark = el('span', cls);
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
  mark.title = tip;
  mark.append(icon(name, 13));
  return mark;
}

/**
 * 何を求めているか（ツールと中身）。`wantsLine` が描き、`listKey` が鍵に混ぜる。
 * 出どころを1つにしておくと、描くものと鍵が食い違わない。
 *
 * @param {object} row 一覧の行
 * @returns {?{tool: string, detail: ?string}} 求めているものが無ければ null
 */
function wantsOf(row) {
  const w = row.waitingFor;
  return w ? { tool: w.tool ?? '?', detail: w.detail ?? null } : null;
}

/**
 * 止まっている行の2行目。**何を求めているか**（ツールと中身）。
 * 中身が無ければ null（行は1行のまま）。
 *
 * 止まっているあいだは中身が動かないので、作るときに1回だけ書く。
 * 変わるのは次の求めに移ったときなので、一覧の鍵（`listKey`）に混ぜて組み直す
 * （動いている行の `.now` と違い、数秒ごとに鍵を揺らす心配が無い）。
 *
 * **クラス名を `.ask` にしない。** 許可要求のカード（ask.css の `.ask`）の枠と字の並びが乗って、
 * 行の中に箱が出る（実測）。
 *
 * @param {object} row 一覧の行
 * @returns {?HTMLElement}
 */
function wantsLine(row) {
  const w = wantsOf(row);
  if (!w) return null;
  const line = el('span', 'wants');
  line.append(el('span', 'tool', w.tool));
  if (w.detail) line.append(document.createTextNode(' '), el('span', null, w.detail));
  // 長いと「…」で切るので、全文は title に残す（中身は実行しようとしているコマンドのことが多い）
  line.title = w.detail ? `${w.tool} ${w.detail}` : w.tool;
  return line;
}

/**
 * 動いている行か。「いま何をしているか」の節点を置くかと、その文字（`nowText`）の両方がこれを見る。
 *
 * **材料は state だけにする。** state は一覧の鍵に入っているので、動き出した・止まったで組み直される。
 * 鍵に入っていない材料（`alive` など）で節点の有無を決めると、それだけが変わったときに
 * 節点が出ない・残るのが組み直しまで続く。
 *
 * @param {object} row 一覧の行
 * @returns {boolean}
 */
function isRunning(row) {
  return row.state === 'running';
}

/**
 * 動いている行の「いま何をしているか」の文字。無ければ空。
 *
 * 並べるのは2つ。TODO の進み（`4/7`。サーバーの `todoSummary`）と、いまの手
 * （進行中の TODO の言い方があればそれ、無ければ走っているツールと中身）。
 * 止まっている行は「何を求めているか」（`wantsLine`）を出すので、ここで出すのは動いているものだけ。
 *
 * @param {object} row 一覧の行
 * @returns {string}
 */
function nowText(row) {
  if (!isRunning(row)) return '';
  const parts = [];
  if (row.todo) parts.push(`TODO ${row.todo.done}/${row.todo.total}`);
  const tool = row.waitingFor?.tool;
  const what = row.todo?.doing
    ?? (tool ? (row.waitingFor.detail ? `${tool}: ${row.waitingFor.detail}` : tool) : null);
  if (what) parts.push(what);
  return parts.join(' · ');
}

/**
 * 「いま何をしているか」の節点に文字を入れる。空なら隠す（行を1行に保つ）。
 * @param {HTMLElement} node `.now`
 * @param {object} row 一覧の行
 */
function paintNow(node, row) {
  const text = nowText(row);
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
  // 長いと「…」で切るので、全文は title に残す
  node.title = text;
}

/**
 * 一覧の行の経過時間。**「前」を付ける。**
 *
 * 数だけだと「19時間00分」が、かかった時間なのか、どれだけ前なのかが読めない。
 * 測っているのは最後に動いてからの時間（`idleOf`）なので「前」が正しい。
 * 取れないとき（`since` が「—」を返す）は付けない。
 *
 * @param {object} row 一覧の行
 * @returns {string}
 */
function agoText(row) {
  const t = since(idleOf(row));
  return t === '—' ? t : `${t}前`;
}

/**
 * 行1本ぶんの鍵の材料。どの束の行でも共通のもの。
 * 「どの行が、どの状態で、どんな題で並んでいるか」と、行に出す印（ピン・メモ）。
 *
 * @param {object} r 一覧の行
 * @returns {string}
 */
function rowKey(r) {
  return [r.sessionId, r.state, r.title ?? r.name ?? '', r.project ?? '', r.pinned ? 'p' : '', r.memo ?? ''].join(':');
}

/**
 * 一覧を組み直すかどうかの鍵。**材料は groupRows が振り分けた結果から作る**
 * （描くものと同じ形から作れば、鍵と画面が食い違わない。状態の名前もここに列挙しない）。
 *
 * - 束ごとに、入っている行の `rowKey` を並べる（行が束を移れば鍵が変わる）
 * - 枠の行は、札「画面」の有無を、`wants` の束の行は「何を求めているか」も混ぜる（どちらも作るときに1回だけ書く）
 * - `store.onlyLive`（行が両方 0 件でも空のときの文言が入れ替わる）・meta を受け取ったか・開いている束
 *
 * **経過時間と「いま何をしているか」は入れない**（毎秒・数秒ごとに動くので、入れると鍵の意味が消える）。
 *
 * @param {?ReturnType<typeof groupRows>} grouped `groupRows()` の結果。一覧が空なら null
 * @returns {string}
 */
function listKey(grouped) {
  const parts = [];
  if (grouped) {
    for (const g of YOURS_GROUPS) {
      parts.push(g.id, ...grouped.yours[g.id].map((r) => {
        const w = g.wants ? wantsOf(r) : null;
        return `${rowKey(r)}:${runFor(r.sessionId) ? 'deck' : ''}:${w ? `${w.tool}/${w.detail ?? ''}` : ''}`;
      }));
    }
    parts.push(PINNED_GROUP.id, ...grouped.pinned.map(rowKey));
    for (const { group, rows } of grouped.groups) parts.push(group.id, ...rows.map(rowKey));
    parts.push(REST_GROUP.id, ...grouped.rest.map(rowKey));
  }
  parts.push(store.onlyLive ? 'live' : 'all');
  // 枠の0件の形は meta を受け取ってから出す。届いた回に組み直さないと、0件の1行が現れない
  parts.push(store.meta ? 'meta' : 'no-meta');
  // 開け閉めで出す行が変わる。混ぜないと、押しても組み直されない
  parts.push(`open:${[...openFolds].sort().join(',')}`);
  return parts.join('|');
}

/** 前に組んだときの鍵。null は「まだ一度も組んでいない」 */
let listStamp = null;

/**
 * 一覧を組む。束は上から **あなたの番 → ピン留め → 実行中 → 終了 → そのほか。**
 *
 * **並べ替えない。** store.rows はサーバ側が STATE_RANK と開始時刻で並べたものなので、
 * 上から読めば手をつける順になる。どの束へ置くかは groups.js の `groupRows` が前から拾って決め、
 * 比較器を画面側に持たない（監視盤が列へ振り分けていたのと同じ考え）。
 *
 * - 枠「あなたの番」は **meta をまだ受け取っていないうちは0件の形で出さない**（「無い」と「まだ知らない」を分ける）。
 *   ただし枠に入る行があるなら出す ―― 行が来ている以上「まだ知らない」ではないし、出さないと黙って落とすことになる
 * - **一覧が丸ごと空なら空の一言だけ。** 枠の0件の1行と2文並べない
 * - 空の見出しは出さない（静かな日に見出しだけが縦に並ぶ）。どの見出しにも入らない状態は
 *   「そのほか」（`REST_GROUP`）へまとめる。**黙って落とさない**（サーバ側が状態を1つ足した日に、一覧から行が消えるほうが困る）
 * - 開け閉めする束（`foldable`。いまは終了）はたたんだ形から始める（`openFolds`）
 */
export function renderList() {
  const rows = visibleRows();

  // **頭の件数は出さない。** 「稼働中 N / 表示 N」は見出しの件数と同じことを言っていた。
  // **ただし切ったことは黙らない。** サーバーは終了済みを上限（`meta.rowsMax`）で切るので、
  // 静かな日には気づかないが、終了済みが多い日には「あるはずの行が無い」になる。
  // 落ちたぶんの行き先（書庫）まで添える ―― 数だけ出しても次の手が分からない。
  // 鍵に関わらず進める（`textContent` を差し替えるだけなので節点は消えない）
  const omitted = store.meta?.endedOmitted ?? 0;
  dom.listCount.textContent = omitted > 0 ? `終了済み ${omitted} 件は書庫へ` : '';

  // **顔ぶれも状態も題も変わっていなければ、節点に触らない。**
  //
  // ここは SSE の push（2秒ごと）で呼ばれる。`replaceChildren()` で毎回作り直すと、
  // - スクロール位置が先頭へ飛ぶ
  // - 焦点を持っていた `.row` が破棄されて `body` へ落ちる
  //   ―― `main.js` の上下キーは焦点が `.row` の中にあることが前提なので、
  //   **矢印キーが push と push の間（〜2秒）しか使えなくなる**
  //
  // 経過時間と「いま何をしているか」は `refreshTimes()` が、選んでいる印は `select()` が、
  // どちらも節点を作り直さずに書き替える。
  const grouped = rows.length ? groupRows(rows) : null;
  const key = listKey(grouped);
  if (key === listStamp) return;
  listStamp = key;

  // 組み直すと中のボタン（開け閉め）の節点も替わる。焦点を名前で控えておき、出口で拾い直す
  const refocus = document.activeElement?.dataset?.refocus ?? null;
  dom.list.replaceChildren();

  if (!grouped) {
    const li = el('li');
    li.append(el('div', 'empty', store.onlyLive
      ? '稼働中のセッションはありません'
      : 'セッションが見つかりません'));
    dom.list.append(li);
  } else {
    const { yours, pinned, groups, rest } = grouped;
    const total = yoursTotal(yours);
    if (store.meta || total > 0) dom.list.append(buildYours(yours, total));
    // **ピンを付けた行は、枠に入らないかぎり「ピン留め」にまとめる**（段8。作者の判断）。
    // 状態の見出しからは外してある（同じ行が2か所に出ると aria-current も二重になる）
    if (pinned.length) dom.list.append(buildGroup(PINNED_GROUP, pinned));
    for (const { group, rows: list } of groups) {
      if (list.length) dom.list.append(buildGroup(group, list));
    }
    if (rest.length) dom.list.append(buildGroup(REST_GROUP, rest));
  }

  // 消えていれば何もしない。探すのは一覧の中だけ（ほかの場所の data-refocus へ焦点を奪いに行かない）
  if (refocus) dom.list.querySelector(`[data-refocus="${CSS.escape(refocus)}"]`)?.focus();
}

/**
 * 左のレールの作業台の札に、止まっているものの数を出す。
 *
 * バッジ（数字）と札の名前（aria-label と吹き出し）を**同じ数から**書く。
 * 数字は飾りなので読み上げに乗せず（aria-hidden）、件数は札の名前が言う。
 *
 * **どの状態が止まっているかを画面側に持たない。** `meta.stateBlocking` から引く
 * （判断は nav.js の blockingCount）。名前の接頭辞（`needs`）で見ると、
 * 接頭辞の違う状態を1つ足した日にここだけ古くなる。
 *
 * **一覧の枠「あなたの番」の件数とは別の数。** 枠は返信待ちも入れる（ボールの所在）が、
 * ここは止まっているもの（答えないと1行も進まないもの）だけを数える。
 * 札の名前が「止まっているもの N 件」と言っているので、2つの数は食い違わない。
 *
 * **0 件のときは数字を出さず、名前で「ありません」と言う。**
 * **meta を受け取る前は件数の言葉を付けない**（「無い」ではなく「まだ知らない」）。
 *
 * 書庫・数値のあいだも呼ぶ（stream.js の apply）。一覧の枠はそのあいだ見えないので、
 * どのモードからでも「誰かが待っている」が見える唯一の合図になる。
 */
export function renderRailBadge() {
  const n = blockingCount(store.meta?.counts, store.meta?.stateBlocking);
  dom.railBadge.hidden = !n;
  dom.railBadge.textContent = n ? String(n) : '';
  dom.modeWork.setAttribute('aria-label', workName(n));
  dom.modeWork.dataset.tip = workTip(n);
}

/* ── 枠の使用率（左のレールに1つだけ） ───────────────────────────── */

/** 同じ字なら組み直さない。1秒ごとに呼ばれるので、印で止める（fillSlash と同じ作法） */
let rateKey = null;

/**
 * 枠の使用率を左のレールの輪に出す。
 *
 * **アカウント共通の値なので、画面に1つだけ。** セッションごとの詳細には出さない。
 * 同じ数がいくつも並ぶうえ、「この実行が使った枠」だと読めてしまうため。
 *
 * 出どころは実行の stdout に流れる `rate_limit_event` だけで、
 * 会話ログにも `~/.claude` の下にも無い（実測 2.1.245）。
 * だから**この画面から起こした実行が1本も無ければ何も出ない。**
 * ターミナルで動かしているだけの人には、今までどおり1ドットも変わらない。
 *
 * 何を出すか（輪の長さ・色の段・真ん中の数・名前）は runs.js の純関数（rateView → ringView）が決め、
 * 輪を組むのは usage-chart.js の rateRing（説明モーダルの凡例と同じ部品）。ここは置くだけ。
 */
export function renderRate() {
  const v = ringView(rateView(newestRateLimit(), Date.now()));

  if (v === null) {
    rateKey = null;
    dom.rate.hidden = true;
    dom.rate.replaceChildren();
    dom.rate.removeAttribute('aria-label');
    delete dom.rate.dataset.tip;
    return;
  }

  // 色の段も鍵に混ぜる。字は丸めた百分率なので、79.6% → 80.0% のように
  // 字が同じ「80」のまま黄色の段を跨ぐと、混ぜないと色が古いまま残る。
  // 名前（label）には何分前かが入るが、分より細かくならないので毎秒は動かない
  const part = (r) => (r ? `${r.ratio}:${r.tone}` : '-');
  const key = [part(v.five), part(v.seven), v.peak, v.stale, v.label].join('|');
  if (rateKey === key) return;
  rateKey = key;

  dom.rate.replaceChildren(rateRing(v));
  // 押せない絵（role="img"）なので、名前は aria-label が持つ。目で読む名前は吹き出し（data-tip）。
  // **title は付けない**（吹き出しと OS の札が二重に出る）
  dom.rate.setAttribute('aria-label', v.label);
  dom.rate.dataset.tip = v.label;
  dom.rate.hidden = false;
}

/**
 * 経過時間と「いま何をしているか」の表示だけを進める。作り直さないのでスクロール位置が動かない。
 *
 * **一覧は鍵が変わるまで組み直さない**（`listKey`）ので、時刻を動かす場所はここしかない。
 * 忘れると経過が固まったままになる。
 *
 * 引く先は一覧だけでよい。書庫のカードは終わったものなので経過時間が動かない
 */
export function refreshTimes() {
  // 枠の使用率も時間で見え方が変わる（但し書きが増える・空く時刻を跨ぐ）。
  // 印で止めてあるので、変わらないうちは組み直さない
  renderRate();

  const byId = new Map(store.rows.map((r) => [r.sessionId, r]));
  // 圧縮した行（枠「あなたの番」の中の行も含む）。経過は右の端の .m に入っている。
  // 一覧に入るのは行だけ（カードは書庫と数値のもので、あちらの経過は動かない）
  for (const node of dom.list.querySelectorAll('.row')) {
    const row = byId.get(node.dataset.sessionId);
    if (!row) continue;
    const idle = node.querySelector('.m');
    if (idle) {
      idle.textContent = agoText(row);
      // 追記が進めば実時刻も動く。textContent だけ直すと title が古いままになる
      if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
    }
    // 動いている行の「いま何をしているか」も、組み直さずに文字だけ差し替える
    const now = node.querySelector('.now');
    if (now) paintNow(now, row);
  }
  const detailIdle = dom.detail.querySelector('[data-live-idle]');
  if (detailIdle) {
    // 一覧に無いセッション（?session= で直に開いたもの）は詳細から引く。
    // byId だけを見ていると、そこで経過時間が凍る
    const id = detailIdle.dataset.liveIdle;
    const head = byId.get(id) ?? headOf(id);
    if (head) {
      detailIdle.textContent = since(idleOf(head));
      if (head.lastActivityAt) detailIdle.title = stamp(head.lastActivityAt);
    }
  }
}
