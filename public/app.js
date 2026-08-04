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
 *  ?tq=<語> … 時系列の検索語
 *  ?hide=<種類,種類> … 時系列で隠す種類。空で付けると「何も隠さない」になる
 *  ?nolive=1 … 自動更新をつながない
 *  ?tab=archive … 書庫（終了したものも含む全セッション）を開いた状態にする
 *  ?aq=<語> … 書庫の検索語
 *  ?asort=recent|oldest|size … 書庫の並び順
 */
const query = new URLSearchParams(location.search);

/** 書庫の並び順。サーバ側（view/archive.mjs の SORTS）と同じ語を使う */
const ARCHIVE_SORTS = new Set(['recent', 'oldest', 'size']);

/**
 * 時系列で既定から隠す種類。
 *
 * 足跡（trace）は件数が桁で多い。既定で出すと判断の記録が埋もれる。
 *
 * 拒否リストで持つのが要点。許可リストにすると、サーバが新しい種類を足したときに
 * 既定で見えなくなる。「未知の形で落ちない」は、黙って消えないことも含む。
 * 副産物として「足跡は既定オフ、1回押せば以後オン」が特別扱いではなく初期値1つで済む
 */
const HIDDEN_KINDS_DEFAULT = ['trace'];

/**
 * 隠している種類の初期値を決める。
 *
 * ?hide= と localStorage は「キーが無い」と「空で付いている」を分けて見る。
 * 空の指定は「何も隠さない」という意思なので、既定に戻してはいけない。
 * これで「既定のまま」「何も隠さない」「これだけ隠す」の3つを人に渡せる
 */
function initialHiddenKinds() {
  const fromUrl = query.get('hide');
  const raw = fromUrl !== null ? fromUrl : localStorage.getItem('claude-deck.hiddenKinds');
  if (raw === null) return new Set(HIDDEN_KINDS_DEFAULT);
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

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
   * 時系列をいま何件まで出しているか。
   *
   * 0 は「まだ整えていない」。最初の描画で TL_PAGE に直る。
   * ここで TL_PAGE を初期値に書けないのは、定数の宣言がこの下にあるため
   */
  tlShown: 0,
  /**
   * その窓がどのセッションのものか。
   *
   * 窓を先頭に戻すのはセッションを選び直したときだけにする。追記で詳細が入れ替わるたびに
   * 戻すと、動いているセッションでは2秒ごとに「続きを出す」が巻き戻る
   */
  tlShownFor: null,
  /** 時系列の検索語。null は「検索していない」。空文字は作らない */
  tq: (query.get('tq') ?? '').trim() || null,
  /** 時系列で隠している種類（拒否リスト）。HIDDEN_KINDS_DEFAULT の説明を参照 */
  hiddenKinds: initialHiddenKinds(),
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
 * 触るキーは session / only / tq / hide / tab / aq / asort だけ。
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
  set('tq', store.tq);
  // 隠している種類は「既定と同じなら書かない」。空の指定（何も隠さない）は空文字のまま残す。
  // set() は空文字を消してしまうので、ここだけ直に書く
  const hide = [...store.hiddenKinds].sort().join(',');
  if (hide === [...HIDDEN_KINDS_DEFAULT].sort().join(',')) params.delete('hide');
  else params.set('hide', hide);
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

/**
 * かかった時間。since() と違って秒より下を捨てない。
 *
 * ツールの往復は 200ms で終わるものが多く、since() に渡すと「0秒」が縦に並ぶ。
 * 1秒未満はミリ秒で出し、それ以上は since() に任せる（分・時間の粒度を持っている）。
 * @param {number|null} ms かかった時間。取れていなければ null
 */
function dur(ms) {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return since(ms);
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
  // ふつうのツール呼び出し。既定では隠している（HIDDEN_KINDS_DEFAULT）。
  // 絞り込みのチップにも同じ語が出るので、ここを直せば両方が変わる
  trace: '足跡',
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

/* --------------------------------------------------------- 時系列の絞り込み */

/**
 * 検索語に当たった所を <mark> で囲んだ節点の並びを返す。
 *
 * innerHTML は使わない。当たった所は要素として作り、それ以外は createTextNode で入れる。
 * ログ本文にタグが書かれていても、ただの文字として出る。
 *
 * 正規表現も使わない。検索語は人が打つ文字列なので、記号のたびにエスケープが要る。
 *
 * @param {string|null} text
 * @param {string|null} needle 検索語。null なら素の文字として1つ返す
 * @returns {Array<Node>}
 */
function markUp(text, needle) {
  const t = String(text ?? '');
  if (!needle) return [document.createTextNode(t)];

  // 大小を無視して探す。ただし toLowerCase で長さが変わる文字（İ など）が混ざると
  // 元の文字列と位置がずれて、関係ない所を切り出す。
  // そのときだけ大小を区別する検索に落とす。ずれた強調を出すより外れるほうがまし
  const lower = t.toLowerCase();
  const nLower = needle.toLowerCase();
  const exact = lower.length !== t.length || nLower.length !== needle.length;
  const hay = exact ? t : lower;
  const pin = exact ? needle : nLower;

  const out = [];
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) break;
    if (hit > from) out.push(document.createTextNode(t.slice(from, hit)));
    out.push(el('mark', null, t.slice(hit, hit + pin.length)));
    from = hit + pin.length;
  }
  if (!out.length) return [document.createTextNode(t)];
  if (from < t.length) out.push(document.createTextNode(t.slice(from)));
  return out;
}

/**
 * 検索語の強調つきで節点を1つ作る。
 *
 * el() と同じ形で呼べるようにしてある。needle が null なら el() と同じものができる
 */
function marked(tag, className, text, needle) {
  const node = el(tag, className);
  node.append(...markUp(text, needle));
  return node;
}

/** 検索語が何回出てくるか。markUp と同じ数え方（大小は無視、重なりは数えない） */
function countHits(text, needle) {
  if (!needle) return 0;
  const hay = String(text ?? '').toLowerCase();
  const pin = needle.toLowerCase();
  if (!pin) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) return n;
    n += 1;
    from = hit + pin.length;
  }
}

/**
 * この item を検索語と突き合わせる文字列。
 *
 * 対象は画面に出している文字だけにする。出していないものに当てると
 * 「一致したのに、その行を見ても語が無い」行が出てしまう
 */
function searchableOf(item) {
  const parts = [KIND_LABELS[item.kind] ?? item.kind];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };
  push(item.text);
  push(item.tool);
  push(item.detail);
  push(item.note);
  push(item.message);
  push(item.skill);
  push(item.args);
  push(item.command);
  push(item.agentType);
  push(item.description);
  push(item.denialLabel);
  push(item.plan);
  push(item.feedback);
  push(item.planFile);
  // 足跡は畳んだ中に文字がある。畳んでいても画面には出しているので検索の対象に入れる
  for (const t of item.tools ?? []) push(t);
  for (const c of item.calls ?? []) {
    push(c.tool);
    push(c.detail);
    push(c.head);
  }
  for (const a of item.answers ?? []) {
    push(a.question);
    push(a.chosen);
    push(a.header);
    for (const o of [...(a.chosenOptions ?? []), ...(a.otherOptions ?? [])]) {
      push(o.label);
      push(o.description);
    }
  }
  return parts.join('\n');
}

/**
 * searchableOf の結果を item ごとに覚える。
 *
 * item は詳細を取り直すまで同じ参照なので、1文字打つたびに組み直さなくて済む。
 * WeakMap なので詳細が入れ替われば古い分は勝手に消える
 */
const searchCache = new WeakMap();

/** 覚えてあれば使う。 */
function searchTextOf(item) {
  let s = searchCache.get(item);
  if (s === undefined) {
    s = searchableOf(item);
    searchCache.set(item, s);
  }
  return s;
}

/**
 * 時系列を絞り込む。
 *
 * 順序は「種類 → 検索語」。逆にすると見出しの件数が何を数えたものか読めなくなる
 * （検索で 12 件に絞ったあと種類で隠すと、12 は消えた行を含んだ数になる）。
 *
 * 「判断だけ」は種類の絞り込みとは独立させて AND する。
 * 種類の集合の preset にすると、既存の ?only=1 と localStorage の意味が変わってしまう
 */
function filterTimeline(items) {
  let out = items;
  if (store.hiddenKinds.size) out = out.filter((i) => !store.hiddenKinds.has(i.kind));
  if (store.onlyDecisions) out = out.filter((i) => DECISION_KINDS.has(i.kind));
  if (store.tq) {
    const pin = store.tq.toLowerCase();
    out = out.filter((i) => searchTextOf(i).toLowerCase().includes(pin));
  }
  return out;
}

/**
 * 種類ごとの件数。チップの並びを作るのに使う。
 *
 * 並びは KIND_LABELS の順に固定する。多い順にすると、セッションを切り替えるたびに
 * チップの位置が入れ替わって押し間違える。知らない種類は後ろに足す（黙って消さない）
 */
function countKinds(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const ordered = new Map();
  for (const kind of Object.keys(KIND_LABELS)) {
    if (counts.has(kind)) ordered.set(kind, counts.get(kind));
  }
  for (const [kind, n] of counts) {
    if (!ordered.has(kind)) ordered.set(kind, n);
  }
  return ordered;
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
 * @param {string|null} [needle] 検索語。当たった所を強調する
 */
function bodyText(text, limit, maxLines, fullLength = null, needle = null) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const lines = t.split('\n');
  if (t.length <= limit && lines.length <= maxLines) return [marked('div', 'tl-text', t, needle)];

  let head = lines.slice(0, maxLines).join('\n');
  if (head.length > limit) head = head.slice(0, limit);
  const more = el('details', 'more');
  // ここで持っているのが本当の全文かどうかで文言を変える。サーバ側が既に切っているのに
  // 「全文」と書くと嘘になる（say は 1,200 字、recap は 2,000 字で切られている）
  const clipped = typeof fullLength === 'number' && fullLength > t.length;
  const label = clipped
    ? `全 ${fullLength.toLocaleString('ja-JP')} 字（このうち ${t.length.toLocaleString('ja-JP')} 字まで表示）`
    : `全文（${t.length.toLocaleString('ja-JP')}字）`;
  // 検索語が頭出しに無く、続きの中にあるときは開いた状態で出す。
  // 閉じたまま出すと「一致した行なのに、見ても語が見つからない」ことになる
  const hits = countHits(t, needle);
  if (hits > countHits(head, needle)) more.open = true;
  more.append(el('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label));
  more.append(marked('pre', null, t, needle));
  return [marked('div', 'tl-text', `${head.trimEnd()}…`, needle), more];
}

/**
 * 回答1件を描く。
 *
 * compact のときは質問と選んだ答えだけ。時系列の中では短くしたいので。
 * それ以外は選択肢の説明と、選ばなかった案も出す。
 * 説明文が「その選択が何を意味していたか」なので、判断の理由がここに残る。
 *
 * @param {object} a digest の answer 1件
 * @param {boolean} compact 時系列の中で短く出すか
 * @param {string|null} [needle] 検索語
 */
function answerBlock(a, compact, needle = null) {
  const wrap = el('div', 'decision');
  wrap.append(marked('div', 'decision-q', a.question || '(質問文なし)', needle));

  const box = el('div', 'decision-a');
  if (a.freeText) box.classList.add('is-free');
  if (a.chosen) {
    box.append(marked('div', 'label', a.chosen, needle));
    const why = a.chosenOptions?.[0]?.description;
    if (!compact && why) box.append(marked('p', 'why', why, needle));
    else if (!compact && a.freeText) box.append(el('p', 'why', '選択肢から選ばず、自分で書いた回答'));
  } else {
    box.append(el('div', 'label', '（まだ回答していません）'));
  }
  wrap.append(box);

  if (!compact && a.otherOptions?.length) {
    const d = el('details', 'rejected');
    d.append(el('summary', null, `選ばなかった案 ${a.otherOptions.length} 件`));
    const ul = el('ul');
    let hits = 0;
    for (const o of a.otherOptions) {
      const li = el('li');
      li.append(marked('span', 'label', o.label, needle));
      if (o.description) li.append(...markUp(` — ${o.description}`, needle));
      hits += countHits(o.label, needle) + countHits(o.description, needle);
      ul.append(li);
    }
    // 当たった所が畳んだ中にしか無いときは開いて出す。閉じたままだと語が見つからない
    if (hits) d.open = true;
    d.append(ul);
    wrap.append(d);
  }
  return wrap;
}

/**
 * @param {object} item digest の plan 1件
 * @param {boolean} compact 全文を畳むだけにするか
 * @param {string|null} [needle] 検索語
 */
function planBlock(item, compact, needle = null) {
  const box = el('div', 'tl-body');
  const status = item.pending ? '承認を待っています' : item.approved ? '承認済み' : '差し戻し';
  const line = el('div', 'tl-text', status);
  // パスは等幅で出す。和文フォントに落ちると \ が ¥ の字形になって別物に見えるため
  if (item.planFile) {
    line.append(' — ');
    line.append(marked('span', 'mono', item.planFile, needle));
  }
  box.append(line);
  if (item.feedback) box.append(marked('pre', 'tl-detail', item.feedback, needle));
  if (item.plan && !compact) {
    const d = el('details', 'more');
    const hits = countHits(item.plan, needle);
    d.append(el('summary', null, hits ? `プラン全文　一致 ${num(hits)} 件` : 'プラン全文'));
    if (hits) d.open = true;
    d.append(marked('pre', null, item.plan, needle));
    box.append(d);
  }
  return box;
}

/**
 * 原文（会話ログの1行）を開ける折りたたみを作る。
 *
 * 押されたときだけ取りに行く。時系列には最大 400 行あるので、前もって全部取ると
 * 詳細を開くだけで数百回の往復になる。
 *
 * モーダルにしない理由が3つ。既存の「全文」と同じ操作感になる。focus trap が要らない。
 * そして Escape のハンドラは一覧の引き出しが開いているあいだ常に preventDefault() するので、
 * モーダルにすると閉じ方をそこと調停する仕組みが要る。
 *
 * 取得に失敗したときは done を立てない。閉じて開き直せば取り直せる。
 *
 * @param {((uuid: string) => (string|null))|null} makeUrl 取得先を作る関数。
 *   関数を渡す形にするのは、サブエージェントの記録を同じ timelineItem で描くときに
 *   子ログの uuid を親の URL へ投げる事故を防ぐため。
 *   これで timelineItem から store.selected への隠れた依存も消える
 * @param {string|null} uuid 開きたい行の uuid。elided は null なので出さない
 * @returns {HTMLElement|null}
 */
function rawBlock(makeUrl, uuid) {
  if (typeof makeUrl !== 'function' || !uuid) return null;
  const url = makeUrl(uuid);
  if (!url) return null;

  const d = el('details', 'more raw');
  d.append(el('summary', null, '原文'));
  const out = el('pre', 'raw-body');
  d.append(out);

  let done = false;
  let loading = false;
  d.addEventListener('toggle', async () => {
    if (!d.open || done || loading) return;
    loading = true;
    out.textContent = '読み込んでいます…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 伏せた・切ったを断ってから出す。黙って加工すると原文だと思って読まれる
      const notes = [];
      if (data.masked) notes.push('鍵らしい値は伏せてあります');
      if (data.truncated) notes.push('長すぎる所は切ってあります');
      const head = notes.length ? `※ ${notes.join(' / ')}\n\n` : '';
      out.textContent = `${head}${JSON.stringify(data.entry, null, 2)}`;
      done = true;
    } catch (err) {
      out.textContent = `原文が取れません: ${err.message}`;
    } finally {
      loading = false;
    }
  });
  return d;
}

/**
 * 原文の取得先を作る関数を返す。
 *
 * @param {string|null} sessionId いま開いているセッション
 * @returns {(uuid: string) => (string|null)}
 */
function rawUrlFor(sessionId) {
  return (uuid) => (sessionId && uuid
    ? `/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(uuid)}`
    : null);
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

/**
 * 時系列の1行。
 *
 * @param {object} item digest の item
 * @param {object} [ctx] 描くときの文脈。{needle} 検索語 / {rawUrl} 原文の取得先を作る関数
 */
function timelineItem(item, ctx = {}) {
  const needle = ctx.needle ?? null;
  const row = el('div', 'tl');
  row.dataset.kind = item.kind;

  if (item.kind === 'compact') {
    const body = el('div', 'tl-body');
    const from = num(item.preTokens);
    const to = num(item.postTokens);
    const trigger = item.trigger === 'auto' ? '自動' : item.trigger ?? '';
    body.append(el('div', 'tl-text',
      `ここで文脈が圧縮されました（${from} → ${to} tokens${trigger ? ` / ${trigger}` : ''}）。これより前の細部は Claude 側にも残っていません`));
    const compactRaw = rawBlock(ctx.rawUrl, item.uuid);
    if (compactRaw) body.append(compactRaw);
    row.append(body);
    return row;
  }

  row.append(whenNode(item.at));
  const body = el('div', 'tl-body');
  const kindRow = el('div', 'tl-kind');
  kindRow.append(...markUp(KIND_LABELS[item.kind] ?? item.kind, needle));
  // 前のやり取りからの間。取れていない行には何も付かない
  const wait = waitBadge(item.wait);
  if (wait) kindRow.append(wait);
  body.append(kindRow);

  switch (item.kind) {
    // 自分の指示は判断の記録そのものなので、Claude の説明より長く出す
    case 'prompt':
      body.append(...bodyText(item.text, 900, 12, null, needle));
      break;
    case 'say':
      body.append(...bodyText(item.text, 260, 4, item.fullLength, needle));
      break;
    // Claude の自己申告。時系列でもその場で断ってから本文を出す
    case 'recap':
      body.append(el('p', 'note', 'Claude 自身が書いた中間報告です。機械的に抜き出した記録ではありません'));
      body.append(...bodyText(item.text, 600, 8, item.fullLength, needle));
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
      for (const a of item.answers ?? []) body.append(answerBlock(a, false, needle));
      break;
    case 'plan':
      body.append(...planBlock(item, false, needle).childNodes);
      break;
    case 'denial':
      body.append(marked('div', 'tl-text', `${item.denialLabel} — ${item.tool}`, needle));
      if (item.detail) body.append(marked('pre', 'tl-detail', item.detail, needle));
      // note は定型文を除いた残り。自分が添えたコメントがあればここに出る
      if (item.note) body.append(marked('pre', 'tl-detail', item.note, needle));
      break;
    case 'interrupt':
      body.append(el('div', 'tl-text', 'ここで実行を止めた'));
      break;
    case 'skill':
      body.append(marked('div', 'tl-text', item.args ? `/${item.skill} ${item.args}` : `/${item.skill}`, needle));
      break;
    case 'agent':
      body.append(marked('div', 'tl-text',
        [item.agentType, item.description].filter(Boolean).join(' — ') || '(説明なし)', needle));
      break;
    case 'error':
      body.append(marked('div', 'tl-text', `${item.tool}${item.detail ? ` — ${item.detail}` : ''}`, needle));
      if (item.message) body.append(marked('pre', 'tl-detail', item.message, needle));
      break;
    case 'slash':
      body.append(marked('div', 'tl-text', item.args ? `${item.command} ${item.args}` : item.command, needle));
      break;
    // 足跡。assistant の1行につき1件で、並列に呼んだ分は calls にまとまっている。
    // 既定では畳んでおく。1件ずつ広げると、ここだけで画面が埋まって判断の記録が流れる
    case 'trace': {
      const tools = item.tools?.length ? item.tools.join(' / ') : 'ツール';
      const label = [
        `${tools}${item.count > 1 ? ` ×${item.count}` : ''}`,
        typeof item.durationMs === 'number' ? dur(item.durationMs) : null,
      ].filter(Boolean).join('　');
      const d = el('details', 'more trace');
      // 畳んだ中に検索語があるときは開いて出す。閉じたままだと語が見つからない
      const inner = (item.calls ?? [])
        .map((c) => [c.tool, c.detail, c.head].filter(Boolean).join(' '))
        .join('\n');
      const hits = countHits(inner, needle);
      d.append(marked('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label, needle));
      if (hits) d.open = true;

      const ul = el('ul', 'trace-calls');
      for (const c of item.calls ?? []) {
        const li = el('li');
        const line = el('div', 'trace-head');
        line.append(marked('span', 'mono', c.tool ?? '?', needle));
        if (c.detail) line.append(marked('span', 'trace-detail', c.detail, needle));
        if (c.pending) {
          // 結果が来ていない。いま止まっているのがここだと分かる
          line.append(el('span', 'trace-n', '結果を待っています'));
        } else {
          if (typeof c.durationMs === 'number') line.append(el('span', 'trace-n', dur(c.durationMs)));
          // 0 字と「測れなかった」を分ける。null のときは何も出さない
          if (typeof c.resultChars === 'number') line.append(el('span', 'trace-n', `${num(c.resultChars)} 字`));
        }
        li.append(line);
        // 結果の先頭だけ。中身が要るときは原文へ戻る
        if (c.head) li.append(marked('div', 'trace-result', c.head, needle));
        ul.append(li);
      }
      d.append(ul);
      body.append(d);
      break;
    }
    default:
      body.append(el('div', 'tl-text', JSON.stringify(item)));
  }

  // 原文へ戻る口。同じ assistant 行から複数の item が出るので、これは「この行を開く」意味になる
  const raw = rawBlock(ctx.rawUrl, item.uuid);
  if (raw) body.append(raw);

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
    // あとから件数だけ差し替えるための目印。時系列は絞り込みで数が動く
    b.dataset.sec = s.id;
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

/* -------------------------------------------------------- 時系列の描き直し */

/**
 * 1回に出す時系列の件数。
 *
 * 400件を前もって全部組むと初回の描画が重い。窓を掛けて、末尾のボタンで継ぎ足す。
 * 120 はふつうの画面でスクロール数回ぶんに収まる量
 */
const TL_PAGE = 120;

/**
 * 時系列だけを描き直すための取っ手。
 *
 * renderDetail() が時系列パネルを組むたびに入れ替える。
 * null のあいだは時系列が画面に無い（未選択・取得中・失敗）ので、renderTimeline() は何もしない。
 *
 * items をここに写して持つのは、開いている時系列と描く材料を食い違わせないため。
 * renderTimeline() から store.detail を見に行くと、押した瞬間に別の詳細が入っていることがある
 */
let tlRef = null;

/**
 * 描画にかかった時間を直近40回ぶんだけ持つ。
 *
 * 道具は足さない。console から deckPerf() を呼べば p95 が出る。
 * 目安は初回の renderDetail() が 50ms 未満、renderTimeline() が 16ms 未満（1フレーム）
 */
const perfLog = { detail: [], timeline: [] };

/** @param {'detail'|'timeline'} kind @param {number} t0 performance.now() の値 */
function mark(kind, t0) {
  const a = perfLog[kind];
  a.push(performance.now() - t0);
  if (a.length > 40) a.shift();
}

window.deckPerf = () => {
  const p95 = (a) => {
    if (!a.length) return null;
    const sorted = [...a].sort((x, y) => x - y);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] * 10) / 10;
  };
  const of = (a) => ({ n: a.length, p95: p95(a), last: a.length ? Math.round(a[a.length - 1] * 10) / 10 : null });
  return { detail: of(perfLog.detail), timeline: of(perfLog.timeline) };
};

/**
 * 検索欄の待ち時間。
 *
 * 1文字ごとに組み直すと、400件の時系列では打っている手が引っかかる。
 * 種類のチップは意図した1回の操作なので、こちらは待たずに即座に反映する
 */
const TL_DEBOUNCE_MS = 120;

let tlSearchTimer = null;

/**
 * 隠している種類を覚える。
 *
 * 空の集合も「何も隠さない」という指定なので、キーごと消さずに空文字で残す。
 * 消してしまうと次に開いたとき既定（足跡を隠す）に戻ってしまう
 */
function saveHiddenKinds() {
  localStorage.setItem('claude-deck.hiddenKinds', [...store.hiddenKinds].join(','));
}

/**
 * 時系列の絞り込み帯を組む。
 *
 * 呼ぶのは renderDetail() だけ。返した節点は .tl-host の外（.timeline の兄弟）に置く。
 * 器の中に入れると renderTimeline() の replaceChildren で入力欄まで作り直され、
 * 1文字打つたびに caret が消えて打ち続けられなくなる
 *
 * @param {Array} all 間引き後の全 item。チップの並びと件数はここから作る
 */
function timelineFilterBar(all) {
  const bar = el('div', 'tl-filter');

  const q = el('input', 'tl-q');
  q.type = 'search';
  q.placeholder = '時系列の中を探す';
  q.setAttribute('aria-label', '時系列を検索');
  // 値の復元は value に入れるだけ。?tq= で開いた人にも打った途中の人にも同じ形で効く
  if (store.tq) q.value = store.tq;
  q.addEventListener('input', () => {
    clearTimeout(tlSearchTimer);
    tlSearchTimer = setTimeout(() => {
      store.tq = q.value.trim() || null;
      // 探した状態を人に渡せるようにする（?tq=）
      syncQuery();
      // 当てはまる件数が変わるので窓は先頭から出し直す
      store.tlShown = TL_PAGE;
      renderTimeline();
    }, TL_DEBOUNCE_MS);
  });
  bar.append(q);

  const kinds = el('div', 'tl-kinds');
  for (const [kind, n] of countKinds(all)) {
    const chip = el('button', 'tl-chip', KIND_LABELS[kind] ?? kind);
    chip.type = 'button';
    chip.append(el('span', 'n', num(n)));
    // 押した状態は「出している」を true とする。隠す種類を持つのは store 側の拒否リスト
    const paint = () => {
      const shown = !store.hiddenKinds.has(kind);
      chip.setAttribute('aria-pressed', String(shown));
      chip.title = shown ? 'この種類を隠す' : 'この種類を出す';
    };
    paint();
    chip.addEventListener('click', () => {
      if (store.hiddenKinds.has(kind)) store.hiddenKinds.delete(kind);
      else store.hiddenKinds.add(kind);
      paint();
      saveHiddenKinds();
      syncQuery();
      store.tlShown = TL_PAGE;
      renderTimeline();
    });
    kinds.append(chip);
  }
  bar.append(kinds);

  return bar;
}

/**
 * 時系列だけを描き直す。
 *
 * 絞り込みや並び替えで変わるのは時系列の中身と件数だけ。それなのに renderDetail() を
 * 呼ぶと、回答パネル・TODO・ファイル・状態の一覧まで作り直すことになる。
 * 開いた <details> とスクロール位置が消え、絞り込みの入力欄では caret が飛ぶ
 */
function renderTimeline() {
  if (!tlRef) return;
  const t0 = performance.now();

  if (store.tlShownFor !== store.selected) {
    store.tlShown = TL_PAGE;
    store.tlShownFor = store.selected;
  }

  const all = tlRef.items;
  const matched = filterTimeline(all);
  const ordered = store.newestFirst ? [...matched].reverse() : matched;
  const shown = ordered.slice(0, Math.max(TL_PAGE, store.tlShown));
  const rest = ordered.length - shown.length;

  const box = el('div', 'timeline');
  // 検索語は1回だけ渡す。timelineItem が store を見に行くと、
  // 描いている途中で語が変わったときに強調と絞り込みが食い違う。
  // 原文の取得先も同じ理由でここで固める（描いている最中に選択が変わっても混ざらない）
  const ctx = { needle: store.tq, rawUrl: rawUrlFor(store.selected) };
  for (const item of shown) box.append(timelineItem(item, ctx));

  const nodes = [box];
  if (!ordered.length) {
    // 「1件も無い」と「絞り込みで消えた」を分ける。後者は戻し方も添える
    nodes.push(el('div', 'empty-note', all.length
      ? '絞り込みに当てはまる行がありません。検索語を消すか、隠している種類を出してください'
      : '時系列に出せる行がありません'));
  }
  if (rest > 0) {
    const more = el('button', 'btn tl-more', `続きを出す（残り ${num(rest)} 件）`);
    more.type = 'button';
    more.addEventListener('click', () => {
      store.tlShown = shown.length + TL_PAGE;
      renderTimeline();
    });
    nodes.push(more);
  }
  tlRef.host.replaceChildren(...nodes);

  // 見出しの件数。窓で切っているときは「出している数 / 当てはまった数」を出す。
  // 全体の数だけを出すと、下に「続きを出す」がある理由が読めない
  const label = shown.length < ordered.length
    ? `${num(shown.length)} / ${num(ordered.length)} 件`
    : store.onlyDecisions
      ? `${num(matched.length)} / ${num(all.length)} 件`
      : `${num(all.length)} 件${tlRef.dropped ? `（説明 ${num(tlRef.dropped)} 件は省略）` : ''}`;
  if (tlRef.count) tlRef.count.textContent = label;
  // 目次の件数も絞り込みで動く。放っておくと古い数が上に残る
  if (tlRef.nav) tlRef.nav.textContent = num(matched.length);

  mark('timeline', t0);
}

/**
 * 詳細ペインを作り直すかどうかの材料。
 *
 * 一覧の push は2秒ごとに来る。そのたびに作り直すと、開いた <details> と
 * スクロール位置が消える。実際に画面へ出している値が動いたときだけ作り直す。
 *
 * idleMs と lastActivityAt は入れない。refreshTimes() が文字だけ差し替えるので
 * 作り直す必要がなく、しかも毎秒動くので入れると条件そのものが意味を失う
 */
function detailKeyOf() {
  const row = headOf(store.selected);
  const w = row?.waitingFor ?? null;
  return [
    store.selected ?? '',
    detailErrorNow() ?? '',
    row?.state ?? '',
    row?.stateLabel ?? '',
    row?.stateReason ?? '',
    row?.statusRaw ?? '',
    row?.alive ? '1' : '0',
    row?.pid ?? '',
    row?.contextTokens ?? '',
    w ? `${w.tool ?? ''}${w.detail ?? ''}` : '',
  ].join('');
}

/** 前回 renderDetail() を通したときの材料。detail は参照そのままで見比べる */
let lastDetailRender = { detail: undefined, key: null };

/**
 * 必要なら詳細ペインを作り直す。
 *
 * apply() と loadDetail() は毎秒ここを通る。作り直すかどうかの判断は detailKeyOf() に寄せた
 */
function renderDetailIfNeeded() {
  if (lastDetailRender.detail === store.detail && lastDetailRender.key === detailKeyOf()) return;
  renderDetail();
}

function renderDetail() {
  const t0 = performance.now();
  // row と呼んでいるのは一覧の行と同じ形のもの。一覧に居なければ詳細から組む
  const row = headOf(store.selected);
  const error = detailErrorNow();
  lastDetailRender = { detail: store.detail, key: detailKeyOf() };
  // 前の取っ手はここで捨てる。作り直したあとの画面に無い節点を掴んだままにしない
  tlRef = null;
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
    mark('detail', t0);
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

    // 押したときに renderDetail() を呼ばない。時系列の中身と件数しか変わらないので、
    // 全体を作り直すと開いた <details> とスクロール位置まで捨てることになる。
    // そのぶん、ボタン自身の見た目（押した状態・並び順の文字）はここで書き換える
    const onlyBtn = toggle('判断だけ', store.onlyDecisions, () => {
      store.onlyDecisions = !store.onlyDecisions;
      localStorage.setItem('claude-deck.onlyDecisions', store.onlyDecisions ? '1' : '0');
      // 開き方を人に渡せるようにする（?only=1）
      syncQuery();
      onlyBtn.setAttribute('aria-pressed', String(store.onlyDecisions));
      // 当てはまる件数が変わるので窓は先頭から出し直す
      store.tlShown = TL_PAGE;
      renderTimeline();
    });
    const orderBtn = toggle(store.newestFirst ? '新しい順' : '古い順', false, () => {
      store.newestFirst = !store.newestFirst;
      localStorage.setItem('claude-deck.newestFirst', store.newestFirst ? '1' : '0');
      orderBtn.textContent = store.newestFirst ? '新しい順' : '古い順';
      // 逆から出すことになるので、窓の続きは意味を持たない
      store.tlShown = TL_PAGE;
      renderTimeline();
    });
    const actions = el('span', 'panel-actions');
    actions.append(onlyBtn, orderBtn);

    // 件数は renderTimeline() が入れる。ここで空文字を渡すのは、入れる先の節点を作らせるため
    const p = panel('時系列', { id: SEC.timeline, count: '', action: actions });
    sections.push({ id: SEC.timeline, label: '時系列', count: '' });
    // 絞り込みの帯は器の外（.timeline の兄弟）に置く。
    // 中に入れると renderTimeline() が入力欄まで作り直し、1文字ごとに caret が飛ぶ
    const host = el('div', 'tl-host');
    p.body.append(timelineFilterBar(d.digest.items), host);
    stack.append(p.section);
    tlRef = {
      host,
      count: p.section.querySelector('h3 .count'),
      nav: null,
      items: d.digest.items,
      dropped: d.digest.stats.droppedItems ?? 0,
    };

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
  if (nav) {
    wrap.append(nav);
    // 目次の件数の差し替え先を拾っておく。パネルが3枚に届かないと目次自体が出ないので、
    // 取れないこともある（renderTimeline() は null を見て素通りする）
    if (tlRef) tlRef.nav = nav.querySelector(`[data-sec="${SEC.timeline}"] .n`);
  }

  wrap.append(stack);
  // 時系列の中身はここで入れる。まだ document に付いていないので、
  // 120件を組んでもレイアウトの計算は1回で済む
  renderTimeline();
  dom.detail.append(wrap);
  mark('detail', t0);
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
    renderDetailIfNeeded();
    return;
  }

  const mark = detailStampOf(sessionId);
  const cached = detailCache.get(sessionId);
  // 目印が不明（0）のときは一致と見なさない。0 同士を突き合わせると永久にキャッシュが効く
  if (cached && mark !== 0 && cached.mark === mark) {
    store.detail = cached.data;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetailIfNeeded();
    return;
  }

  const token = ++detailToken;
  if (!silent) {
    store.detail = null;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetailIfNeeded();
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
  renderDetailIfNeeded();
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
  // 詳細は「見えているものが動いたとき」だけ作り直す。毎回作り直すと、
  // 開いた <details> とスクロール位置が2秒ごとに消える
  renderDetailIfNeeded();
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
