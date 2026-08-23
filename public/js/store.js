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
 *  ?tab=archive|usage … 書庫（終了したものも含む全セッション）や数値を開いた状態にする
 *  ?aq=<語> … 書庫の検索語
 *  ?asort=recent|oldest|size … 書庫の並び順
 *  ?dtab=log|agents … 詳細ペインの中央のどのタブを開くか
 *  ?insp=usage|out|basics … 右のインスペクタをどのタブで開くか（付けなければ閉じた状態）
 */
export const query = new URLSearchParams(location.search);

/** 書庫の並び順。サーバ側（view/archive.mjs の SORTS）と同じ語を使う */
export const ARCHIVE_SORTS = new Set(['recent', 'oldest', 'size']);

/**
 * 左のペインに出せるもの。知らない値は 'live' に落とす。
 *
 * 集合で持つのは、増やしたときに三項演算子を書き換えなくて済むようにするため。
 * 以前は `=== 'archive' ? 'archive' : 'live'` と書いてあり、
 * 3つ目を足したときに黙って 'live' へ落ちる形になっていた
 */
export const TABS = new Set(['live', 'archive', 'usage']);

/**
 * 詳細ペインの中央に出せるもの。知らない値は 'now' に落とす。
 *
 * 以前は11枚のパネルを縦に積んでいた。同時に置きうる情報の塊が多すぎて、
 * いま何を見ればいいのかが分からなくなっていたので、役目で割ってある。
 * 中央は「その作業をするのに要るもの」の3つだけ。残りは右のインスペクタへ寄せた。
 *
 * TABS と同じく集合で持つ。三項演算子で二値に畳むと、増やすたびに
 * 判定と syncQuery の2箇所を直すことになる
 */
export const DETAIL_TABS = new Set(['now', 'log', 'agents']);

/**
 * 右のインスペクタに出せるもの。知らない値は null（閉じた状態）に落とす。
 *
 * 中央と分けてあるのは、この3つが「作業しながら横目で見るもの」だから。
 * 中央のタブに混ぜると、数字を見るために作業の手元（いま・経過）を隠すことになる。
 *
 * 中央から移したので `?dtab=usage` のような古い指定は DETAIL_TABS に無く、
 * 既定（いま）へ落ちる。**読み替えは入れない。** 段1 はまだ誰にも配っていないので、
 * 拾うべき古いブックマークが存在しない
 */
export const INSPECTOR_TABS = new Set(['usage', 'out', 'basics']);

export const dom = {
  app: document.getElementById('app'),
  list: document.getElementById('list'),
  listCount: document.getElementById('list-count'),
  summary: document.getElementById('summary'),
  detail: document.getElementById('detail'),
  // 中央下の入力欄の器。詳細ペインの外に置いてあるので replaceChildren() で消えない
  composer: document.getElementById('composer'),
  live: document.getElementById('live'),
  reload: document.getElementById('reload'),
  themeToggle: document.getElementById('theme-toggle'),
  onlyLive: document.getElementById('only-live'),
  listPane: document.getElementById('list-pane'),
  listToggle: document.getElementById('list-toggle'),
  listClose: document.getElementById('list-close'),
  scrim: document.getElementById('scrim'),
  // 右のインスペクタと、その開閉をするレール。detail.js だけが使う。
  // 器は index.html に置いたまま作り直さず、中身（inspBody）だけを差し替える
  insp: document.getElementById('insp'),
  inspTitle: document.getElementById('insp-title'),
  inspClose: document.getElementById('insp-close'),
  inspBody: document.getElementById('insp-body'),
  rail: document.getElementById('rail'),
  tabLive: document.getElementById('tab-live'),
  tabArchive: document.getElementById('tab-archive'),
  tabUsage: document.getElementById('tab-usage'),
  liveHead: document.getElementById('live-head'),
  archiveHead: document.getElementById('archive-head'),
  archive: document.getElementById('archive'),
  archiveQ: document.getElementById('archive-q'),
  archiveDeep: document.getElementById('archive-deep'),
  archiveSort: document.getElementById('archive-sort'),
  archiveCount: document.getElementById('archive-count'),
  // 横断の数値。usage-tab.js だけが使う
  usageHead: document.getElementById('usage-head'),
  usage: document.getElementById('usage'),
  usageDays: document.getElementById('usage-days'),
  usageLimit: document.getElementById('usage-limit'),
  usageModel: document.getElementById('usage-model'),
  usageCount: document.getElementById('usage-count'),
  // 通知の設定モーダル。settings.js だけが使う
  settings: document.getElementById('settings'),
  settingsOpen: document.getElementById('settings-open'),
  settingsClose: document.getElementById('settings-close'),
  settingsState: document.getElementById('settings-state'),
  settingsPath: document.getElementById('settings-path'),
  settingsMsg: document.getElementById('settings-msg'),
  settingsSave: document.getElementById('settings-save'),
  settingsTest: document.getElementById('settings-test'),
  setUrl: document.getElementById('set-url'),
  setUrlClear: document.getElementById('set-url-clear'),
  setUrlHint: document.getElementById('set-url-hint'),
  setSettle: document.getElementById('set-settle'),
  setIdle: document.getElementById('set-idle'),
  setRemind: document.getElementById('set-remind'),
  setDetail: document.getElementById('set-detail'),
  setStates: document.getElementById('set-states'),
  startupState: document.getElementById('startup-state'),
  startupLegacy: document.getElementById('startup-legacy'),
  startupError: document.getElementById('startup-error'),
  startupHow: document.getElementById('startup-how'),
  // セッションを起こすフォーム。run-form.js だけが使う。
  // URL には持たせない（syncQuery が触るのは session / only / tq / hide / tab / aq / asort だけ）
  runformOpen: document.getElementById('runform-open'),
  runform: document.getElementById('runform'),
  runformClose: document.getElementById('runform-close'),
  runformMsg: document.getElementById('runform-msg'),
  runformStart: document.getElementById('runform-start'),
  runformShow: document.getElementById('runform-detail'),
  runCwd: document.getElementById('run-cwd'),
  runPrompt: document.getElementById('run-prompt'),
  runMode: document.getElementById('run-mode'),
  runModel: document.getElementById('run-model'),
  runEffort: document.getElementById('run-effort'),
  runBudget: document.getElementById('run-budget'),
  runNote: document.getElementById('run-note'),
  // 更新のお知らせ。update.js だけが使う
  ver: document.getElementById('ver'),
  update: document.getElementById('update'),
  updateText: document.getElementById('update-text'),
  updateNote: document.getElementById('update-note'),
  updateAct: document.getElementById('update-act'),
  updateClose: document.getElementById('update-close'),
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
  /**
   * 選んでいるセッションの数値（/api/sessions/:id/usage の応答）。
   *
   * 詳細とは別の窓口から来る。詳細の応答に混ぜると、数値を見ない人まで
   * 詳細を開く速度が落ちるため、サーバー側で分けてある
   */
  usage: null,
  usageError: null,
  /** usageError がどのセッションのものか。detailErrorFor と同じ理由で持つ */
  usageErrorFor: null,
  /**
   * 「いつもと比べてどうか」（/api/sessions/:id/usage/baseline の応答）。
   *
   * **これも別の窓口。** 直近24本を全文読むので実測 400〜700ms 掛かり、
   * 上の usage に混ぜると数値そのものの表示が遅くなる。
   * 数値を先に出して、比較は遅れて書き足す。
   *
   * `{id, model, baseline}` をそのまま持つ。id を捨てて baseline だけにしない。
   * 捨てると、別のセッションへ移った直後に前のセッションの差が出る
   */
  usageBaseline: null,
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
   * 左のペインに出しているもの。TABS のどれか。
   *
   * localStorage には残さない。書庫や数値を開いたまま保存すると、次に開いたときに
   * 「誰が待っているか」が見えない状態で始まってしまう。
   * 固定したい人は ?tab=archive のようにブックマークする
   */
  tab: TABS.has(query.get('tab')) ? query.get('tab') : 'live',
  /**
   * 詳細ペインの中央に出しているタブ。DETAIL_TABS のどれか。
   *
   * localStorage には残さない（tab と同じ理由）。
   * セッションを選び直しても戻さない。見たいものは人ごとに決まっていて、
   * セッションごとに変わるものではないため
   */
  detailTab: DETAIL_TABS.has(query.get('dtab')) ? query.get('dtab') : 'now',
  /**
   * 右のインスペクタ。INSPECTOR_TABS のどれか、または null で閉じている。
   *
   * **開閉と「どれを見ているか」を1つの値で持つ。** 2つに分けると
   * 「開いているのにどのタブも選んでいない」という組み合わせが作れてしまい、
   * そこへ落ちたときに空の枠だけが右に残る。
   * レールは同じボタンをもう一度押すと閉じるので、その形が素直に書ける
   */
  inspector: INSPECTOR_TABS.has(query.get('insp')) ? query.get('insp') : null,
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
  /**
   * 数値タブ（横断集計）の状態。
   *
   * **1本ぶんの store.usage とは別物。** あちらは開いているセッション1本
   * （/api/sessions/:id/usage）で、こちらは複数セッションを跨いだ集計（/api/usage）。
   * 名前が似ているので、片方だけを直して片方を忘れないよう気をつける
   */
  usageTab: {
    /** 応答そのまま。null は「まだ引けていない」 */
    data: null,
    /**
     * モデルの絞り込みの選択肢。
     *
     * **絞り込んでいない応答からだけ拾う。** モデルを指定して引くと
     * 応答の models は1種しか返らないので、そこから作り直すと
     * 「すべて」に戻す以外の選択肢が消えてしまう
     */
    modelOptions: [],
    limit: 30,
    /** 期間（日）。null は「絞らない」。0 は作らない */
    days: null,
    /** モデルの絞り込み。null は「すべて」 */
    model: null,
    loading: false,
    error: null,
    /** 1度でも引けたか。「まだ引いていない」と「0件だった」を区別するため */
    loaded: false,
    /** サーバ側がまだ横断集計に対応していない（404）。静かに退く */
    unavailable: false,
  },
  /**
   * 更新の状態（/api/update の応答）。null は「まだ引けていない」。
   *
   * 判断はサーバ側（src/update/state.mjs）で済んでいるので、ここは受け取った形を持つだけ。
   * 例外は「サーバが古くて窓口ごと無い」（404）ときで、そこだけ update.js が同じ形を組んで入れる。
   * SSE では来ない（毎秒の押し出しに混ぜる値ではない）ので、update.js が自分で引く
   */
  update: null,
};

/**
 * いまの状態を URL に書き戻す。
 *
 * pushState は使わない。検索欄は1文字ごとにここを通るので、履歴が入力の回数だけ積まれ、
 * 戻るボタンが使えなくなる。replaceState なら今のアドレスだけが差し替わる。
 *
 * 触るキーは session / only / tq / hide / tab / aq / asort / dtab / insp だけ。
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
  // 既定（稼働中）のときだけキーを落とす。3値になったので三項では書かない
  set('tab', store.tab === 'live' ? null : store.tab);
  set('aq', store.tab === 'archive' ? store.archive.q : null);
  // 既定の並び順はキーを付けない。URL を短く保ち、既定が変わったときに古い指定が残らないため
  set('asort', store.tab === 'archive' && store.archive.sort !== 'recent' ? store.archive.sort : null);
  // 既定（いま）のときだけキーを落とす。tab と同じ扱い
  set('dtab', store.detailTab === 'now' ? null : store.detailTab);
  // 閉じているときはキーを付けない。null は set() が消してくれる
  set('insp', store.inspector);

  const qs = params.toString();
  const next = qs ? `${location.pathname}?${qs}` : location.pathname;
  // 中身が同じなら書き換えない。一覧の push ごとにここを通るので、無駄な履歴操作を避ける
  if (next === `${location.pathname}${location.search}`) return;
  history.replaceState(null, '', next);
}
