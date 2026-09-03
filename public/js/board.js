/* 監視盤モード（一覧を主役にした列表示）と、モードの切り替え。
 *
 * setMode がこのファイルにあるのは歴史の産物で、モードが2つ（作業台・監視盤）
 * だったときにここへ置いた。3つ目（数値）が増えたが、**ファイルは割らない。**
 * 割ると palette.js と stream.js の import 先も動かすことになり、
 * 得るものが「名前の一致」だけになる。
 *
 * 数値モードの中身は usage-tab.js（同じ層7）が持つ。こちらは import しない。
 * 出すときに呼ぶものを initBoard({ onUsage }) で外から受け取る形にしてある
 * （runs.js の subscribeRuns(fn) と同じ切り方。配線するのは main.js）。
 *
 * 層7。「どれから手をつけるか」だけを見る画面で、作業台とは**モードとして分ける**。
 * 同居させると同じ画面で場所を取り合う。それがこの組み替えの発端そのものなので、
 * 片方を見ているあいだ、もう片方は丸ごと消す（board.css の .is-board）。
 *
 * 描くものは自分で作らない。カードは list.js の buildCard を借り、
 * 列の色は STATE_COLOR から引く。**見た目を新しく作らない**（run-form.js が
 * 設定モーダルのクラスを借りたのと同じ理由）。
 *
 * 並べ替えもしない。store.rows はサーバー側が STATE_RANK と idleMs で並べたものなので、
 * 順に振り分ければ列の中も正しい順になる（比較器を2箇所に書かない）。
 */
import { el } from './util.js';
import { dom, store, MODES, STATE_COLOR, syncQuery } from './store.js';
import { closeListAfterPick } from './drawer.js';
import { renderDetailIfNeeded } from './detail.js';
import { loadDetail } from './session.js';
import { buildCard, renderList } from './list.js';

/** 数値モードに入ったときに呼ぶもの。main.js が showUsage を差す */
let onUsage = null;

/**
 * 列の並び。左から手をつける順（src/parse/state.mjs の STATE_RANK と同じ考え）。
 *
 * 色は states の先頭から STATE_COLOR で引く。列のために新しい色を作らない。
 * note は列そのものの読み方で、列の中がどれだけ動いても位置が変わらないよう下端に置く。
 */
const COLUMNS = [
  {
    id: 'hot',
    label: 'あなたの番',
    states: ['needs-answer', 'needs-plan-approval', 'needs-approval'],
    note: '止まっている。ここが空になるまで、右の列は見なくていい',
  },
  {
    id: 'run',
    label: '実行中',
    states: ['running'],
    note: 'こちらから手を出す必要が無い列。数だけ見て素通りする',
  },
  {
    id: 'reply',
    label: '返信待ち',
    states: ['awaiting-reply'],
    note: '返事は返っている。急ぎでなければ後回しでいい',
  },
  {
    id: 'done',
    label: '直近に終わったもの',
    states: ['ended'],
    note: '続きを起こせるのはこの列。押して、下の入力欄から',
  },
];

/**
 * 1列を組む。
 *
 * @param {object} col COLUMNS の1つ
 * @param {object[]} rows その列に入る行
 * @returns {HTMLElement} 列
 */
function buildColumn(col, rows) {
  const box = el('section', 'col');

  const head = el('div', 'col-head');
  // 状態の点は一覧のカードと同じ借り方。色は必ず CSS 変数経由で取る
  const dot = el('span', 'state');
  dot.style.setProperty('--state-color', STATE_COLOR[col.states[0]] ?? 'var(--off)');
  // 0 のときも 0 と書く。数を消すと「見ていない」と「無い」が同じに見える
  head.append(dot, el('span', null, col.label), el('span', 'n', String(rows.length)));
  box.append(head);

  // <ul> にしておけば buildCard の返り値（<li> 入りのカード）をそのまま置ける
  const body = el('ul', 'col-body');
  if (!rows.length) body.append(el('li', 'col-empty', 'なし'));
  // 押したら作業台へ移る。引き出しを畳む既定の後始末はここでは要らない
  else for (const row of rows) body.append(buildCard(row, () => setMode('work')));
  box.append(body);

  box.append(el('p', 'col-note', col.note));
  return box;
}

/**
 * 列を組み直す。
 *
 * **onlyLive は見ない。** 絞ると4列目（終わったもの）が丸ごと消える。
 * 一覧（/api/sessions）は終了ぶんを24時間持っているので、絞る前の store.rows を
 * 直に見れば足りる。それより古いものは書庫タブの仕事なので、ここでは引かない。
 */
export function renderBoard() {
  if (store.mode !== 'board') return;

  const rows = store.rows ?? [];
  const bins = new Map(COLUMNS.map((c) => [c.id, []]));
  const rest = [];
  for (const row of rows) {
    const col = COLUMNS.find((c) => c.states.includes(row.state));
    if (col) bins.get(col.id).push(row);
    else rest.push(row);
  }

  dom.board.replaceChildren(...COLUMNS.map((c) => buildColumn(c, bins.get(c.id))));
  dom.boardCount.textContent = String(rows.length);
  // **列に入らなかったぶんは必ず数を出す。** 黙って落とすと、サーバー側が状態を1つ
  // 足した日に「一覧の件数と列の合計が食い違う」だけになり、どこへ消えたか分からない。
  // 0 と不明を分けるのと同じ扱いで、行き先（作業台の一覧）まで添えておく
  dom.boardRest.hidden = rest.length === 0;
  dom.boardRest.textContent = rest.length ? `ほかに ${rest.length} 件（一覧で見る）` : '';
}

/**
 * モードを切り替える。
 *
 * 押した状態の正は aria-pressed 1つ（.list-tabs と同じ流儀）。
 * 開き方の指定を URL に残すので、監視盤や数値のままブックマークできる。
 *
 * 3つになったので「監視盤かどうか」の二値では書けない。
 * 出す側を1つ選んで残りは全部隠す形にする（setTab がタブ3枚でやったのと同じ）。
 *
 * @param {string} mode MODES のどれか。知らない値は 'work' に落とす
 * @param {object} [opts]
 * @param {boolean} [opts.sync] URL を書き換えるか（起動時だけ false）
 */
export function setMode(mode, { sync = true } = {}) {
  const next = MODES.has(mode) ? mode : 'work';
  // 実際に替わったかを先に測る。起動時と押し直しで作業台を描き直さないため
  const changed = store.mode !== next;
  store.mode = next;
  const board = next === 'board';
  const usage = next === 'usage';

  // 目印は .app に付ける（.is-list-open と同じ流儀）。骨格の組み替えは
  // board.css の .is-board と usage.css の .is-usage が受け持つ
  dom.app.classList.toggle('is-board', board);
  dom.app.classList.toggle('is-usage', usage);
  dom.modeWork.setAttribute('aria-pressed', String(next === 'work'));
  dom.modeBoard.setAttribute('aria-pressed', String(board));
  dom.modeUsage.setAttribute('aria-pressed', String(usage));
  dom.boardHead.hidden = !board;
  dom.board.hidden = !board;
  dom.usageHead.hidden = !usage;
  dom.usage.hidden = !usage;
  if (sync) syncQuery();

  if (board || usage) {
    // 引き出しを開けっぱなしにしない。一覧そのものが消えるので、
    // 開いたままだと中身の無い紙と膜だけが画面に残る
    closeListAfterPick();
    // 監視盤は毎秒の push でも描き直す（apply() が呼ぶ）が、数値は開いたときだけ。
    // 引くのは /api/usage（ログを全文読む）なので、見ているあいだ撃ち続けない
    if (board) renderBoard();
    else onUsage?.();
    return;
  }

  // 監視盤と数値のあいだ、中央と左は描いていない（apply() が飛ばしている）ので、
  // 戻るときに追いつかせる。**替わったときだけ。** 起動時や押し直しでも払うと、
  // 作業台で「作業台」を押すたびに開いた <details> と打ちかけの文が消える
  if (!changed) return;
  if (store.meta) renderList();
  renderDetailIfNeeded();
  // カードから来たときは select() も撃つので fetch が2本になる。1本目は detailToken が
  // 捨てるだけの無駄だが、**それでも撃つ。** 撃たないと、選び直し（select() が早期 return
  // する経路）で戻ったときに監視盤のあいだ止めていた分がそのまま出て、次の push まで
  // 2秒古い内容を見せることになる。見える遅れより見えない1本を取る
  loadDetail(store.selected, { silent: true });
}

/**
 * 配線。main.js から1回だけ呼ぶ。
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onUsage] 数値モードに入ったときに呼ぶもの。
 *   usage-tab.js の showUsage を差す（**こちらから import しない。**
 *   同じ層7 なので、向きを持たせずに済む形を選ぶ）
 */
export function initBoard({ onUsage: fn = null } = {}) {
  onUsage = fn;
  dom.modeWork.addEventListener('click', () => setMode('work'));
  dom.modeBoard.addEventListener('click', () => setMode('board'));
  dom.modeUsage.addEventListener('click', () => setMode('usage'));
  // 列に入らなかったぶんの逃げ道。作業台の一覧へ移すだけ
  dom.boardRest.addEventListener('click', () => setMode('work'));
  // ?mode=board や ?mode=usage で開いたときのために1回当てる。起動時に URL は書き換えない
  setMode(store.mode, { sync: false });
}
