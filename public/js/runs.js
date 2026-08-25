/* 画面から起こした実行の保持と、専用 SSE の購読。
 *
 * 層2。util.js（層0）しか見ない。store.js も見ない。
 * 実行の状態は一覧（store.rows）とは**別の窓口**から来るので、混ぜる理由が無い。
 *
 * ## 描画側を import しない
 *
 * ここが run-view.js を知ると run-view(3) → runs(2) → run-view(3) の循環になる。
 * 呼びたくなったら subscribeRuns(fn) で外から登録する。
 * 配線するのは main.js（層8）の役目で、既存の循環4箇所には触らない。
 *
 * ## 取り口を増やさない
 *
 * GET /api/runs/:id（全部入り）は引かない。台帳の行（rows）と速報（events）だけで組む。
 * 引くと session.js と同じ作法（突き合わせ・キャッシュ・最小間隔・404 の切り分け）を
 * もう一度書くことになる。費用や往復数は result の出来事に載っているので、そちらから拾える。
 */

/**
 * run 1本あたり画面に残す出来事の数。
 *
 * サーバー側のリングバッファ（EVENT_MAX = 1000）より小さくしてある。
 * 画面は「いま何が起きているか」を見るためのもので、読み返す正本は会話ログのほう。
 */
export const EVENTS_PER_RUN = 400;

/**
 * 思考量の言い方。
 *
 * **ここに置いてあるのは、起こすフォーム（層7）と実行パネル（層3）の両方が使うから。**
 * どちらかに書くともう片方が同じものを持つことになり、必ず片方が古くなる。
 * 語彙そのもの（どの値が使えるか）はサーバーの `/api/runs/options` が返すので、
 * ここにあるのは名前だけ。知らない値が来たらその値をそのまま出す。
 */
export const EFFORT_LABELS = {
  low: 'low（浅く速く）',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max（いちばん深い）',
};

/** 切れたあと、つなぎ直すまでの待ち。 */
const RECONNECT_MS = 3000;

/** @type {Map<string, object>} runId → 台帳の行 */
const rows = new Map();
/** @type {Map<string, string>} sessionId → runId。詳細ペインから引くための逆引き */
const bySession = new Map();
/** @type {Map<string, Array<object>>} runId → 出来事 */
const events = new Map();
/** @type {Map<string, number>} runId → 溢れて捨てた件数 */
const dropped = new Map();

/** つなぎ直しのあいだにサーバー側で押し出された件数。累積で持つ */
let missed = 0;
/** 受け取った出来事の最大 seq。つなぎ直すときの起点になる */
let lastSeq = 0;

let source = null;
let timer = null;

const listeners = new Set();

/**
 * 行のうち、詳細ペインの作りに影響する値だけを1本の文字列にする。
 *
 * **出来事が増えただけでは動かない。** 動くのは「現れた」「状態が変わった」「終わった」
 * 「許可を訊かれた・答えた」「設定を替えた」の5つ。
 * detail.js の detailKeyOf() がこれを見るので、速報のたびに詳細ペインを作り直すと
 * 開いた <details> と入力中の caret が消える。
 *
 * @param {object|null} row 台帳の行
 */
function stampOf(row) {
  if (!row) return '';
  // exitCode は 0 が正常終了なので、?? '' で落とさない（0 と不明を分ける）
  const exit = row.exitCode === null || row.exitCode === undefined ? '' : String(row.exitCode);
  // 許可要求は1件目の id だけ見る。**来た瞬間と消えた瞬間にだけ動く値**なので、
  // 速報が数百行来ても作り直しは起きない（この関数の性質はそのまま保たれる）
  const ask = row.asks?.[0]?.id ?? '';
  // 子を殺さずに替えたぶん。**撃った瞬間と、受理・拒否・時間切れで落ち着いた瞬間にだけ動く。**
  // 入れないと、替わったのに切り替えの欄が古い値のままになり、
  // 「替えています…」が消えないまま残る（消す権利は行の側にある）
  const live = [
    row.permissionMode ?? '',
    row.model ?? '',
    (row.switching ?? []).map((c) => c.field).join('+'),
  ].join('/');
  return [row.runId, row.state, exit, row.reason ?? '', row.turns ?? '', ask, live].join(':');
}

/** 登録した相手へ配る。1人が投げても残りへ配り続ける。 */
function emit(kind) {
  for (const fn of listeners) {
    try {
      fn(kind);
    } catch (err) {
      // 画面側の落ち度で SSE の受け口を止めない
      console.error('runs listener', err);
    }
  }
}

/**
 * 台帳の行をまるごと入れ替える。
 *
 * サーバーは rows() を毎回まるごと送ってくるので、こちらも差分ではなく総入れ替えにする。
 * 消えた run（HISTORY_MAX を超えて押し出されたもの）は出来事ごと落とす。
 *
 * @returns {boolean} 画面の作りに影響する変化があったか
 */
function applyRows(list) {
  if (!Array.isArray(list)) return false;

  const seen = new Set();
  let changed = false;

  for (const row of list) {
    if (!row || typeof row.runId !== 'string') continue;
    seen.add(row.runId);
    if (stampOf(rows.get(row.runId)) !== stampOf(row)) changed = true;
    rows.set(row.runId, row);
    if (typeof row.sessionId === 'string' && row.sessionId) bySession.set(row.sessionId, row.runId);
  }

  for (const runId of [...rows.keys()]) {
    if (seen.has(runId)) continue;
    const gone = rows.get(runId);
    rows.delete(runId);
    events.delete(runId);
    dropped.delete(runId);
    if (gone?.sessionId && bySession.get(gone.sessionId) === runId) bySession.delete(gone.sessionId);
    changed = true;
  }

  return changed;
}

/**
 * 届いた出来事を積む。
 *
 * @returns {boolean} 1件でも積んだか
 */
function pushEvents(list) {
  if (!Array.isArray(list) || list.length === 0) return false;

  let added = false;
  for (const ev of list) {
    // seq は単調増加。つなぎ直しの穴埋めで同じものが再送されるので、見た番号は捨てる
    if (!ev || !Number.isFinite(ev.seq) || ev.seq <= lastSeq) continue;
    lastSeq = ev.seq;

    const runId = typeof ev.runId === 'string' ? ev.runId : null;
    if (!runId) continue;

    const bucket = events.get(runId) ?? [];
    bucket.push(ev);
    while (bucket.length > EVENTS_PER_RUN) {
      bucket.shift();
      dropped.set(runId, (dropped.get(runId) ?? 0) + 1);
    }
    events.set(runId, bucket);
    added = true;
  }
  return added;
}

/** SSE をつなぐ。切れたら自分で張り直す。 */
function open() {
  timer = null;
  try {
    // from を URL に載せるので、EventSource の自動再接続には任せられない
    // （あれは最初の URL のまま繋ぎ直すため、lastSeq が反映されない）
    source = new EventSource(`/api/runs/stream?from=${lastSeq}`);
  } catch {
    // SSE が使えない環境。実行の速報だけ諦める（一覧と詳細は別の経路で動く）
    source = null;
    return;
  }

  source.addEventListener('runs', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return; // 壊れたフレームは黙って捨てる（未知の形で落ちない）
    }
    const changed = applyRows(data.rows);
    if (Number.isFinite(data.missed) && data.missed > 0) missed += data.missed;
    if (changed) emit('rows');
  });

  source.addEventListener('run', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (pushEvents(data.events)) emit('events');
  });

  source.addEventListener('error', () => {
    if (!source) return;
    source.close();
    source = null;
    if (timer === null) timer = setTimeout(open, RECONNECT_MS);
  });
}

/** つなぎ始める。二重に呼ばれても1本しか張らない。 */
export function initRuns() {
  if (source || timer !== null) return;
  open();
}

/**
 * そのセッションを起こした実行の行。
 *
 * @param {string|null} sessionId
 * @returns {object|null} 台帳の行。この画面から起こしたものでなければ null
 */
export function runFor(sessionId) {
  if (!sessionId) return null;
  const runId = bySession.get(sessionId);
  return runId ? (rows.get(runId) ?? null) : null;
}

/** 実行1本ぶんの出来事。無ければ空配列。 */
export function eventsOf(runId) {
  return runId ? (events.get(runId) ?? []) : [];
}

/** 溢れて画面から落とした件数。黙って捨てないための数。 */
export function droppedOf(runId) {
  return runId ? (dropped.get(runId) ?? 0) : 0;
}

/** つなぎ直しのあいだに取りこぼした件数（全体）。 */
export function runsMissed() {
  return missed;
}

/** detail.js の detailKeyOf() に混ぜる印。 */
export function runStampFor(sessionId) {
  return stampOf(runFor(sessionId));
}

/**
 * 変化を受け取る。
 *
 * kind は 'rows'（台帳が動いた）か 'events'（速報が届いた）。
 * 受け取る側がこの2つを分けて扱えるようにしてある。
 * 前者は詳細ペインの作り直し、後者はパネルの中への追記で足りる。
 *
 * @param {(kind: 'rows'|'events') => void} fn
 * @returns {() => void} 解除する関数
 */
export function subscribeRuns(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
