/* ClaudeDeck の画面側。
 *
 * 会話ログの中身をそのまま画面に出すので、文字列は必ず textContent で入れる。
 * innerHTML を使うと、ログに入っていたタグがそのまま解釈されてしまう。
 */
'use strict';

const STATE_COLOR = {
  'needs-answer': 'var(--hot)',
  'needs-plan-approval': 'var(--hot)',
  'needs-approval': 'var(--hot)',
  'awaiting-reply': 'var(--warn)',
  running: 'var(--calm)',
  ended: 'var(--off)',
  unknown: 'var(--off)',
};

/** 一覧のタグに出さない権限モード。どちらも「特別なことは起きていない」を意味する。 */
const QUIET_MODES = new Set(['auto', 'default', 'normal', 'acceptEdits']);

/**
 * 一覧の上に出すまとめ。並び順もこの順にする。
 *
 * ラベルの日本語はここに持たない。サーバが meta.stateLabels で渡してくる。
 * 状態を1つ増やしたときに、直す場所が state.mjs だけで済むようにするため。
 */
const SUMMARY_ORDER = [
  'needs-answer',
  'needs-plan-approval',
  'needs-approval',
  'awaiting-reply',
  'running',
  'ended',
];

/**
 * URL で開き方を指定できる。
 *
 *  ?session=<id> … そのセッションを開く（見に戻るときのブックマーク用）。
 *                  一覧に無いもの（24時間より古いもの）も開ける
 *  ?theme=dark|light … 配色を固定する
 *  ?only=1 … 時系列を「判断だけ」で開く
 *  ?nolive=1 … 自動更新をつながない
 *  ?tab=archive … 書庫（終了したものも含む全セッション）を開いた状態にする
 *  ?aq=<語> … 書庫の検索語
 *  ?asort=recent|oldest|size … 書庫の並び順
 */
const query = new URLSearchParams(location.search);

/** 書庫の並び順。サーバ側（view/archive.mjs の SORTS）と同じ語を使う */
const ARCHIVE_SORTS = new Set(['recent', 'oldest', 'size']);

const dom = {
  app: document.getElementById('app'),
  list: document.getElementById('list'),
  listCount: document.getElementById('list-count'),
  summary: document.getElementById('summary'),
  detail: document.getElementById('detail'),
  live: document.getElementById('live'),
  reload: document.getElementById('reload'),
  themeToggle: document.getElementById('theme-toggle'),
  onlyLive: document.getElementById('only-live'),
  listPane: document.getElementById('list-pane'),
  listToggle: document.getElementById('list-toggle'),
  listClose: document.getElementById('list-close'),
  scrim: document.getElementById('scrim'),
  tabLive: document.getElementById('tab-live'),
  tabArchive: document.getElementById('tab-archive'),
  liveHead: document.getElementById('live-head'),
  archiveHead: document.getElementById('archive-head'),
  archive: document.getElementById('archive'),
  archiveQ: document.getElementById('archive-q'),
  archiveDeep: document.getElementById('archive-deep'),
  archiveSort: document.getElementById('archive-sort'),
  archiveCount: document.getElementById('archive-count'),
};

const store = {
  rows: [],
  meta: null,
  selected: null,
  /**
   * 選んだ経路。'live' は一覧から、'query' は ?session= から。
   *
   * 一覧から選んだものが一覧から消えたら選択を外すが、?session= で直に開いたものは
   * 一覧に居ないのが正常なので外してはいけない。その区別に使う
   */
  selectedFrom: null,
  /** 選んでいるセッションの詳細（/api/sessions/:id の応答） */
  detail: null,
  detailError: null,
  /**
   * detailError がどのセッションのものか。
   *
   * 選び直すと前のエラーは無関係になる。id を持たずに文字列だけ残すと、
   * 次のセッションの読み込み中に前のエラーが出てしまう
   */
  detailErrorFor: null,
  /** サーバから来た「今」。経過時間はこれを基準に進める */
  now: Date.now(),
  onlyLive: localStorage.getItem('claude-deck.onlyLive') === '1',
  // 時系列は既定で新しい順。切り替えたあと開いても、いま何が起きているかが上に出る
  newestFirst: localStorage.getItem('claude-deck.newestFirst') !== '0',
  onlyDecisions: query.get('only') === '1' || localStorage.getItem('claude-deck.onlyDecisions') === '1',
  /**
   * 左のペインに出しているもの。'live'（稼働中）か 'archive'（書庫）。
   *
   * localStorage には残さない。書庫を開いたまま保存すると、次に開いたときに
   * 「誰が待っているか」が見えない状態で始まってしまう。
   * 書庫で固定したい人は ?tab=archive をブックマークする
   */
  tab: query.get('tab') === 'archive' ? 'archive' : 'live',
  /** 書庫の状態。rows はサーバの応答そのまま（logSize と mtimeMs を持つ） */
  archive: {
    rows: [],
    total: 0,
    page: 1,
    pages: 1,
    q: (query.get('aq') ?? '').trim() || null,
    sort: ARCHIVE_SORTS.has(query.get('asort')) ? query.get('asort') : 'recent',
    deep: false,
    meta: null,
    loading: false,
    error: null,
    /** 1度でも引けたか。「まだ引いていない」と「0件だった」を区別するため */
    loaded: false,
    /** サーバ側がまだ書庫に対応していない（404）。静かに退く */
    unavailable: false,
  },
};

/* -------------------------------------------------------------- 小道具 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * いまの状態を URL に書き戻す。
 *
 * pushState は使わない。検索欄は1文字ごとにここを通るので、履歴が入力の回数だけ積まれ、
 * 戻るボタンが使えなくなる。replaceState なら今のアドレスだけが差し替わる。
 *
 * 触るキーは session / only / tab / aq / asort だけ。
 * theme と nolive は「開くときの指定」なので、こちらから書き換えない
 */
function syncQuery() {
  const params = new URLSearchParams(location.search);
  const set = (key, value) => {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  };

  set('session', store.selected);
  set('only', store.onlyDecisions ? '1' : null);
  set('tab', store.tab === 'archive' ? 'archive' : null);
  set('aq', store.tab === 'archive' ? store.archive.q : null);
  // 既定の並び順はキーを付けない。URL を短く保ち、既定が変わったときに古い指定が残らないため
  set('asort', store.tab === 'archive' && store.archive.sort !== 'recent' ? store.archive.sort : null);

  const qs = params.toString();
  const next = qs ? `${location.pathname}?${qs}` : location.pathname;
  // 中身が同じなら書き換えない。一覧の push ごとにここを通るので、無駄な履歴操作を避ける
  if (next === `${location.pathname}${location.search}`) return;
  history.replaceState(null, '', next);
}

/** 経過時間を読みやすくする。 */
function since(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${String(m % 60).padStart(2, '0')}分`;
  return `${Math.floor(h / 24)}日${h % 24}時間`;
}

function shortModel(model) {
  if (!model) return null;
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function tokens(n) {
  if (!n) return null;
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

/** そのセッションが実際に動いている時間を、末尾の追記からの経過で出す。 */
function idleOf(row) {
  if (row.lastActivityAt) return Math.max(0, store.now - row.lastActivityAt);
  return row.idleMs ?? null;
}

/**
 * 一覧から素の行を引く。無ければ書庫の行に落とす。
 *
 * 書庫の行は LIVE_FIELDS（state / idleMs など）を1つも持たないので、
 * headOf の上書きは何も起こさない。逆に logSize は持っているので、
 * 書庫から開いたセッションでも detailStampOf が本物の目印を取れる。
 *
 * @param {string|null} sessionId
 * @returns {object|null} どちらにも居なければ null
 */
function rowOf(sessionId) {
  if (!sessionId) return null;
  return store.rows.find((r) => r.sessionId === sessionId)
    ?? store.archive.rows.find((r) => r.sessionId === sessionId)
    ?? null;
}

/**
 * 詳細ペインが使う項目のうち、一覧の行のほうが新しいもの。
 *
 * 一覧は SSE で毎秒引き直され、詳細は開いた時点のもの。
 * 状態をここで一覧に上書きさせないと、左のカードと右のヘッダが食い違う。
 * 逆に身元（title / model / cwd）は詳細のほうが当たる。
 * 一覧は末尾64KB、詳細は全文を読んで解析しているため。
 *
 * 上書きする項目を配列で名前付けするのは、プロパティの並び順に判断を埋めないため。
 */
const LIVE_FIELDS = [
  'state', 'stateLabel', 'ball', 'idleMs', 'lastActivityAt',
  'waitingFor', 'stateReason', 'stateConfident', 'statusRaw', 'alive', 'pid',
];

/**
 * 詳細ペインが見る「行に相当するもの」を組む。
 *
 * 一覧の行だけを頼りにすると、一覧に居ないセッション（24時間より古いもの）を
 * 開けない。詳細の応答は身元と状態の項目を同じ形で持っているので、そこから組める。
 *
 * @param {string|null} sessionId
 * @returns {object|null} どちらの出どころも無ければ null
 */
function headOf(sessionId) {
  if (!sessionId) return null;
  const row = rowOf(sessionId);
  const detail = store.detail?.sessionId === sessionId ? store.detail : null;
  if (!detail) return row;
  const head = { ...detail };
  if (row) {
    for (const key of LIVE_FIELDS) {
      if (key in row) head[key] = row[key];
    }
  }
  return head;
}

/* ---------------------------------------------------------------- 一覧 */

function visibleRows() {
  return store.onlyLive ? store.rows.filter((r) => r.alive) : store.rows;
}

function buildCard(row) {
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
  const ctx = tokens(row.contextTokens);
  if (ctx) meta.append(el('span', 'tag', `ctx ${ctx}`));
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    select(row.sessionId);
    // 引き出しは選ぶために開くもの。選び終わったら用済みなので閉じて詳細に場所を渡す。
    // 同じものを選び直したときも閉じたいので、select の中ではなくここに置く
    setListOpen(false, dom.detail);
  });
  li.append(card);
  return li;
}

function renderList() {
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

function renderSummary() {
  dom.summary.replaceChildren();
  const counts = store.meta?.counts ?? {};
  // ラベルはサーバ側の STATE_LABELS。まだ受け取っていない間はキーをそのまま出す
  const labels = store.meta?.stateLabels ?? {};
  for (const key of SUMMARY_ORDER) {
    const n = counts[key] ?? 0;
    if (n === 0) continue;
    const label = labels[key] ?? key;
    const chip = el('span', 'chip');
    chip.style.setProperty('--state-color', STATE_COLOR[key]);
    const dot = el('span', 'state');
    dot.style.color = STATE_COLOR[key];
    chip.append(dot, document.createTextNode(label), el('strong', null, n));
    if (key.startsWith('needs')) chip.classList.add('is-hot');
    dom.summary.append(chip);
  }
  if (dom.summary.childElementCount === 0) {
    dom.summary.append(el('span', 'chip', '動いているセッションなし'));
  }
}

/** 経過時間の表示だけを進める。作り直さないのでスクロール位置が動かない */
function refreshTimes() {
  const byId = new Map(store.rows.map((r) => [r.sessionId, r]));
  for (const node of dom.list.querySelectorAll('.card')) {
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

/* ---------------------------------------------------------------- 書庫 */

/** 1ページの件数。サーバ側の上限は 50 */
const ARCHIVE_PER = 30;
/** 検索欄のデバウンス。打つたびに引くと 1 文字ごとにファイルを読ませることになる */
const ARCHIVE_DEBOUNCE_MS = 200;

let archiveToken = 0;
let archiveTimer = null;

/** バイト数を KB で。書庫はログの大きさが「どれだけ話したか」の目安になる */
function kb(bytes) {
  if (typeof bytes !== 'number') return '';
  return `${Math.round(bytes / 1024).toLocaleString('ja-JP')} KB`;
}

/** 書庫の日時。年は同じものが並ぶので落とし、月日と時刻だけにする */
function shortStamp(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 書庫のカード1枚。
 *
 * 状態色は出さない。書庫に出るものは全部終わっているので、色を付けると
 * 稼働中の一覧と同じ重さに見えて、どれから手をつけるかが読めなくなる。
 */
function buildArchiveCard(row) {
  const li = el('li');
  const card = el('button', 'card is-archive');
  card.type = 'button';
  card.setAttribute('aria-current', String(row.sessionId === store.selected));
  card.dataset.sessionId = row.sessionId ?? '';

  const top = el('div', 'card-top');
  const when = el('span', 'when', shortStamp(row.mtimeMs));
  // 「08/03 14:22」だけでは何年のものか分からない。年は乗せたときだけ出す
  if (row.mtimeMs) when.title = stamp(row.mtimeMs);
  top.append(when);
  top.append(el('span', 'idle', kb(row.logSize)));
  card.append(top);

  // 「読んでいないから空」と「本当に空」を混同させない。read でそこを分ける
  const label = row.title ?? (row.read ? '（指示なしで終わっています）' : '（まだ読んでいません）');
  const title = el('div', 'card-title', label);
  if (!row.title) title.classList.add('is-empty');
  card.append(title);

  const meta = el('div', 'card-meta');
  if (row.project) meta.append(el('span', 'path', row.project));
  if (row.gitBranch && row.gitBranch !== 'HEAD') meta.append(el('span', 'tag', row.gitBranch));
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    select(row.sessionId, 'archive');
    setListOpen(false, dom.detail);
  });
  li.append(card);
  return li;
}

/** 書庫のヘッダに出す件数と、読んだ件数の内訳 */
function renderArchiveCount() {
  const a = store.archive;
  if (!a.loaded) {
    dom.archiveCount.textContent = '';
    return;
  }
  const parts = [`${a.total.toLocaleString('ja-JP')} 件`];
  if (a.rows.length < a.total) parts.push(`${a.rows.length} 件表示`);
  // どこまで中身を読んだかを正直に出す。打ち切っていれば「全部を探せていない」と分かる
  if (a.meta?.scanLimited) parts.push(`中身は新しい ${a.meta.scanMax} 件まで`);
  dom.archiveCount.textContent = parts.join(' / ');
}

function renderArchive() {
  const a = store.archive;
  dom.archive.replaceChildren();
  renderArchiveCount();

  // 空表示を4つに割る。ひとまとめにすると「まだ引いていない」と「0件だった」が同じ顔になる
  if (a.unavailable) {
    const li = el('li');
    li.append(el('div', 'empty', '書庫はまだ使えません（サーバ側が対応していません）'));
    dom.archive.append(li);
    return;
  }
  if (a.error) {
    const li = el('li');
    const box = el('div', 'empty', `書庫を読めませんでした: ${a.error}`);
    const retry = el('button', 'btn', 'もう一度試す');
    retry.type = 'button';
    retry.addEventListener('click', () => loadArchive());
    const action = el('div', 'empty-note');
    action.append(retry);
    box.append(action);
    li.append(box);
    dom.archive.append(li);
    return;
  }
  if (!a.loaded) {
    // 引いている途中だけ出す。押す前から空の枠を出すと「0件だった」に見える
    if (a.loading) {
      const li = el('li');
      li.append(el('div', 'empty', '書庫を読んでいます…'));
      dom.archive.append(li);
    }
    return;
  }
  if (a.rows.length === 0) {
    const li = el('li');
    const box = el('div', 'empty', a.q
      ? `「${a.q}」に当たるセッションがありません`
      : 'セッションのログが見つかりません');
    // 既定の検索はタイトルまで見ていない。深い検索という手が残っていることを伝える
    if (a.q && !a.deep) {
      box.append(el('div', 'empty-note', '「中身も探す」を入れると、ログを開いてタイトルまで探します'));
    }
    li.append(box);
    dom.archive.append(li);
    return;
  }

  for (const row of a.rows) dom.archive.append(buildArchiveCard(row));

  if (a.rows.length < a.total) {
    const li = el('li');
    const more = el('button', 'btn archive-more',
      `続きを出す（残り ${(a.total - a.rows.length).toLocaleString('ja-JP')} 件）`);
    more.type = 'button';
    more.disabled = a.loading;
    more.addEventListener('click', () => loadArchive({ append: true }));
    li.append(more);
    dom.archive.append(li);
  }
}

/**
 * 書庫を引く。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.append] 次のページを継ぎ足す（並びと検索語は変えない）
 */
async function loadArchive({ append = false } = {}) {
  const a = store.archive;
  if (a.unavailable) return;

  const token = ++archiveToken;
  a.loading = true;
  a.error = null;
  renderArchive();

  const params = new URLSearchParams();
  params.set('page', String(append ? a.page + 1 : 1));
  params.set('per', String(ARCHIVE_PER));
  params.set('sort', a.sort);
  if (a.q) params.set('q', a.q);
  if (a.deep) params.set('deep', '1');

  try {
    const res = await fetch(`/api/archive?${params.toString()}`, { cache: 'no-store' });
    // サーバ側と歩調を合わせずに画面側だけ先に入れられるようにする
    if (res.status === 404) {
      if (token === archiveToken) {
        a.unavailable = true;
        a.loading = false;
        renderArchive();
      }
      return;
    }
    if (!res.ok) {
      const reason = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 打ち終わる前の応答が後から届くことがある。古い応答で上書きしない
    if (token !== archiveToken) return;
    a.rows = append ? [...a.rows, ...(data.rows ?? [])] : (data.rows ?? []);
    a.total = data.total ?? a.rows.length;
    a.page = data.page ?? 1;
    a.pages = data.pages ?? 1;
    a.meta = data.meta ?? null;
    a.loaded = true;
  } catch (err) {
    if (token !== archiveToken) return;
    a.error = err.message;
  } finally {
    if (token === archiveToken) {
      a.loading = false;
      renderArchive();
    }
  }
}

/**
 * 左のペインを切り替える。
 *
 * 書庫を出しているあいだも上のバーのまとめ（renderSummary）は動かし続ける。
 * あれが「誰かが待っている」の唯一の合図なので、ここで止めると質問を取りこぼす。
 *
 * @param {'live'|'archive'} tab
 * @param {object} [opts]
 * @param {boolean} [opts.sync] URL を書き戻すか。起動時だけ false にする
 *   （まだ ?session= を store に取り込んでいないので、書き戻すと指定が消える）
 */
function setTab(tab, { sync = true } = {}) {
  store.tab = tab === 'archive' ? 'archive' : 'live';
  const isArchive = store.tab === 'archive';

  dom.tabLive.setAttribute('aria-pressed', String(!isArchive));
  dom.tabArchive.setAttribute('aria-pressed', String(isArchive));
  dom.liveHead.hidden = isArchive;
  dom.list.hidden = isArchive;
  dom.archiveHead.hidden = !isArchive;
  dom.archive.hidden = !isArchive;
  if (sync) syncQuery();

  if (!isArchive) {
    // まだ一覧を受け取っていない起動直後は描かない。空表示が一瞬出るのを避ける
    if (store.meta) renderList();
    return;
  }
  if (!store.archive.loaded && !store.archive.loading) loadArchive();
  else renderArchive();
}

/* ---------------------------------------------------------------- 詳細 */

function fact(dl, label, value) {
  if (value === null || value === undefined || value === '') return;
  dl.append(el('dt', null, label), el('dd', null, value));
}

/**
 * パネル1枚。
 *
 * id は上のジャンプ用リンクから飛ぶために振る。
 * tone は枠と見出しの色。急ぐものだけ色を変え、他は素のままにする。
 */
function panel(title, opts = {}) {
  const section = el('section', 'panel');
  if (opts.id) section.id = opts.id;
  if (opts.tone) section.classList.add(`is-${opts.tone}`);
  const head = el('h3', null, title);
  if (opts.count !== undefined && opts.count !== null) head.append(el('span', 'count', opts.count));
  if (opts.action) head.append(opts.action);
  section.append(head);
  const body = el('div', 'panel-body');
  section.append(body);
  return { section, body };
}

/** パネルの id。ジャンプ用リンクと対で使う。 */
const SEC = {
  wait: 'sec-wait',
  decisions: 'sec-decisions',
  todo: 'sec-todo',
  compact: 'sec-compact',
  timeline: 'sec-timeline',
  files: 'sec-files',
  basics: 'sec-basics',
};

const KIND_LABELS = {
  prompt: 'あなたの指示',
  answer: 'あなたの回答',
  plan: 'プラン',
  denial: '却下・不許可',
  skill: 'スキル',
  agent: 'サブエージェント',
  say: 'Claude',
  compact: '文脈の圧縮',
  error: 'エラー',
  slash: 'コマンド',
  interrupt: 'あなたが中断',
  // Claude 自身が書いた中間報告。機械的に抜き出した記録ではないので、語を分けておく
  recap: 'Claude の中間報告',
  elided: '省略',
};

/**
 * 「判断だけ」で残す種類。
 *
 * Claude の説明（say）を落とすと、自分が動かした所だけが縦に並ぶ。
 * 何十往復もしたセッションを思い出すときは、こちらのほうが速い。
 *
 * recap（Claude の中間報告）は入れない。自己申告であって自分の判断ではないため。
 */
const DECISION_KINDS = new Set([
  'prompt', 'answer', 'plan', 'denial', 'interrupt', 'slash', 'skill', 'agent', 'error', 'compact',
]);

function toggle(label, pressed, onClick) {
  const b = el('button', 'btn', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 日付を yyyy/MM/dd で。 */
function ymd(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 時刻を HH:mm:ss で。 */
function hms(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 日時を1行で。2段に割れない所（title 属性やヘッダの1項目）で使う。
 *
 * toLocaleString だと 2026/8/4 0:11:05 のようにゼロ埋めが落ちて桁がそろわないので、自前で組む。
 * @param {number|string|null} at ミリ秒、または日時文字列
 */
function stamp(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${ymd(d)} ${hms(d)}`;
}

function num(n) {
  return typeof n === 'number' ? n.toLocaleString('ja-JP') : '?';
}

/**
 * 待ちの種類ごとの言い方。
 *
 * どれも「〜までの間」で止める。「迷った時間」「悩んだ時間」とは書かない。
 * ログから分かるのは前のやり取りからの経過だけで、席を外していた時間と区別できない
 */
const WAIT_LABELS = {
  answer: '回答までの間',
  plan: '承認までの間',
  denial: '却下までの間',
  reply: '返信までの間',
  tool: 'ツールの往復',
};

/** 待ちに必ず添える注記。言い切らないための断り書き */
const WAIT_NOTE = '「…までの間」は前のやり取りからの経過時間です。席を外していた時間と区別できないため、迷っていた時間とは限りません。';

/**
 * 待ち時間の印を1つ作る。
 *
 * wait が null のときは何も返さない。圧縮や中断を跨いだ区間・時刻が取れなかった区間が
 * そこに当たる。0 と書くと「即答した」に読めるので、取れなかったものは出さない。
 *
 * @param {object|null} wait digest の item.wait（{kind, ms, away}）
 * @returns {HTMLElement|null}
 */
function waitBadge(wait) {
  if (!wait || typeof wait.ms !== 'number') return null;
  const node = el('span', 'tl-wait', `${WAIT_LABELS[wait.kind] ?? '間'} ${since(wait.ms)}`);
  node.title = WAIT_NOTE;
  // 4時間を超える間は、判断に使った時間として読ませない
  if (wait.away) {
    node.dataset.away = 'true';
    node.append(el('span', 'away', '席を外していた可能性'));
  }
  return node;
}

/**
 * 待ちの集計を1行にする。
 *
 * 測れたものが1つも無ければ null。fact() が null を素通りするので、
 * 「取れなかった項目は出さない」が自動で守られる。
 *
 * @param {object|null} bucket stats.waits の1つ（{count, totalMs, maxMs, away}）
 */
function waitFact(bucket) {
  if (!bucket) return null;
  const parts = [];
  if (bucket.count > 0) {
    parts.push(`${bucket.count} 回`);
    parts.push(`合計 ${since(bucket.totalMs)}`);
    parts.push(`最長 ${since(bucket.maxMs)}`);
  }
  // 4時間超は合計に混ぜていない。件数だけは出して「無かった」と読ませない
  if (bucket.away > 0) parts.push(`4時間超 ${bucket.away} 回は別枠`);
  return parts.length ? parts.join(' / ') : null;
}

/**
 * 長い本文は頭だけ出して、続きは折りたたむ。
 *
 * 時系列は「ざっと目で追える」ことが値なので、1件が画面を埋めてはいけない。
 * 全文は残すが、開いたときだけ見せる。
 *
 * @param {string|null} text 出す本文（サーバ側で既に切られていることがある）
 * @param {number} limit 頭出しの文字数
 * @param {number} maxLines 頭出しの行数
 * @param {number|null} [fullLength] 切る前の文字数。サーバが切っていれば受け取った長さより大きい
 */
function bodyText(text, limit, maxLines, fullLength = null) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const lines = t.split('\n');
  if (t.length <= limit && lines.length <= maxLines) return [el('div', 'tl-text', t)];

  let head = lines.slice(0, maxLines).join('\n');
  if (head.length > limit) head = head.slice(0, limit);
  const more = el('details', 'more');
  // ここで持っているのが本当の全文かどうかで文言を変える。サーバ側が既に切っているのに
  // 「全文」と書くと嘘になる（say は 1,200 字、recap は 2,000 字で切られている）
  const clipped = typeof fullLength === 'number' && fullLength > t.length;
  more.append(el('summary', null, clipped
    ? `全 ${fullLength.toLocaleString('ja-JP')} 字（このうち ${t.length.toLocaleString('ja-JP')} 字まで表示）`
    : `全文（${t.length.toLocaleString('ja-JP')}字）`));
  more.append(el('pre', null, t));
  return [el('div', 'tl-text', `${head.trimEnd()}…`), more];
}

/**
 * 回答1件を描く。
 *
 * compact のときは質問と選んだ答えだけ。時系列の中では短くしたいので。
 * それ以外は選択肢の説明と、選ばなかった案も出す。
 * 説明文が「その選択が何を意味していたか」なので、判断の理由がここに残る。
 */
function answerBlock(a, compact) {
  const wrap = el('div', 'decision');
  wrap.append(el('div', 'decision-q', a.question || '(質問文なし)'));

  const box = el('div', 'decision-a');
  if (a.freeText) box.classList.add('is-free');
  if (a.chosen) {
    box.append(el('div', 'label', a.chosen));
    const why = a.chosenOptions?.[0]?.description;
    if (!compact && why) box.append(el('p', 'why', why));
    else if (!compact && a.freeText) box.append(el('p', 'why', '選択肢から選ばず、自分で書いた回答'));
  } else {
    box.append(el('div', 'label', '（まだ回答していません）'));
  }
  wrap.append(box);

  if (!compact && a.otherOptions?.length) {
    const d = el('details', 'rejected');
    d.append(el('summary', null, `選ばなかった案 ${a.otherOptions.length} 件`));
    const ul = el('ul');
    for (const o of a.otherOptions) {
      const li = el('li');
      li.append(el('span', 'label', o.label));
      if (o.description) li.append(document.createTextNode(` — ${o.description}`));
      ul.append(li);
    }
    d.append(ul);
    wrap.append(d);
  }
  return wrap;
}

function planBlock(item, compact) {
  const box = el('div', 'tl-body');
  const status = item.pending ? '承認を待っています' : item.approved ? '承認済み' : '差し戻し';
  const line = el('div', 'tl-text', status);
  // パスは等幅で出す。和文フォントに落ちると \ が ¥ の字形になって別物に見えるため
  if (item.planFile) {
    line.append(' — ');
    line.append(el('span', 'mono', item.planFile));
  }
  box.append(line);
  if (item.feedback) box.append(el('pre', 'tl-detail', item.feedback));
  if (item.plan && !compact) {
    const d = el('details', 'more');
    d.append(el('summary', null, 'プラン全文'));
    d.append(el('pre', null, item.plan));
    box.append(d);
  }
  return box;
}

/**
 * 時系列の左端。日付と時刻を2段で出す。
 *
 * 時刻だけだと、23:58 の次に 00:03 が並んだときに同じ日なのか翌日なのかが読めない。
 * 日付が変わった行にだけ出す手もあるが、スクロールでその行が画面外へ出ると分からなくなるので、
 * 行だけを見て日付が読めるほうを取る。
 * @param {number|null} at そのやり取りの時刻（ミリ秒）。取れていなければ null
 */
function whenNode(at) {
  const node = el('div', 'tl-when');
  // 時刻が無い行でも列は残す。ノードごと省くと本文が左の列にずれ込む
  if (!at) return node;
  const d = new Date(at);
  node.append(el('span', 'tl-date', ymd(d)), el('span', 'tl-time', hms(d)));
  return node;
}

/** 時系列の1行。 */
function timelineItem(item) {
  const row = el('div', 'tl');
  row.dataset.kind = item.kind;

  if (item.kind === 'compact') {
    const body = el('div', 'tl-body');
    const from = num(item.preTokens);
    const to = num(item.postTokens);
    const trigger = item.trigger === 'auto' ? '自動' : item.trigger ?? '';
    body.append(el('div', 'tl-text',
      `ここで文脈が圧縮されました（${from} → ${to} tokens${trigger ? ` / ${trigger}` : ''}）。これより前の細部は Claude 側にも残っていません`));
    row.append(body);
    return row;
  }

  row.append(whenNode(item.at));
  const body = el('div', 'tl-body');
  const kindRow = el('div', 'tl-kind');
  kindRow.append(document.createTextNode(KIND_LABELS[item.kind] ?? item.kind));
  // 前のやり取りからの間。取れていない行には何も付かない
  const wait = waitBadge(item.wait);
  if (wait) kindRow.append(wait);
  body.append(kindRow);

  switch (item.kind) {
    // 自分の指示は判断の記録そのものなので、Claude の説明より長く出す
    case 'prompt':
      body.append(...bodyText(item.text, 900, 12));
      break;
    case 'say':
      body.append(...bodyText(item.text, 260, 4, item.fullLength));
      break;
    // Claude の自己申告。時系列でもその場で断ってから本文を出す
    case 'recap':
      body.append(el('p', 'note', 'Claude 自身が書いた中間報告です。機械的に抜き出した記録ではありません'));
      body.append(...bodyText(item.text, 600, 8, item.fullLength));
      break;
    // 間引きで落ちた区間の目印。何が落ちたかまで出す（足跡だけの区間かどうかが読めるように）
    case 'elided': {
      const kinds = Object.entries(item.byKind ?? {})
        .map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n}`)
        .join(' / ');
      const range = item.fromAt && item.toAt
        ? `（${hms(new Date(item.fromAt))} 〜 ${hms(new Date(item.toAt))}）`
        : '';
      body.append(el('div', 'tl-text',
        `${item.count} 件を省略しました${kinds ? `　${kinds}` : ''}${range}`));
      break;
    }
    // 選んだ理由（選択肢の説明文）は判断の記録そのものなので、時系列でも省かない
    case 'answer':
      for (const a of item.answers ?? []) body.append(answerBlock(a, false));
      break;
    case 'plan':
      body.append(...planBlock(item, false).childNodes);
      break;
    case 'denial':
      body.append(el('div', 'tl-text', `${item.denialLabel} — ${item.tool}`));
      if (item.detail) body.append(el('pre', 'tl-detail', item.detail));
      // note は定型文を除いた残り。自分が添えたコメントがあればここに出る
      if (item.note) body.append(el('pre', 'tl-detail', item.note));
      break;
    case 'interrupt':
      body.append(el('div', 'tl-text', 'ここで実行を止めた'));
      break;
    case 'skill':
      body.append(el('div', 'tl-text', item.args ? `/${item.skill} ${item.args}` : `/${item.skill}`));
      break;
    case 'agent':
      body.append(el('div', 'tl-text', [item.agentType, item.description].filter(Boolean).join(' — ') || '(説明なし)'));
      break;
    case 'error':
      body.append(el('div', 'tl-text', `${item.tool}${item.detail ? ` — ${item.detail}` : ''}`));
      if (item.message) body.append(el('pre', 'tl-detail', item.message));
      break;
    case 'slash':
      body.append(el('div', 'tl-text', item.args ? `${item.command} ${item.args}` : item.command));
      break;
    default:
      body.append(el('div', 'tl-text', JSON.stringify(item)));
  }

  row.append(body);
  return row;
}

/**
 * 詳細の操作ボタン。
 *
 * 指示を送り込むことはしない（非公開の仕組みに乗ると壊れやすい）。
 * 窓を前面に出すところまでやって、あとは本人が打つ。それで用は足りる。
 */
function detailActions(row) {
  const box = el('div', 'detail-actions');
  const hint = el('span', 'hint');

  if (row.alive && row.pid) {
    const focus = el('button', 'btn', 'ターミナルを前面に');
    focus.type = 'button';
    focus.addEventListener('click', async () => {
      focus.disabled = true;
      hint.textContent = '呼んでいます…';
      try {
        const res = await fetch(`/api/focus?pid=${encodeURIComponent(row.pid)}`, { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          hint.textContent = `出せません: ${data.reason}`;
        } else if (data.tabbed) {
          // 窓は前に出るがタブは選べない。出たつもりで待たせないよう、そこは正直に書く
          hint.textContent = `${data.app} を前面に出しました。タブの切り替えは手動でどうぞ`;
        } else {
          hint.textContent = `前面に出しました（${data.detail ?? ''}）`;
        }
      } catch (err) {
        hint.textContent = `出せません: ${err.message}`;
      } finally {
        focus.disabled = false;
      }
    });
    box.append(focus);
  }

  // 終了したセッションを開き直すときのコマンド。cwd を間違えると別のログになるので一緒に渡す
  if (row.sessionId) {
    const copy = el('button', 'btn', '再開コマンドをコピー');
    copy.type = 'button';
    const command = row.cwd
      ? `cd "${row.cwd}"; claude --resume ${row.sessionId}`
      : `claude --resume ${row.sessionId}`;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        hint.textContent = 'コピーしました';
      } catch {
        hint.textContent = command;
      }
    });
    box.append(copy);
  }

  box.append(hint);
  return box;
}

/**
 * 「なぜこの作業をしているか」を先頭に畳んで置く。
 *
 * 下のパネルを読めば分かることでも、切り替えのたびに読み下すのは重い。
 * 目的と直近の判断だけを最初に見せて、続きは下で追えるようにする。
 */
function summaryBlock(summary) {
  if (!summary || summary.source === 'error') return null;

  // 上のバーの .summary とは別物。名前を分けておかないと両方に同じ CSS が当たる
  const box = el('div', 'purpose');
  if (summary.headline) {
    box.append(el('div', 'purpose-head', summary.headline));
    // 出どころが Claude の中間報告なら、そう断る。
    // 機械的に抜き出した指示やタイトルと同じ重さに見せてはいけない（自己申告なので）
    if (summary.headlineSource === 'recap') {
      const mark = el('div', 'purpose-src');
      mark.append(el('span', 'claim', 'Claude の申告'));
      mark.append(document.createTextNode(summary.headlineAt
        ? `${stamp(summary.headlineAt)} 時点で Claude 自身が書いた中間報告です`
        : 'Claude 自身が書いた中間報告です'));
      box.append(mark);
    }
  }

  if (summary.compacted) {
    // 圧縮されている場合、上の見出しは本当の始まりではないかもしれない
    box.append(el('div', 'purpose-warn', '途中で文脈が圧縮されているため、これより前の指示は残っていません'));
  }

  if (summary.points?.length) {
    const dl = el('dl', 'purpose-points');
    for (const p of summary.points) {
      // 待ちの中身はすぐ下の「あなたの番」で大きく出すので、ここでは繰り返さない。
      // 要約データ側からは消さない（画面を持たない使い道でも状態が読めるように）
      if (p.label === '待っているもの') continue;
      dl.append(el('dt', null, p.label));
      dl.append(el('dd', null, p.text));
    }
    if (dl.childElementCount > 0) box.append(dl);
  }

  return box.childNodes.length ? box : null;
}

/**
 * 待ちの種類ごとの、見出しと「何をすれば進むのか」。
 *
 * ここに無い状態（実行中・終了）は待っていないので、パネルそのものを出さない。
 */
const WAIT_GUIDE = {
  'needs-answer': {
    title: '質問に答える',
    tone: 'hot',
    lead: '選択肢を選ぶまで、この先へ進みません',
  },
  'needs-plan-approval': {
    title: 'プランを承認する',
    tone: 'hot',
    lead: 'この計画で進めてよいかを決めてください',
  },
  'needs-approval': {
    title: '実行を許可する',
    tone: 'hot',
    lead: 'このツールを実行してよいかを決めてください',
  },
  'awaiting-reply': {
    title: '次の指示を出す',
    tone: 'warn',
    lead: 'Claude は応答を返し終えて止まっています',
  },
};

/**
 * まだ答えていない質問。
 *
 * 選択肢は説明つきで全部出す。ここで選ぶわけではないが、
 * 何を訊かれているか分かればターミナルへ戻ってすぐ答えられる。
 * 決めた答え（decision-a）とは見せ方を変えて、選んだものと混同させない。
 */
function pendingQuestion(a) {
  const wrap = el('div', 'decision');
  wrap.append(el('div', 'decision-q', a.question || '(質問文なし)'));

  const options = a.otherOptions ?? [];
  if (options.length) {
    const ul = el('ul', 'choices');
    for (const o of options) {
      const li = el('li');
      li.append(el('span', 'label', o.label));
      if (o.description) li.append(document.createTextNode(` — ${o.description}`));
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

/**
 * 「いま何を待たれているか」を目的のすぐ下に置く。
 *
 * 状態の名前だけでは動けない。返信待ちなら何に返すのか、承認待ちなら何を承認するのか、
 * そこまで出さないと結局ターミナルへ戻って読み直すことになる。
 * 待ちの種類ごとに、判断に必要なものをここへ持ってくる。
 *
 * @param {object} row 一覧の1行
 * @param {object|null} d 詳細（まだ読めていなければ null）
 */
function waitingBlock(row, d) {
  const guide = WAIT_GUIDE[row.state];
  if (!guide) return null;

  const p = panel(`あなたの番 — ${guide.title}`, { id: SEC.wait, tone: guide.tone });
  p.section.classList.add('is-wait');
  p.body.append(el('p', 'note', guide.lead));

  const items = d?.digest?.items ?? [];
  const lastOf = (pred) => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (pred(items[i])) return items[i];
    }
    return null;
  };

  if (row.state === 'needs-answer') {
    const ask = lastOf((i) => i.kind === 'answer' && i.unanswered);
    for (const a of ask?.answers ?? []) p.body.append(pendingQuestion(a));
    // 詳細がまだ来ていない間は、一覧が持っている質問文だけ出しておく
    if (!ask && row.waitingFor?.detail) p.body.append(el('div', 'wait-q', row.waitingFor.detail));
  } else if (row.state === 'needs-plan-approval') {
    const plan = lastOf((i) => i.kind === 'plan' && i.pending);
    if (plan?.planFile) {
      const line = el('div', 'wait-lead', 'プランの保存先 ');
      line.append(el('span', 'mono', plan.planFile));
      p.body.append(line);
    }
    if (plan?.plan) p.body.append(...bodyText(plan.plan, 1400, 18));
    else if (d) p.body.append(el('p', 'note', 'プランの本文はログから取れませんでした'));
  } else if (row.state === 'needs-approval') {
    if (row.waitingFor) {
      p.body.append(el('div', 'wait-tool', row.waitingFor.tool));
      if (row.waitingFor.detail) p.body.append(el('pre', null, row.waitingFor.detail));
    }
  } else if (row.state === 'awaiting-reply') {
    const say = lastOf((i) => i.kind === 'say' && i.text);
    if (say) {
      p.body.append(el('div', 'wait-lead', 'Claude の最後の応答'));
      p.body.append(...bodyText(say.text, 700, 8));
    }
  }

  return { section: p.section, tone: guide.tone };
}

/**
 * 上に置くジャンプ用のリンク。
 *
 * 詳細は縦に長いので、下にある TODO や時系列は開いた時点では見えない。
 * 何が入っているかを先に並べておけば、あると分かってから探しに行ける。
 * スクロールしても上に残すので、戻る手間もない。
 *
 * @param {Array<{id:string,label:string,count?:string|number,tone?:string}>} sections
 */
function navBlock(sections) {
  // 2つ以下なら見れば分かる。目次のほうが目立ってしまう
  if (sections.length < 3) return null;

  const nav = el('nav', 'deck-nav');
  nav.setAttribute('aria-label', 'この詳細に入っているもの');

  for (const s of sections) {
    const b = el('button', 'nav-chip', s.label);
    b.type = 'button';
    if (s.tone) b.classList.add(`is-${s.tone}`);
    if (s.count !== undefined && s.count !== null) b.append(el('span', 'n', s.count));
    b.addEventListener('click', () => {
      const target = document.getElementById(s.id);
      if (!target) return;
      // 動きを減らす設定は CSS では効かない指定なので、ここで見て切り替える
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    });
    nav.append(b);
  }
  return nav;
}

function renderDetail() {
  // row と呼んでいるのは一覧の行と同じ形のもの。一覧に居なければ詳細から組む
  const row = headOf(store.selected);
  const error = detailErrorNow();
  dom.detail.replaceChildren();

  // 入口を3つに割る。ひとまとめにすると「選んでいない」「取得中」「取得に失敗した」が
  // すべて同じ空表示になり、存在しない id を開いても何も起きていないように見える
  if (!row) {
    if (!store.selected) {
      dom.detail.append(el('div', 'detail-empty', '左の一覧からセッションを選ぶと、ここに中身が出ます'));
    } else if (error) {
      const p = panel('このセッションは開けませんでした');
      p.body.append(el('p', 'note', error));
      const id = el('p', 'note', 'セッションID ');
      id.append(el('span', 'mono', store.selected));
      p.body.append(id);
      dom.detail.append(p.section);
    } else {
      dom.detail.append(el('div', 'loading', 'ログを読んでいます…'));
    }
    return;
  }

  const wrap = el('div', 'detail');
  wrap.append(el('h2', null, row.title ?? row.name ?? row.sessionId));

  const sub = el('div', 'detail-sub');
  // stateLabel が無いときに空の .state を出すと、色の点だけが残って意味を持たない
  if (row.stateLabel) {
    const state = el('span', 'state', row.stateLabel);
    state.style.color = STATE_COLOR[row.state] ?? 'var(--off)';
    sub.append(state);
  }
  if (row.cwd) sub.append(el('span', 'path', row.cwd));
  wrap.append(sub);
  wrap.append(detailActions(row));

  const d = store.detail?.sessionId === store.selected ? store.detail : null;

  // なぜこの作業をしているか。読む順として、待ちの内容より先に来る必要がある
  if (d) {
    const summary = summaryBlock(d.summary);
    if (summary) wrap.append(summary);
  }

  const stack = el('div', 'stack');
  /** 上のジャンプ用リンクに出す並び。パネルを積むのと同じ順に足していく */
  const sections = [];

  // 何を待っているか。自分の番のときはここが最初に読む場所になるので、目的の直下に置く
  const waiting = waitingBlock(row, d);
  if (waiting) {
    stack.append(waiting.section);
    sections.push({ id: SEC.wait, label: 'あなたの番', tone: waiting.tone });
  }

  if (d) {
    // 「自分が何を決めたか」が課題の中心なので、待ちの次に置く（待っていなければ先頭）
    const decisions = d.digest.items.filter((i) => i.kind === 'answer' || i.kind === 'plan');
    if (decisions.length) {
      const answers = decisions.flatMap((i) => i.answers ?? []).length;
      const p = panel('あなたが決めたこと', {
        id: SEC.decisions,
        count: `回答 ${answers} / プラン ${d.digest.stats.plans}`,
      });
      // 見出しと同じ数え方にする（回答＋プラン）。
      // ログの行数を出すと、見出しの「回答 3 / プラン 1」と食い違って読めなくなる
      sections.push({
        id: SEC.decisions,
        label: 'あなたが決めたこと',
        count: answers + d.digest.stats.plans,
      });
      for (const item of decisions) {
        if (item.kind === 'answer') {
          for (const a of item.answers ?? []) p.body.append(answerBlock(a, false));
        } else {
          const box = el('div', 'decision');
          box.append(el('div', 'decision-q', 'プランを提出'));
          box.append(...planBlock(item, false).childNodes);
          p.body.append(box);
        }
      }
      stack.append(p.section);
    }

    if (d.tasks.items.length) {
      const done = d.tasks.counts.completed ?? 0;
      const p = panel('TODO', { id: SEC.todo, count: `${done} / ${d.tasks.items.length} 完了` });
      sections.push({ id: SEC.todo, label: 'TODO', count: `${done}/${d.tasks.items.length}` });
      const ul = el('ul', 'todo');
      for (const t of d.tasks.items) {
        const li = el('li');
        li.dataset.status = t.status;
        li.append(el('span', 'st', t.statusLabel));
        const s = el('span', 'subject', t.subject);
        li.append(s);
        ul.append(li);
      }
      p.body.append(ul);
      stack.append(p.section);
    }

    if (d.digest.compactions.length) {
      const p = panel('文脈の圧縮', { id: SEC.compact, count: `${d.digest.compactions.length} 回` });
      sections.push({ id: SEC.compact, label: '文脈の圧縮', count: d.digest.compactions.length });
      p.body.append(el('p', 'note',
        'このセッションは途中で文脈が圧縮されています。圧縮より前のやり取りは要約に置き換わっているため、下の時系列で確認してください。'));
      stack.append(p.section);
    }

    const actions = el('span', 'panel-actions');
    actions.append(
      toggle('判断だけ', store.onlyDecisions, () => {
        store.onlyDecisions = !store.onlyDecisions;
        localStorage.setItem('claude-deck.onlyDecisions', store.onlyDecisions ? '1' : '0');
        // 開き方を人に渡せるようにする（?only=1）
        syncQuery();
        renderDetail();
      }),
      toggle(store.newestFirst ? '新しい順' : '古い順', false, () => {
        store.newestFirst = !store.newestFirst;
        localStorage.setItem('claude-deck.newestFirst', store.newestFirst ? '1' : '0');
        renderDetail();
      }),
    );

    let items = d.digest.items;
    if (store.onlyDecisions) items = items.filter((i) => DECISION_KINDS.has(i.kind));
    const shown = store.newestFirst ? [...items].reverse() : items;

    const p = panel('時系列', {
      id: SEC.timeline,
      count: store.onlyDecisions
        ? `${items.length} / ${d.digest.items.length} 件`
        : `${d.digest.items.length} 件${d.digest.stats.droppedItems ? `（説明 ${d.digest.stats.droppedItems} 件は省略）` : ''}`,
      action: actions,
    });
    sections.push({ id: SEC.timeline, label: '時系列', count: items.length });
    const tl = el('div', 'timeline');
    for (const item of shown) tl.append(timelineItem(item));
    p.body.append(tl);
    stack.append(p.section);

    if (d.digest.files.length) {
      const q = panel('書き換えたファイル', { id: SEC.files, count: `${d.digest.files.length} 件` });
      sections.push({ id: SEC.files, label: '書き換えたファイル', count: d.digest.files.length });
      const ul = el('ul', 'files');
      for (const f of d.digest.files.slice(0, 40)) {
        const li = el('li');
        li.append(el('span', 'n', f.count));
        const parts = String(f.path).split(/[\\/]/);
        const name = parts.pop();
        const box = el('span', 'p');
        if (parts.length) box.append(el('span', 'dir', `${parts.slice(-2).join('/')}/`));
        box.append(document.createTextNode(name));
        li.append(box);
        ul.append(li);
      }
      q.body.append(ul);
      stack.append(q.section);
    }
  } else if (error) {
    const p = panel('詳細を読み込めませんでした');
    p.body.append(el('p', 'note', error));
    stack.append(p.section);
  } else {
    stack.append(el('div', 'loading', 'ログを読んでいます…'));
  }

  const basics = panel('セッションの状態', { id: SEC.basics });
  sections.push({ id: SEC.basics, label: 'セッションの状態' });
  const dl = el('dl', 'facts');
  const idleNode = el('dd', null, since(idleOf(row)));
  idleNode.dataset.liveIdle = row.sessionId;
  if (row.lastActivityAt) idleNode.title = stamp(row.lastActivityAt);
  fact(dl, '判定の根拠', row.stateReason);
  dl.append(el('dt', null, '最後の動きから'), idleNode);
  fact(dl, '登録簿の status', row.statusRaw);
  fact(dl, '権限モード', row.permissionMode);
  fact(dl, 'モデル', shortModel(row.model));
  fact(dl, '思考量', row.effort);
  fact(dl, '文脈の量', row.contextTokens ? `${row.contextTokens.toLocaleString('ja-JP')} tokens` : null);
  fact(dl, 'ブランチ', row.gitBranch);
  fact(dl, 'PID', row.pid);
  fact(dl, 'バージョン', row.version);
  fact(dl, 'セッションID', row.sessionId);
  if (row.startedAt) fact(dl, '開始', stamp(row.startedAt));
  if (d) {
    fact(dl, 'やり取りの回数', `${d.digest.stats.turns} 往復 / ツール ${d.digest.stats.toolCalls} 回`);
    fact(dl, 'ログの大きさ', `${Math.round(d.log.size / 1024).toLocaleString('ja-JP')} KB / ${d.log.entries} 行`);
    if (d.log.parseErrors) fact(dl, '読めなかった行', `${d.log.parseErrors} 行`);
  }
  basics.body.append(dl);

  // 待ちの集計。1つも測れていなければ行も注記も出さない
  const waits = d?.digest?.stats?.waits;
  if (waits) {
    const wdl = el('dl', 'facts facts-waits');
    fact(wdl, WAIT_LABELS.answer, waitFact(waits.answer));
    fact(wdl, WAIT_LABELS.plan, waitFact(waits.plan));
    fact(wdl, WAIT_LABELS.denial, waitFact(waits.denial));
    fact(wdl, WAIT_LABELS.reply, waitFact(waits.reply));
    fact(wdl, WAIT_LABELS.tool, waitFact(waits.tool));
    if (wdl.childElementCount > 0) {
      basics.body.append(wdl);
      // 注記は必ず添える。数字だけを出すと「迷っていた時間」と読まれる
      basics.body.append(el('p', 'note', WAIT_NOTE));
    }
  }

  stack.append(basics.section);

  // ジャンプ用リンクはパネルを積み終わってから作る（あるものだけを並べたいので）
  const nav = navBlock(sections);
  if (nav) wrap.append(nav);

  wrap.append(stack);
  dom.detail.append(wrap);
}

/* ------------------------------------------------------ 詳細の取得と保持 */

/** sessionId から {mark, data}。mark が変わっていなければ再取得しない */
const detailCache = new Map();
const DETAIL_CACHE_MAX = 8;
let detailToken = 0;

/**
 * 詳細キャッシュの目印。
 *
 * lastActivityAt は使えない。サーバの SSE 差分判定がこのキーを比較から外しているので、
 * 会話が進んでも push されず目印が動かない。それで詳細が開いたときのまま止まっていた。
 * logSize は追記しか起きないので単調に増える。
 *
 * 一覧に居ないセッションは追記が止まっているものなので、前に取った詳細の大きさで代える。
 * 0 は「大きさが取れなかった」＝不明の意味にして、必ず取り直す。
 * 0 を有効な目印にすると、大きさが取れない行で古い内容を出し続けることになる。
 *
 * @param {string} sessionId
 * @returns {number} 0 は不明
 */
function detailStampOf(sessionId) {
  const row = rowOf(sessionId);
  if (row) return row.logSize ?? 0;
  return detailCache.get(sessionId)?.data?.log?.size ?? 0;
}

/** いま選んでいるセッションの取得エラー。前のセッションのものは無関係なので出さない */
function detailErrorNow() {
  return store.detailErrorFor === store.selected ? store.detailError : null;
}

async function loadDetail(sessionId, { silent = false } = {}) {
  if (!sessionId) {
    store.detail = null;
    renderDetail();
    return;
  }

  const mark = detailStampOf(sessionId);
  const cached = detailCache.get(sessionId);
  // 目印が不明（0）のときは一致と見なさない。0 同士を突き合わせると永久にキャッシュが効く
  if (cached && mark !== 0 && cached.mark === mark) {
    store.detail = cached.data;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetail();
    return;
  }

  const token = ++detailToken;
  if (!silent) {
    store.detail = null;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetail();
  }

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    if (!res.ok) {
      // サーバは理由を日本語で返してくる。HTTP 404 より読める文言になるので、あればそれを出す
      const reason = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 選び直したあとに古い応答が届いても無視する
    if (token !== detailToken || store.selected !== sessionId) return;
    // 目印は一覧の logSize を優先し、無ければ取れた詳細の大きさで代える。
    // ここで不明（0）のまま入れると、次の push で必ず取り直しになる
    detailCache.set(sessionId, { mark: mark || data.log?.size || 0, data });
    if (detailCache.size > DETAIL_CACHE_MAX) {
      detailCache.delete(detailCache.keys().next().value);
    }
    store.detail = data;
    store.detailError = null;
    store.detailErrorFor = null;
  } catch (err) {
    if (token !== detailToken) return;
    store.detail = null;
    store.detailError = err.message;
    store.detailErrorFor = sessionId;
  }
  renderDetail();
}

/**
 * @param {string|null} sessionId
 * @param {'live'|'query'|'archive'} [from] 選んだ経路。store.selectedFrom の説明を参照
 */
function select(sessionId, from = 'live') {
  if (store.selected === sessionId) return;
  store.selected = sessionId || null;
  store.selectedFrom = store.selected ? from : null;
  // 印は両方の一覧に付け直す。書庫で選んだあと稼働中に戻ったとき、
  // 同じセッションが両方に居ることがある
  for (const node of [...dom.list.querySelectorAll('.card'), ...dom.archive.querySelectorAll('.card')]) {
    node.setAttribute('aria-current', String(node.dataset.sessionId === store.selected));
  }
  syncQuery();
  loadDetail(store.selected);
}

/* ------------------------------------------------------------ データ取得 */

const initialSession = query.get('session');
let firstApply = true;

function apply(payload) {
  store.rows = payload.rows ?? [];
  store.meta = payload.meta ?? null;
  if (payload.meta?.now) store.now = payload.meta.now;
  // 一覧から選んでいたセッションが一覧から消えたら選択を外す。
  // ?session= で直に開いたものは一覧に居ないのが正常なので、push 1回で外してはいけない
  if (store.selected && store.selectedFrom === 'live'
    && !store.rows.some((r) => r.sessionId === store.selected)) {
    store.selected = null;
    store.selectedFrom = null;
  }
  if (firstApply) {
    firstApply = false;
    // 一覧にあるかどうかで判定しない。24時間より古いセッションも開けるようにするため。
    // 実在するかはサーバの応答で決まり、無ければ詳細側にエラーが出る
    if (initialSession) {
      store.selected = initialSession;
      store.selectedFrom = store.rows.some((r) => r.sessionId === initialSession) ? 'live' : 'query';
    }
  }
  // 何も選んでいなければ先頭を開く。並び順の先頭が最も急ぐものなので、
  // 開いた瞬間に見るべきものが出ている状態にする
  if (!store.selected) {
    store.selected = visibleRows()[0]?.sessionId ?? null;
    store.selectedFrom = store.selected ? 'live' : null;
  }
  // 開いているものを URL に残す。押して選んだときは select が書くが、
  // ここで自動的に決まった分（先頭を開く・?session= の取り込み）は通らない
  syncQuery();
  // まとめは書庫を出しているあいだも動かす。「誰かが待っている」の唯一の合図なので
  renderSummary();
  // 書庫を出しているあいだ #list には触らない。replaceChildren すると
  // 見えていない一覧のスクロール位置が毎秒先頭へ飛ぶ
  if (store.tab !== 'archive') renderList();
  renderDetail();
  // 詳細は中身が変わっていなければ取り直さない。
  // silent にして、取り直しのあいだも前の内容を出したままにする
  loadDetail(store.selected, { silent: true });
}

function setLive(state, label) {
  dom.live.dataset.live = state;
  dom.live.textContent = label;
}

async function fetchOnce() {
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    apply(await res.json());
    return true;
  } catch (err) {
    setLive('off', `取得できません（${err.message}）`);
    return false;
  }
}

function connect() {
  let source;
  try {
    source = new EventSource('/api/stream');
  } catch {
    // SSE が使えない環境向けの保険
    setInterval(fetchOnce, 3000);
    fetchOnce();
    return;
  }

  source.addEventListener('open', () => setLive('on', 'つながっています'));
  source.addEventListener('sessions', (ev) => {
    setLive('on', 'つながっています');
    try {
      apply(JSON.parse(ev.data));
    } catch {
      /* 壊れたフレームは捨てる */
    }
  });
  source.addEventListener('tick', (ev) => {
    try {
      const { now } = JSON.parse(ev.data);
      if (now) {
        store.now = now;
        refreshTimes();
      }
    } catch {
      /* 無視 */
    }
  });
  source.addEventListener('error', () => setLive('off', '切れました。再接続中'));
}

/* -------------------------------------------------------- 狭い画面の一覧 */

/** 引き出しに切り替わる幅。CSS のメディアクエリと同じ値にする */
const NARROW = matchMedia('(max-width: 860px)');

/**
 * 引き出しが閉じているあいだ、一覧に触れないようにする。
 *
 * 閉じた引き出しは画面の外にあるだけで、消えてはいない。
 * このままだと見えていないカードに Tab で入り込めるので、inert で丸ごと外す。
 * CSS の visibility でも隠せるが、切り替わりが1フレームで確定せず、
 * 開いた直後に focus を移せなくなるため使わない。
 */
function syncListInert() {
  dom.listPane.inert = NARROW.matches && !dom.app.classList.contains('is-list-open');
}

/**
 * 一覧の引き出しを開閉する。
 *
 * 狭い画面では一覧が画面の手前に出てくる。開けっぱなしにする理由が無いので、
 * 選んだら自分で引っ込む。広い画面では一覧が常に見えているため何もしない。
 *
 * @param {boolean} open 開くなら true
 * @param {HTMLElement|null} moveFocusTo 閉じたあとに focus を移す先
 */
function setListOpen(open, moveFocusTo = null) {
  const changed = dom.app.classList.contains('is-list-open') !== open;
  dom.app.classList.toggle('is-list-open', open);
  dom.listToggle.setAttribute('aria-expanded', String(open));
  dom.listToggle.setAttribute('aria-label', open ? 'セッション一覧を閉じる' : 'セッション一覧を開く');
  syncListInert();

  // 広い画面では引き出し自体が無い。focus を勝手に動かすと操作を横取りしてしまう
  if (!changed || !NARROW.matches) return;

  if (open) {
    // 選ぶために開いたので、選べる場所へ移る
    const card = dom.list.querySelector('.card[aria-current="true"]') ?? dom.list.querySelector('.card');
    card?.focus();
  } else if (moveFocusTo) {
    moveFocusTo.focus();
  }
}

function initListDrawer() {
  dom.listToggle.addEventListener('click', () => {
    const open = !dom.app.classList.contains('is-list-open');
    setListOpen(open, dom.listToggle);
  });

  dom.listClose.addEventListener('click', () => setListOpen(false, dom.listToggle));
  dom.scrim.addEventListener('click', () => setListOpen(false, dom.listToggle));

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !dom.app.classList.contains('is-list-open')) return;
    ev.preventDefault();
    setListOpen(false, dom.listToggle);
  });

  // 幅が変わったら、その幅に合う状態へ戻す。
  // 広い画面では一覧が常に見えているので、開いた状態も触れない状態も残さない
  NARROW.addEventListener('change', (ev) => {
    if (ev.matches) syncListInert();
    else setListOpen(false);
  });

  syncListInert();
}

/* ------------------------------------------------------------------ 起動 */

function initTheme() {
  const forced = query.get('theme');
  if (forced === 'dark' || forced === 'light') {
    document.documentElement.setAttribute('data-theme', forced);
  }

  const saved = forced ? null : localStorage.getItem('claude-deck.theme');
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (!forced) {
    document.documentElement.removeAttribute('data-theme');
  }

  dom.themeToggle.addEventListener('click', () => {
    const root = document.documentElement;
    const now = root.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('claude-deck.theme', next);
  });
}

/**
 * 一覧の中で上下キーで移動できるようにする。
 *
 * 稼働中と書庫で同じ操作にする。選んだ経路（from）だけが違う。
 *
 * @param {HTMLElement} listEl 対象の一覧
 * @param {'live'|'archive'} from 選んだ経路
 */
function initListKeys(listEl, from) {
  listEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const cards = [...listEl.querySelectorAll('.card')];
    const at = cards.indexOf(document.activeElement);
    if (at === -1) return;
    const next = cards[at + (ev.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      ev.preventDefault();
      next.focus();
      select(next.dataset.sessionId, from);
    }
  });
}

/** 書庫タブの配線。store.tab は保存しないので、初期値は URL だけから決まる */
function initTabs() {
  dom.tabLive.addEventListener('click', () => setTab('live'));
  dom.tabArchive.addEventListener('click', () => setTab('archive'));

  dom.archiveQ.value = store.archive.q ?? '';
  dom.archiveSort.value = store.archive.sort;
  dom.archiveDeep.checked = store.archive.deep;

  dom.archiveQ.addEventListener('input', () => {
    const next = dom.archiveQ.value.trim() || null;
    if (next === store.archive.q) return;
    store.archive.q = next;
    syncQuery();
    // 打っている途中で毎回引かない。1文字ごとにサーバにログを開かせることになる
    if (archiveTimer) clearTimeout(archiveTimer);
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      loadArchive();
    }, ARCHIVE_DEBOUNCE_MS);
  });

  // 意図した1クリックなので、こちらは即時に引き直す
  dom.archiveDeep.addEventListener('change', () => {
    store.archive.deep = dom.archiveDeep.checked;
    loadArchive();
  });

  dom.archiveSort.addEventListener('change', () => {
    const v = dom.archiveSort.value;
    store.archive.sort = ARCHIVE_SORTS.has(v) ? v : 'recent';
    syncQuery();
    loadArchive();
  });

  setTab(store.tab, { sync: false });
}

initTheme();
initListDrawer();
initTabs();
initListKeys(dom.list, 'live');
initListKeys(dom.archive, 'archive');

dom.onlyLive.checked = store.onlyLive;
dom.onlyLive.addEventListener('change', () => {
  store.onlyLive = dom.onlyLive.checked;
  localStorage.setItem('claude-deck.onlyLive', store.onlyLive ? '1' : '0');
  renderList();
  // 絞り込みで選んでいた行が消えたら、見えている先頭に移す
  const visible = visibleRows();
  if (!visible.some((r) => r.sessionId === store.selected)) {
    select(visible[0]?.sessionId ?? null);
  }
});

// 手で押したときは詳細も取り直す。中身が同じでも読み直したい場面のためのボタンなので
dom.reload.addEventListener('click', () => {
  detailCache.clear();
  fetchOnce();
});

fetchOnce().then(() => {
  // つなぎっぱなしの接続があるとヘッドレスブラウザがロード完了を待ち続ける。
  // 見た目の確認を撮るときは ?nolive=1 で止める
  if (query.get('nolive') === '1') {
    setLive('off', '自動更新なし');
    return;
  }
  connect();
});
