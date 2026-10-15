/* 稼働中の一覧（左のペイン）と、上のバーのまとめ。
 *
 * 層6。押されたときに select（session.js）と setListOpen（drawer.js）を呼ぶ。
 * setListOpen が drawer.js に居るのは、main.js に置くとここと循環するため。
 */
import { el, since, stamp, tokens, agentTag } from './util.js';
import {
  store, colorOf, toneOf, QUIET_MODES, SUMMARY_ORDER, STATE_GROUPS, HERO_STATES, LS,
} from './store.js';
import { dom } from './dom.js';
import { idleOf, headOf, visibleRows } from './rows.js';
import { newestRateLimit, rateView, runFor } from './runs.js';
import { closeListAfterPick } from './drawer.js';
import { select } from './session.js';
import { cardShell, cardTitle, closeCardMeta, metaBranch, metaPath } from './card.js';
import { postJson } from './api.js';
import { icon } from './icons.js';

/**
 * 一覧の1枚。
 *
 * **書庫（archive.js）も、押されたあとの後始末だけを差し替えて借りられる形にしてある。**
 * 見た目を新しく作らないための export（借り手は監視盤だったが、あれは畳んだ）。
 *
 * @param {object} row 一覧の行
 * @param {?function} onPick 押されたあとの後始末。既定（null）は引き出しを畳む
 * @returns {HTMLElement} <li> に入れたカード
 */
export function buildCard(row, onPick = null) {
  const { li, card } = cardShell(row);
  card.style.setProperty('--state-color', colorOf(row.state));

  const top = el('div', 'card-top');
  const state = el('span', 'state', row.stateLabel);
  // 点の形も状態で変える。**色だけに頼らない**（強調のテラコッタと --hot が近いため）。
  // 形の割り当ては色と同じ表（STATE_TONE）から引くので、2箇所に書かずに済む
  state.dataset.s = toneOf(row.state);
  // 判定に自信が無いものは印を付ける。断定して外すより、迷っていると伝えたほうが役に立つ
  if (row.stateConfident === false) state.dataset.guess = 'true';
  // 予算切れは点ではなく「$」の印にする。一覧では `awaiting-reply`（あなたの番）の
  // 位置に置いていて色も同じなので、印が無いと札の文字を読むまで見分けが付かない。
  // 台帳の状態は overlay / synthRow が row.run に丸ごと写している
  if (row.run?.state === 'budget') state.dataset.mark = 'budget';
  top.append(state);
  if (row.name && row.name !== row.title) top.append(el('span', 'tag', row.name));
  const idle = el('span', 'idle', since(idleOf(row)));
  // 「3時間20分」だけでは、それが今日の何時なのかが分からない。実時刻は乗せたときだけ出す
  if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
  top.append(idle);
  card.append(top);

  card.append(cardTitle(row, row.title ?? '（まだ指示なし）'));

  if (row.waitingFor) {
    const wait = el('div', 'waiting');
    wait.append(el('span', 'tool', row.waitingFor.tool));
    if (row.waitingFor.detail) wait.append(el('span', 'detail', row.waitingFor.detail));
    card.append(wait);
  }

  // 一覧のタグは「読み方が変わる情報」だけに絞る。
  // 全行に同じ値が並ぶタグ（既定の権限モード・同じモデル）はノイズになるので出さない。
  // モデルや思考量は詳細ビュー側で見せる
  const meta = el('div', 'card-meta');
  // この画面から起こしたセッションだけの印。
  // ターミナルの窓がどこにも無いので、「前面に出す」を押しても何も起きない。
  // そこを開く前に知らせるためのタグで、読み方がいちばん変わる情報だから先頭に置く
  if (row.origin === 'deck') {
    const deck = el('span', 'tag is-deck', 'この画面');
    deck.title = 'この画面の実行フォームから起こしたセッションです';
    meta.append(deck);
  }
  meta.append(...[metaPath(row), metaBranch(row)].filter(Boolean));
  if (row.permissionMode && !QUIET_MODES.has(row.permissionMode)) {
    const tag = el('span', 'tag', row.permissionMode);
    if (row.permissionMode === 'plan') tag.classList.add('is-plan');
    meta.append(tag);
  }
  for (const skill of row.skills ?? []) {
    meta.append(el('span', 'tag is-skill', `/${skill.skill}`));
  }
  // 誰かに任せて進めたセッションかどうかは、開く前に見えたほうが読み方が変わる
  const agents = agentTag(row.subagentCount);
  if (agents) meta.append(agents);
  const ctx = tokens(row.contextTokens);
  if (ctx) meta.append(el('span', 'tag', `ctx ${ctx}`));
  closeCardMeta(card, meta);

  card.addEventListener('click', () => {
    select(row.sessionId);
    // 後始末を借り手が持っているならそちらへ渡す（書庫は作業台へ移る）
    if (onPick) {
      onPick(row);
      return;
    }
    // 引き出しは選ぶために開くもの。選び終わったら用済みなので閉じて詳細に場所を渡す。
    // 同じものを選び直したときも閉じたいので、select の中ではなくここに置く
    closeListAfterPick(dom.detail);
  });
  li.append(card);
  return li;
}

/**
 * 状態の見出しと、その配下のカードを1かたまりにする。
 *
 * 見出しの形は監視盤の列の頭（`.col-head`）から借りている。点・名前・件数の並びも
 * 太さも同じで、違うのは横に置くか縦に置くかだけ。
 *
 * **かたまりで包むのは sticky のため。** 見出しをカードと同じ高さに並べると、
 * 貼り付く範囲が一覧の全体になり、**4本の見出しが上端で積み重なる**（実測）。
 * 内側の `<ul>` に入れておけば、次のかたまりが来たときに前の見出しを押し出す。
 *
 * @param {object} group STATE_GROUPS の1つ（`label` と `states` を使う）
 * @param {object[]} rows そこに入る行
 * @param {number} [limit] 最初に出す件数。超えたぶんは「残り N 件を出す」で開く
 * @returns {HTMLElement} `<li>` に入れたかたまり
 */
function buildGroup(group, rows, limit = Infinity) {
  const li = el('li', 'group');
  // 色は状態から引く。見出しのために新しい色を作らない
  li.style.setProperty('--state-color', colorOf(group.states[0]));

  const head = el('div', 'group-head');
  const mark = el('span', 'state');
  mark.dataset.s = toneOf(group.states[0]);
  head.append(mark, el('span', null, group.label));
  // 0 のときも 0 と書く。数を消すと「見ていない」と「無い」が同じに見える
  head.append(el('span', 'n', String(rows.length)));
  li.append(head);

  const body = el('ul', 'group-body');
  // **カードではなく圧縮した行。** 答えないと進まないものは上の帯が持っていったので、
  // ここの役目は「全体が一度に見えること」に変わった
  for (const row of rows.slice(0, limit)) body.append(buildRow(row));
  // **切ったことを黙らない。** 見出しの数は全件のまま出しているので、
  // 押せば出ることを数つきで言う（見出しの数と行の数が食い違って見えないように）
  const rest = rows.length - limit;
  if (rest > 0) {
    const more = el('li');
    const btn = el('button', 'row-more', `残り ${rest} 件を出す`);
    btn.type = 'button';
    const firstHidden = rows[limit]?.sessionId ?? '';
    btn.addEventListener('click', () => {
      endedOpen = true;
      renderList();
      // 押したボタンは組み直しで消えるので、焦点を新しく出た最初の行へ移す
      // （キーボードで押した人の焦点が body へ落ちないように）
      const next = [...dom.list.querySelectorAll('.row')].find((n) => n.dataset.sessionId === firstHidden);
      next?.focus({ preventScroll: true });
    });
    more.append(btn);
    body.append(more);
  }
  li.append(body);
  return li;
}

/**
 * 一覧を組む。
 *
 * **並べ替えない。** store.rows はサーバ側が STATE_RANK と開始時刻で並べたものなので、
 * 上から読めば手をつける順になる。見出しは「状態が変わる位置」に差し込むだけで、
 * 比較器を画面側に持たない（監視盤が列へ振り分けていたのと同じ考え）。
 *
 * どの見出しにも入らない状態は末尾へまとめる。**黙って落とさない。**
 * サーバ側が状態を1つ足した日に、一覧から行が消えるほうが困る。
 */
/* ── ボールの所在の帯 ─────────────────────────────────────── */

/**
 * 帯へ出す行。**並べ替えない。切り出すだけ。**
 *
 * `store.rows` はサーバ側が `STATE_RANK` と開始時刻（終了済みは idleMs）で並べたものなので、
 * 前から順に拾えばそのまま「先に手をつけるべき順」になる。
 * 比較器を画面側に持つと、2箇所に並び順ができる。
 *
 * @returns {object[]}
 */
function heroRows() {
  return visibleRows().filter((r) => HERO_STATES.has(r.state));
}

/**
 * 帯を組み直すかどうかの鍵。
 *
 * **毎フレーム作り直してはいけない。** `renderList()` は 2 秒ごとに
 * `replaceChildren()` するので、同じ手で組むと**横へ送った位置が毎回先頭へ戻る**
 * ―― 「ほか N 件」を見に行った瞬間に引き戻される。
 *
 * 混ぜるのは「札の顔ぶれと、押せることが変わったか」だけ。
 * 経過時間は入れない（毎秒動くので、入れると鍵の意味が消える）。
 * あちらは `refreshTimes()` が中身だけ差し替える。
 *
 * @param {object[]} rows 帯へ出す行
 * @returns {string}
 */
function heroKey(rows) {
  return rows
    .map((r) => `${r.sessionId}:${r.state}:${runFor(r.sessionId)?.asks?.[0]?.id ?? ''}`)
    .concat(heroFolded ? 'folded' : 'open')
    .join('|');
}

/** 前に組んだときの鍵。null は「まだ一度も組んでいない」 */
let heroStamp = null;

/**
 * 帯を1行の札に畳んでいるか。**localStorage に覚える**（開き直しても畳んだまま）。
 *
 * 帯の札は1枚 180px ほどあり、「開く」で詳細へ移っても帯は残るので、
 * 詳細が画面の下の残りでしか読めなかった（実測の指摘）。
 * 開いたら畳み、待ちは1行の札として見え続ける。広げるのは「広げる」だけ。
 *
 * **新しい待ちが来ても勝手に広げない。** 読んでいる途中で詳細が 150px 下へずれる。
 * 代わりにその札だけを一度光らせる（`heroSeen`）。
 *
 * **待ちが0件になったら解く。** 次に来た待ちは広げた形で出す ―― 静かなところへ
 * 来た1件目は、いちばん目に入ってほしいもの。
 */
let heroFolded = readFolded();

/** 畳んだ帯で、もう見せた札。ここに無いものが来たら一度だけ光らせる */
let heroSeen = new Set();

/**
 * 待ちのある帯を一度でも組んだか。**読み込み直した直後の1回は光らせない。**
 * 畳んだまま開き直すと heroSeen は空なので、全部の札が「新しい」に見えてしまう
 */
let heroPrimed = false;

/** localStorage は人が書き換えられる場所なので、'1' のときだけ畳んだと読む */
function readFolded() {
  try {
    return localStorage.getItem(LS.heroFolded) === '1';
  } catch {
    return false;
  }
}

/**
 * 畳む・広げるを切り替えて、帯を組み直す。
 * @param {boolean} on 畳むなら true
 */
function setHeroFolded(on) {
  if (heroFolded === on) return;
  heroFolded = on;
  try {
    if (on) localStorage.setItem(LS.heroFolded, '1');
    else localStorage.removeItem(LS.heroFolded);
  } catch {
    // 保存できなくても、この窓のあいだは効く
  }
  heroStamp = null;
  renderHero();
}

/**
 * 帯から1本を選んで詳細へ送る。**選ぶと帯を畳む。**
 * 広げた札の「開く」「答える」と札そのもの、畳んだ札のどれから来ても同じ。
 * @param {object} row 一覧の行
 */
function pickFromHero(row) {
  setHeroFolded(true);
  select(row.sessionId, 'live');
  closeListAfterPick();
  // 押したボタンは畳んだ組み直しで消えるので、焦点が body へ落ちる。
  // 開いた先（詳細の流れる箱。tabindex="-1"）へ移せば、そのまま読み進められる
  if (document.activeElement === document.body) dom.detail.focus({ preventScroll: true });
}

/**
 * 畳む・広げるのボタン。**1つだけ作り、帯の外（器 `.hero-wrap`）の右上に固定する。**
 *
 * 前は帯の中に置いて、畳む・広げるたびに作り直していた。帯の高さ（広げると 260px、
 * 畳むと 42px）の真ん中に来るので、押すたびにボタンが上下へ動き、
 * 続けて押すのにカーソルを追いかけることになった（実測の指摘）。
 * 位置は動かさず、向きだけを入れ替える。節点が消えないので焦点もそのまま残る。
 *
 * **字を出さずに絵（chevron）だけにする。** 開け閉めの口に字があると、
 * 帯の中の札と同じ重さで目に入って画面の情報が増える（実測の指摘）。
 * 名前は title と aria-label が持つ（アイコンだけのボタンの約束）。
 * 向きは CSS が aria-expanded から決める（上＝畳む、下＝広げる）。
 * 作るのは initHero の1回だけ。
 */
let foldBtn = null;

/** ボタンの字と aria-expanded を、いまの畳み具合に合わせる */
function syncFoldButton() {
  if (!foldBtn) return;
  const name = heroFolded ? '広げる' : '畳む';
  foldBtn.title = name;
  foldBtn.setAttribute('aria-label', `あなたの番の帯を${name}`);
  // いま広がっているか
  foldBtn.setAttribute('aria-expanded', String(!heroFolded));
}

/**
 * 帯の1枚。
 *
 * **ボタンの中身が場面で違う。** 答えられるのは画面から起こしたセッションだけで、
 * ターミナルで走っているものには答える窓口そのものが無い
 * （`asks` は `src/run/ledger.mjs` が抱える行にしか載らない）。
 * できるのは `POST /api/focus` で窓を前へ出すこと。
 *
 * **その差は「この画面から」の札の有無で示す。** 札が無いのにボタンだけ
 * 「許可する」だと、押しても何も起きないものを出すことになる。
 *
 * **要求カードをここに組まない。** 実体は `run-ask.js` の1枚に保つ
 * （2枚あると「どちらが本物か」の管理が丸ごと増える＝人が承認したものと
 * 違うものが動く事故の隣）。ここは選んで詳細ペインへ送るだけ。
 *
 * @param {object} row 一覧の行
 * @returns {HTMLElement}
 */
function buildHeroCard(row) {
  const card = el('div', 'hero-card');
  card.dataset.sessionId = row.sessionId ?? '';
  card.style.setProperty('--state-color', colorOf(row.state));
  // 選んでいる印。**帯は鍵が変わるまで組み直さない**ので、以後の付け替えは
  // `select()` が直に書く（一覧のカードと同じ扱い）
  card.setAttribute('aria-current', String(row.sessionId === store.selected));

  const top = el('div', 'hero-top');
  const state = el('span', 'state', row.stateLabel);
  state.dataset.s = toneOf(row.state);
  top.append(state);
  // この画面から起こしたものだけ、その場で答えられる
  const run = runFor(row.sessionId);
  if (run) top.append(el('span', 'tag is-deck', 'この画面から'));

  const idle = el('span', 'hero-idle', since(idleOf(row)));
  idle.dataset.heroIdle = row.sessionId ?? '';
  if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
  idle.append(el('small', null, ' 経過'));
  top.append(idle);
  card.append(top);

  card.append(el('div', 'hero-title', row.title ?? row.name ?? row.sessionId));

  if (row.waitingFor) {
    const ask = el('div', 'hero-ask');
    ask.append(el('span', 'tool', row.waitingFor.tool ?? '?'));
    if (row.waitingFor.detail) ask.append(el('span', 'cmd', row.waitingFor.detail));
    card.append(ask);
  }

  const act = el('div', 'hero-act');
  const go = el('button', 'btn is-lead', run ? '答える' : '開く');
  go.type = 'button';
  go.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pickFromHero(row);
  });
  act.append(go);

  // ターミナルで走っているものは、窓を前に出すことしかできない。
  // pid が取れていない行には出さない（押せない顔のボタンを出さない）
  if (!run && row.pid) {
    const front = el('button', 'btn', 'ターミナルを前面に');
    front.type = 'button';
    front.addEventListener('click', (ev) => {
      ev.stopPropagation();
      postJson(`/api/focus?pid=${encodeURIComponent(row.pid)}`).catch(() => {});
    });
    act.append(front);
  }
  card.append(act);

  // 札のどこを押しても選べる（ボタンは stopPropagation で先に取る）。
  //
  // **`role="button"` は付けない。** 中に本物のボタンが入っているので、
  // 押せるものの入れ子になる。キーボードから辿る道は中のボタンが持っていて、
  // これは触っている人向けの近道でしかない。
  //
  // **文字を選んでいるあいだは効かせない。** 中に出しているのは実行しようとしている
  // コマンドで、写して確かめたい場面がある。掴んで離した拍子に選び直されると、
  // 選択が消えるうえ画面まで切り替わる
  card.addEventListener('click', () => {
    if (!window.getSelection()?.isCollapsed) return;
    pickFromHero(row);
  });
  return card;
}

/**
 * 畳んだ帯の1枚。点・題・経過だけの押せる札（ピル型は押せるものの形）。
 *
 * 中身は広げた札と同じ行から作る。「答える」「ターミナルを前面に」は持たない ――
 * 押せば詳細が開き、そこに要求カード（`run-ask.js`）が居る。
 *
 * @param {object} row 一覧の行
 * @param {boolean} fresh 初めて見せる札なら true（一度だけ光らせる）
 * @returns {HTMLElement}
 */
function buildHeroChip(row, fresh) {
  const chip = el('button', 'hero-chip');
  chip.type = 'button';
  chip.dataset.sessionId = row.sessionId ?? '';
  chip.style.setProperty('--state-color', colorOf(row.state));
  chip.setAttribute('aria-current', String(row.sessionId === store.selected));
  if (fresh) chip.classList.add('is-new');
  // 何で止まっているかは字でも残す（題だけだと、承認か質問かが読めない）
  chip.title = [row.stateLabel, row.title ?? row.name].filter(Boolean).join(' ― ');

  const state = el('span', 'state');
  state.dataset.s = toneOf(row.state);
  const idle = el('span', 'hero-chip-idle', since(idleOf(row)));
  idle.dataset.heroIdle = row.sessionId ?? '';
  chip.append(state, el('span', 'hero-chip-title', row.title ?? row.name ?? row.sessionId), idle);
  chip.addEventListener('click', () => pickFromHero(row));
  return chip;
}

/**
 * ボールの所在の帯を描く。
 *
 * **件数に上限を置かない。折り返さずに横へ流す。**
 * 折り返して縦に伸ばすと、下の圧縮行（全体を見せる役目）が押し出される。
 *
 * 0 件なら帯ごと消す（`hidden`）。**黙っては消さない** ――
 * 「承認や質問で止まっているセッションはありません」を上のバーの下段が言う
 * （`renderSummary`）。帯ごと黙って消えると、静かな日に「見ていない」と
 * 「無い」が同じ顔になる。前は帯の中に1行置いていたが、下段とあわせて
 * 2段を取っていたので、言う場所を下段の1つへ寄せた。
 */
export function renderHero() {
  const rows = heroRows();
  const key = heroKey(rows);
  // 顔ぶれも押せることも変わっていなければ、節点に触らない。
  // 触ると横へ送った位置が戻る（この関数がある理由そのもの）
  if (key === heroStamp) return;
  heroStamp = key;

  dom.heroBand.replaceChildren();

  // **空のときは帯ごと消す。** 「止まっているものはありません」は
  // 上のバーの下段（renderSummary）が言う。前は帯の中に1行置いていたが、
  // 下段のすぐ下にもう1段ぶん場所を取っていた（待ちが無い時間のほうが長い）
  if (rows.length === 0) {
    dom.heroWrap.hidden = true;
    dom.heroWrap.dataset.edge = 'none';
    // 待ちが無くなったら畳みを解く。次の1件目は広げた形で出す
    heroSeen = new Set();
    if (heroFolded) setHeroFolded(false);
    return;
  }

  dom.heroWrap.hidden = false;
  if (heroFolded) {
    dom.heroWrap.dataset.fold = '';
    const label = el('span', 'hero-fold-label', `あなたの番 ${rows.length}`);
    dom.heroBand.append(label);
    for (const row of rows) dom.heroBand.append(buildHeroChip(row, heroPrimed && !heroSeen.has(row.sessionId)));
  } else {
    delete dom.heroWrap.dataset.fold;
    for (const row of rows) dom.heroBand.append(buildHeroCard(row));
  }
  // 自分で畳む・広げる口。開かずに畳みたいとき（帯が詳細を押し下げているのが邪魔なとき）にも使う
  syncFoldButton();
  // 見せた札を覚える。広げているあいだに見たものも「見た」に数える
  heroSeen = new Set(rows.map((r) => r.sessionId));
  heroPrimed = true;
  syncHeroEdge();
}

/**
 * 膜の出し入れ。**判断はここ1箇所、当てるのは CSS。**
 *
 * 出す・出さないを CSS の擬似クラスで作ろうとすると「端まで送ったか」を表せない。
 * `data-edge` の1語に畳んで渡す。
 */
function syncHeroEdge() {
  const band = dom.heroBand;
  const max = band.scrollWidth - band.clientWidth;
  // 1px の余裕を見る。端ちょうどでも小数のずれで届かないことがある
  dom.heroWrap.dataset.edge = max <= 1 ? 'none'
    : band.scrollLeft <= 1 ? 'right'
      : band.scrollLeft >= max - 1 ? 'left'
        : 'both';
}

/** 帯の膜を配線する。`main.js` から1回だけ呼ぶ。 */
export function initHero() {
  foldBtn = el('button', 'ibtn hero-fold-btn');
  foldBtn.type = 'button';
  // 形は新しく作らない。右向きの chevron を CSS で上下へ回す
  foldBtn.append(icon('chevron', 16));
  foldBtn.addEventListener('click', () => setHeroFolded(!heroFolded));
  dom.heroWrap.append(foldBtn);
  syncFoldButton();

  dom.heroBand.addEventListener('scroll', syncHeroEdge, { passive: true });
  // 窓の幅が変わると、そもそも溢れているかどうかが変わる
  window.addEventListener('resize', syncHeroEdge);
}

/* ── 一覧 ─────────────────────────────────────────────── */

/**
 * 圧縮した1行。**出すのは点・題・経過の3つだけ。**
 *
 * 帯に出ないものはここへ落とす。役目は「全体が一度に見えること」なので、
 * 置き場所もスキルも待ちの中身も出さない ―― どれも選んだときに詳細ペインで読める。
 *
 * **カード（`buildCard`）を借りない。** あちらは書庫と数値も使う定型で、
 * 出す項目が5つある。ここは4つ（点・題・置き場所・経過）に絞ることそのものが役目なので、借りると
 * 「何を出さないか」を毎回打ち消すことになる。
 *
 * @param {object} row 一覧の行
 * @returns {HTMLElement} `<li>` に入れた行
 */
function buildRow(row) {
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

  // **置き場所を題の右に薄く出す。** 書庫とコマンド入力には出ているのに、
  // ここだけ無かった。同じ題（「セキュリティレビュー」など）が並ぶと見分けられない。
  // 2行目には置かない ―― 1行が 28px から伸びて、全体が一度に見えなくなる（hero.css の .row）。
  // 取れない行も空の節点を置く（列の数を行ごとに変えない）
  const proj = el('span', 'p', row.project ?? '');
  if (row.cwd) proj.title = row.cwd;
  node.append(proj);

  const idle = el('span', 'm', agoText(row));
  if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
  node.append(idle);

  node.addEventListener('click', () => {
    select(row.sessionId, 'live');
    closeListAfterPick();
  });
  li.append(node);
  return li;
}

/**
 * 一覧の行の経過時間。**「前」を付ける。**
 *
 * 数だけだと「19時間00分」が、かかった時間なのか、どれだけ前なのかが読めない。
 * 測っているのは最後に動いてからの時間（`idleOf`）なので「前」が正しい。
 * 取れないとき（`since` が「—」を返す）は付けない。
 *
 * 帯の札（`.hero-idle`）には付けない。あちらは「待たせている長さ」で、
 * 字の後ろに「経過」が添えてある。
 *
 * @param {object} row 一覧の行
 * @returns {string}
 */
function agoText(row) {
  const t = since(idleOf(row));
  return t === '—' ? t : `${t}前`;
}

/**
 * 終了済みを最初に何件出すか。残りは「残り N 件を出す」で開く。
 *
 * 前は全部（実測 26 件）を並べていて、動いている2件が上の小さな島になっていた。
 * 全部を見たいときは押せば出るし、もっと古いものは書庫にある。
 */
const ENDED_FIRST = 5;

/**
 * 終了済みを全部出しているか。**localStorage に残さない。**
 * 開き直したら畳んだ形から始める（覚えると、いちど開いただけで既定が崩れる）。
 */
let endedOpen = false;

/**
 * 一覧を組み直すかどうかの鍵。**帯の `heroKey()` と同じ考え方。**
 *
 * 見るのは「どの行が、どの状態で、どんな題で並んでいるか」だけ。
 * 経過時間は入れない（毎秒動くので、入れると鍵の意味が消える）。
 * `store.onlyLive` を混ぜるのは、行が両方 0 件でも空のときの文言が入れ替わるため。
 *
 * @param {object[]} rows 一覧へ出す行
 * @returns {string}
 */
function listKey(rows) {
  const parts = rows.map((r) => `${r.sessionId}:${r.state}:${r.title ?? r.name ?? ''}:${r.project ?? ''}`);
  parts.push(store.onlyLive ? 'live' : 'all');
  // 畳んでいるかで出す行が変わる。混ぜないと「残りを出す」を押しても組み直されない
  parts.push(endedOpen ? 'ended-open' : 'ended-first');
  return parts.join('|');
}

/** 前に組んだときの鍵。null は「まだ一度も組んでいない」 */
let listStamp = null;

export function renderList() {
  renderHero();
  // **帯へ出したぶんは一覧から外す。** 同じセッションが2箇所に出ると、
  // 選んだときの aria-current も二重になる
  const rows = visibleRows().filter((r) => !HERO_STATES.has(r.state));

  // 件数は鍵に関わらず進める。`textContent` を差し替えるだけなので節点は消えない
  const live = store.rows.filter((r) => r.alive).length;
  // **切られたことを言う。** サーバーは終了済みを上限（`meta.rowsMax`）で切るので、
  // 静かな日には気づかないが、終了済みが多い日には「あるはずの行が無い」になる。
  // 落ちたぶんの行き先（書庫）まで添える ―― 数だけ出しても次の手が分からない
  const omitted = store.meta?.endedOmitted ?? 0;
  dom.listCount.textContent = omitted > 0
    ? `稼働中 ${live} / 表示 ${rows.length}（終了済み ${omitted} 件は書庫へ）`
    : `稼働中 ${live} / 表示 ${rows.length}`;

  // **顔ぶれも状態も題も変わっていなければ、節点に触らない。**
  //
  // ここは SSE の push（2秒ごと）で呼ばれる。`replaceChildren()` で毎回作り直すと、
  // - スクロール位置が先頭へ飛ぶ
  // - 焦点を持っていた `.row` が破棄されて `body` へ落ちる
  //   ―― `main.js` の上下キーは焦点が `.row` の中にあることが前提なので、
  //   **矢印キーが push と push の間（〜2秒）しか使えなくなる**
  //
  // 帯（`renderHero`）は先に同じ手当てをしてあり、その隣で一覧だけが素朴に
  // 作り直していた。乗るための土台は既に揃っている ――
  // 経過時間は `refreshTimes()` が、選んでいる印は `select()` が、
  // どちらも節点を作り直さずに書き替える。
  const key = listKey(rows);
  if (key === listStamp) return;
  listStamp = key;

  dom.list.replaceChildren();

  if (rows.length === 0) {
    const li = el('li');
    li.append(el('div', 'empty', store.onlyLive
      ? '稼働中のセッションはありません'
      : 'セッションが見つかりません'));
    dom.list.append(li);
  } else {
    // 見出しごとに仕分ける。順番は STATE_GROUPS が決める
    const bins = new Map(STATE_GROUPS.map((g) => [g.id, []]));
    const rest = [];
    for (const row of rows) {
      const g = STATE_GROUPS.find((x) => x.states.includes(row.state));
      if (g) bins.get(g.id).push(row);
      else rest.push(row);
    }

    for (const g of STATE_GROUPS) {
      const list = bins.get(g.id);
      // 空の見出しは畳む。ただし「あなたの番」だけは 0 でも残す
      if (list.length === 0 && !g.keepEmpty) continue;
      const group = buildGroup(g, list, g.id === 'done' && !endedOpen ? ENDED_FIRST : Infinity);
      dom.list.append(group);
    }
    if (rest.length) {
      dom.list.append(buildGroup({ label: 'そのほか', states: ['unknown'] }, rest));
    }
  }
}

export function renderSummary() {
  dom.summary.replaceChildren();
  const counts = store.meta?.counts ?? {};
  // ラベルはサーバ側の STATE_LABELS。まだ受け取っていない間はキーをそのまま出す
  const labels = store.meta?.stateLabels ?? {};
  // **「答えないと1行も進まないか」も画面側に持たない。** サーバの表から引く。
  // 前は key.startsWith('needs') で見ていたが、あれは名前の付け方への当て推量で、
  // 接頭辞の違う状態を1つ足した日にここだけ古くなる（行の blocking と同じ出どころに揃える）
  const blocking = store.meta?.stateBlocking ?? {};

  // **止まっているものが無ければ、まずそう言う。** 上の帯は空のとき丸ごと消えるので
  // （renderHero）、「見ていない」と「無い」を分ける役目をここが持つ。
  // 言うのは帯が見ているもの（止まっているもの）だけ。返信待ちは後ろの数に出るので、
  // 「返事を待っているものはありません」と言って数と食い違わせない
  // **meta を受け取る前は言わない。** counts が空のうちは「無い」ではなく「まだ知らない」。
  // セッションが1本も無いときも言わない（下の「動いているセッションなし」と2文が並ぶ）
  // 数えるのは下で数を出す状態（SUMMARY_ORDER）だけ。知らない状態まで数えると、
  // それしか居ないときに「動いているセッションなし」と2文が並ぶ
  const any = SUMMARY_ORDER.some((k) => (counts[k] ?? 0) > 0);
  if (any && !SUMMARY_ORDER.some((k) => blocking[k] && (counts[k] ?? 0) > 0)) {
    const calm = el('span', 'tally is-calm');
    calm.append(el('span', 'calm-dot'), document.createTextNode('承認や質問で止まっているセッションはありません'));
    dom.summary.append(calm);
  }

  for (const key of SUMMARY_ORDER) {
    const n = counts[key] ?? 0;
    if (n === 0) continue;
    const label = labels[key] ?? key;
    const item = el('span', 'tally');
    // 点だけを出す。`.state` は色を --state-color から取るが、
    // ここは点1つなので color を直に置く（インラインなので変数より先に効く）
    const dot = el('span', 'state');
    dot.style.color = colorOf(key);
    dot.dataset.s = toneOf(key);
    item.append(dot, document.createTextNode(label), el('strong', null, n));
    if (blocking[key]) item.classList.add('is-hot');
    dom.summary.append(item);
  }
  // 数が1つも出なかったときだけ。止まっていない、の1行は数ではないので数えない
  if (!dom.summary.querySelector('.tally:not(.is-calm)')) {
    dom.summary.append(el('span', 'tally', '動いているセッションなし'));
  }
}

/* ── 枠の使用率（上のバーに1つだけ） ───────────────────────────── */

/** 同じ文字なら組み直さない。1秒ごとに呼ばれるので、印で止める（fillSlash と同じ作法） */
let rateKey = null;

/**
 * 枠の使用率を上のバーに出す。
 *
 * **アカウント共通の値なので、画面に1つだけ。** セッションごとの詳細には出さない。
 * 同じ数がいくつも並ぶうえ、「この実行が使った枠」だと読めてしまうため。
 *
 * 出どころは実行の stdout に流れる `rate_limit_event` だけで、
 * 会話ログにも `~/.claude` の下にも無い（実測 2.1.245）。
 * だから**この画面から起こした実行が1本も無ければ何も出ない。**
 * ターミナルで動かしているだけの人には、今までどおり1ドットも変わらない。
 */
export function renderRate() {
  // 何を出すかを決めるのは runs.js の純関数。ここは組み立てるだけ
  const v = rateView(newestRateLimit(), Date.now());

  if (v === null) {
    rateKey = null;
    dom.rate.hidden = true;
    dom.rate.replaceChildren();
    return;
  }

  // 色の段も鍵に混ぜる。字は丸めた百分率なので、79.6% → 80.0% のように
  // 字が同じ「80%」のまま黄色の段を跨ぐと、混ぜないと色が古いまま残る
  const key = [v.fiveHour, v.sevenDay, v.age, v.hot, ...v.meters.map((m) => m.tone)].join('|');
  if (rateKey === key) return;
  rateKey = key;

  const box = el('span', 'rate-val');
  if (v.hot) box.classList.add('is-hot');
  box.append(document.createTextNode('枠'));
  // **数だけでなく長さで見せる。** 前は「5h:42%」の 11px の字だけで、
  // 上限が近づいても目に入らなかった。色の段（黄・赤）は rateView が決める。
  // 棒の長さは style.width で直に入れる（CSS 変数にすると screen.test の FROM_JS に足す口が増える）
  for (const m of v.meters) {
    const meter = el('span', 'rate-meter');
    if (m.tone) meter.dataset.tone = m.tone;
    const fill = el('i');
    fill.style.width = `${Math.round(m.ratio * 100)}%`;
    const bar = el('span', 'rate-bar');
    bar.append(fill);
    meter.append(el('span', 'rate-label', m.label), bar, el('strong', null, m.text));
    box.append(meter);
  }
  if (v.age) box.append(el('span', 'rate-age', v.age));

  const note = [`測ったのは ${stamp(v.at)}`];
  if (v.resetsAt !== null) {
    note.push(v.gone
      ? '5時間枠は空いたはず（新しい数はまだ届いていません）'
      : `5時間枠が空くのは ${stamp(v.resetsAt)}`);
  }
  box.title = note.join(' / ');

  dom.rate.replaceChildren(box);
  dom.rate.hidden = false;
}

/**
 * 経過時間の表示だけを進める。作り直さないのでスクロール位置が動かない。
 *
 * 引く先は一覧だけでよい。書庫のカードは終わったものなので経過時間が動かない
 */
export function refreshTimes() {
  // 枠の使用率も時間で見え方が変わる（但し書きが増える・空く時刻を跨ぐ）。
  // 印で止めてあるので、変わらないうちは組み直さない
  renderRate();

  const byId = new Map(store.rows.map((r) => [r.sessionId, r]));
  // カード（書庫が借りる形）と、圧縮した行。どちらも経過は最後の子に入っている
  for (const node of dom.list.querySelectorAll('.card, .row')) {
    const row = byId.get(node.dataset.sessionId);
    if (!row) continue;
    const idle = node.querySelector('.idle, .m');
    if (idle) {
      // 一覧の行（.m）だけ「前」を付ける。書庫のカード（.idle）は今までどおり
      idle.textContent = idle.classList.contains('m') ? agoText(row) : since(idleOf(row));
      // 追記が進めば実時刻も動く。textContent だけ直すと title が古いままになる
      if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
    }
  }
  // **帯もここで動かす。** あちらは鍵が変わるまで組み直さない作りなので、
  // 時刻を差し替える場所がここしかない。忘れると経過が固まったままになる。
  // 「経過」の字は <small> で中に入っているので、textContent ごと書き替えずに
  // 先頭のテキスト節点だけ差し替える
  for (const node of dom.heroBand.querySelectorAll('[data-hero-idle]')) {
    const row = byId.get(node.dataset.heroIdle);
    if (!row) continue;
    if (node.firstChild) node.firstChild.nodeValue = since(idleOf(row));
    if (row.lastActivityAt) node.title = stamp(row.lastActivityAt);
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
