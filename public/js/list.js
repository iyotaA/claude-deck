/* 稼働中の一覧（左のペイン）と、上のバーのまとめ。
 *
 * 層6。押されたときに select（session.js）と setListOpen（drawer.js）を呼ぶ。
 * setListOpen が drawer.js に居るのは、main.js に置くとここと循環するため。
 */
import { el, since, stamp, tokens, agentTag } from './util.js';
import { dom, store, STATE_COLOR, QUIET_MODES, SUMMARY_ORDER } from './store.js';
import { idleOf, headOf, visibleRows } from './rows.js';
import { newestRateLimit, rateView } from './runs.js';
import { closeListAfterPick } from './drawer.js';
import { select } from './session.js';

/**
 * 一覧の1枚。
 *
 * **監視盤（board.js）も同じものを借りる。** 見た目を新しく作らないための export で、
 * 違うのは押されたあとの後始末だけなので、そこだけ差し替えられる形にしてある。
 *
 * @param {object} row 一覧の行
 * @param {?function} onPick 押されたあとの後始末。既定（null）は引き出しを畳む
 * @returns {HTMLElement} <li> に入れたカード
 */
export function buildCard(row, onPick = null) {
  const li = el('li');
  const card = el('button', 'card');
  card.type = 'button';
  card.style.setProperty('--state-color', STATE_COLOR[row.state] ?? 'var(--off)');
  card.setAttribute('aria-current', String(row.sessionId === store.selected));
  card.dataset.sessionId = row.sessionId ?? '';

  const top = el('div', 'card-top');
  const state = el('span', 'state', row.stateLabel);
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

  const title = el('div', 'card-title', row.title ?? '（まだ指示なし）');
  if (!row.title) title.classList.add('is-empty');
  card.append(title);

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
  if (row.project) meta.append(el('span', 'path', row.project));
  if (row.gitBranch && row.gitBranch !== 'HEAD') meta.append(el('span', 'tag', row.gitBranch));
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
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    select(row.sessionId);
    // 後始末を借り手が持っているならそちらへ渡す（監視盤は作業台へ移る）
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

export function renderList() {
  const rows = visibleRows();
  dom.list.replaceChildren();

  if (rows.length === 0) {
    const li = el('li');
    li.append(el('div', 'empty', store.onlyLive
      ? '稼働中のセッションはありません'
      : 'セッションが見つかりません'));
    dom.list.append(li);
  } else {
    for (const row of rows) dom.list.append(buildCard(row));
  }

  const live = store.rows.filter((r) => r.alive).length;
  dom.listCount.textContent = `稼働中 ${live} / 表示 ${rows.length}`;
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
  for (const key of SUMMARY_ORDER) {
    const n = counts[key] ?? 0;
    if (n === 0) continue;
    const label = labels[key] ?? key;
    const item = el('span', 'tally');
    // 点だけを出す。`.state` は色を --state-color から取るが、
    // ここは点1つなので color を直に置く（インラインなので変数より先に効く）
    const dot = el('span', 'state');
    dot.style.color = STATE_COLOR[key];
    item.append(dot, document.createTextNode(label), el('strong', null, n));
    if (blocking[key]) item.classList.add('is-hot');
    dom.summary.append(item);
  }
  if (dom.summary.childElementCount === 0) {
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

  const key = [v.fiveHour, v.sevenDay, v.age, v.hot].join('|');
  if (rateKey === key) return;
  rateKey = key;

  const box = el('span', 'rate-val');
  if (v.hot) box.classList.add('is-hot');
  box.append(document.createTextNode('枠'));
  // 「5h:42%」と繋ぐ。空白だと 5h と 42% がどちらも器の gap と同じ幅で離れて、
  // どの数がどの枠のものか目で組み直すことになる。コロンで結んで1語に見せる
  if (v.fiveHour !== null) box.append(el('strong', null, `5h:${v.fiveHour}`));
  if (v.sevenDay !== null) box.append(el('strong', null, `7d:${v.sevenDay}`));
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
 * 引く先に監視盤（dom.board）も入れる。あちらのカードも同じ buildCard なので、
 * 見る場所を広げれば1秒ごとの更新がそのまま効く
 */
export function refreshTimes() {
  // 枠の使用率も時間で見え方が変わる（但し書きが増える・空く時刻を跨ぐ）。
  // 印で止めてあるので、変わらないうちは組み直さない
  renderRate();

  const byId = new Map(store.rows.map((r) => [r.sessionId, r]));
  const cards = [...dom.list.querySelectorAll('.card'), ...dom.board.querySelectorAll('.card')];
  for (const node of cards) {
    const row = byId.get(node.dataset.sessionId);
    if (!row) continue;
    const idle = node.querySelector('.idle');
    if (idle) {
      idle.textContent = since(idleOf(row));
      // 追記が進めば実時刻も動く。textContent だけ直すと title が古いままになる
      if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
    }
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
