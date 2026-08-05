/* 画面側の状態と、その置き場所。
 *
 * 画面の節点（dom）・いま持っている状態（store）・URL への書き戻し（syncQuery）。
 * 状態を1箇所に集めておくと、どこが何を書き換えているかを追える。
 *
 * import してよいのは timeline/kinds.js だけ。**直に** import するのが要点で、
 * timeline/index.js 経由にすると index → view → store の循環になって立ち上がらない。
 */
import { initialHiddenKinds, hideQueryValue } from './timeline/kinds.js';

export const STATE_COLOR = {
  'needs-answer': 'var(--hot)',
  'needs-plan-approval': 'var(--hot)',
  'needs-approval': 'var(--hot)',
  'awaiting-reply': 'var(--warn)',
  running: 'var(--calm)',
  ended: 'var(--off)',
  unknown: 'var(--off)',
};

/** 一覧のタグに出さない権限モード。どちらも「特別なことは起きていない」を意味する。 */
export const QUIET_MODES = new Set(['auto', 'default', 'normal', 'acceptEdits']);

/**
 * 一覧の上に出すまとめ。並び順もこの順にする。
 *
 * ラベルの日本語はここに持たない。サーバが meta.stateLabels で渡してくる。
 * 状態を1つ増やしたときに、直す場所が state.mjs だけで済むようにするため。
 */
export const SUMMARY_ORDER = [
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
export const query = new URLSearchParams(location.search);

/** 書庫の並び順。サーバ側（view/archive.mjs の SORTS）と同じ語を使う */
export const ARCHIVE_SORTS = new Set(['recent', 'oldest', 'size']);

export const dom = {
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

export const store = {
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
   * 0 は「まだ整えていない」。最初の描画で1画面ぶんに直る。
   * ここに数を書かないのは、窓の大きさ（TL_FIRST / TL_MORE）を時系列側に閉じておくため
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
  /**
   * 時系列で隠している種類（拒否リスト）。
   *
   * ここだけ localStorage を見ない。開き直したら既定（足跡を隠す）に戻す。
   * 理由は timeline/kinds.js の initialHiddenKinds に書いた
   */
  hiddenKinds: initialHiddenKinds(query.get('hide')),
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

/**
 * いまの状態を URL に書き戻す。
 *
 * pushState は使わない。検索欄は1文字ごとにここを通るので、履歴が入力の回数だけ積まれ、
 * 戻るボタンが使えなくなる。replaceState なら今のアドレスだけが差し替わる。
 *
 * 触るキーは session / only / tq / hide / tab / aq / asort だけ。
 * theme と nolive は「開くときの指定」なので、こちらから書き換えない
 */
export function syncQuery() {
  const params = new URLSearchParams(location.search);
  const set = (key, value) => {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  };

  set('session', store.selected);
  set('only', store.onlyDecisions ? '1' : null);
  set('tq', store.tq);
  // 隠している種類は「既定と同じなら書かない」。空の指定（何も隠さない）は空文字のまま残す。
  // set() は空文字を消してしまうので、ここだけ直に書く。
  // 既定と同じかどうかの判断は timeline/kinds.js 側（既定の中身を知っているのはあちら）
  const hide = hideQueryValue(store.hiddenKinds);
  if (hide === null) params.delete('hide');
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
