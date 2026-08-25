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
 * GET /api/runs/:id（全部入り）は引かない。組むのに使うのは台帳の行（rows）だけ。
 * 引くと session.js と同じ作法（突き合わせ・キャッシュ・最小間隔・404 の切り分け）を
 * もう一度書くことになる。
 *
 * ## 速報は溜めない
 *
 * 出来事（run の速報）は seq の水位を進めるためだけに受ける。**画面は1件も持たない。**
 * 読み返す正本は会話ログで、それは詳細ペインの経過タブが描いている。
 *
 * **水位取りごと消してはいけない。** つなぎ直しは /api/runs/stream?from=<seq> なので、
 * 起点が 0 に戻ると、切れるたびにサーバー側のリング（最大1000件）を送り直させる。
 */

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

/**
 * モデルの欄で「自分で入力」を選んだときの札。
 *
 * **ここに置いてあるのは、起こすフォーム（層7）と実行パネル（層3）の両方が使うから。**
 * EFFORT_LABELS と同じ理由で、どちらかに書くともう片方が同じものを持つことになる。
 *
 * `__` で始めてあるのは、モデル名とぶつからないようにするため
 * （`checkModel()` が通す形は英数字と `.-_[]` なので、この札は名前として届かない）。
 */
export const MODEL_FREE = '__free__';

/**
 * モデルの <select> に並べるもの。
 *
 * 先頭は「指定しない」。**空欄＝CLI の既定**で、これは「外す」の指定でもある。
 * 末尾は「自分で入力」。サーバーが返すのは**使ったことのあるモデルだけ**なので、
 * 新しいモデルが出た初日はここからしか渡せない。
 *
 * @param {string[]} models サーバーが返した候補
 * @returns {Array<{value: string, label: string}>}
 */
export function modelOptions(models) {
  return [
    { value: '', label: '指定しない（CLI の既定）' },
    ...(models ?? []).map((v) => ({ value: v, label: v })),
    { value: MODEL_FREE, label: '自分で入力' },
  ];
}

/**
 * いまの値を欄の2つ（<select> と自由入力）へ割る。
 *
 * 候補に無い名前のときは「自分で入力」側へ倒す。倒さないと <select> が空になって、
 * **指定してあるのに指定なしに見える**（そのまま押すと黙って外れる）。
 *
 * @param {string} value いまのモデル名。空なら「指定しない」
 * @param {string[]} models サーバーが返した候補
 * @returns {{sel: string, free: string}} 欄に入れる値
 */
export function modelPick(value, models) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return { sel: '', free: '' };
  if ((models ?? []).includes(v)) return { sel: v, free: '' };
  return { sel: MODEL_FREE, free: v };
}

/**
 * 欄の2つから送る値を組む。
 *
 * 「自分で入力」を選んだまま空欄なら、指定なしと同じ（空文字）に倒す。
 * 別の値にすると、押した人から見て**空欄で押したときだけ結果が違う**ことになる。
 *
 * @param {string} sel <select> の値
 * @param {string} free 自由入力の値
 * @returns {string} モデル名。空なら「指定しない」
 */
export function modelValue(sel, free) {
  if (sel === MODEL_FREE) return typeof free === 'string' ? free.trim() : '';
  return typeof sel === 'string' ? sel.trim() : '';
}

/** 切れたあと、つなぎ直すまでの待ち。 */
const RECONNECT_MS = 3000;

/** @type {Map<string, object>} runId → 台帳の行 */
const rows = new Map();
/** @type {Map<string, string>} sessionId → runId。詳細ペインから引くための逆引き */
const bySession = new Map();

/**
 * @type {object|null} 直近の枠の使用率。**行ではなく封筒から来る**（アカウント共通の値）
 */
let rate = null;

/**
 * 受け取った出来事の最大 seq。つなぎ直すときの起点になる。
 *
 * **出来事そのものは持たないが、この数だけは進める。** 0 に戻すと
 * /api/runs/stream?from=0 になり、切れるたびにリング1000件を送り直させる。
 */
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
    // 割り込み。**撃った瞬間と、返事・時間切れで落ち着いた瞬間にだけ動く。**
    // 入れないと「割り込んでいます…」の顔のまま戻らない
    row.interrupting === true ? 'int' : '',
    // 名乗り。init の1回で入ってそれきり動かないが、**入れないと札が出ない。**
    // 起きた直後は null で、init が来た次のフレームで初めて配列になる
    (row.capabilities ?? []).length,
    // スラッシュコマンドの数。名乗りと同じ init の行で入るが、**別に数える。**
    // 片方だけ来る版があったとき、数えていないほうの札が出なくなる
    (row.slashCommands ?? []).length,
  ].join('/');
  return [row.runId, row.state, exit, row.reason ?? '', row.turns ?? '', ask, live].join(':');
}

/** 登録した相手へ配る。1人が投げても残りへ配り続ける。 */
function emit() {
  for (const fn of listeners) {
    try {
      fn();
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
 * 消えた run（HISTORY_MAX を超えて押し出されたもの）は行ごと落とす。
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
    if (gone?.sessionId && bySession.get(gone.sessionId) === runId) bySession.delete(gone.sessionId);
    changed = true;
  }

  return changed;
}

/**
 * 届いた出来事から seq の水位だけを取る。**中身は捨てる。**
 *
 * 画面は速報を1件も出さないので、溜める先が無い。それでもここを通すのは、
 * つなぎ直しの起点（/api/runs/stream?from=<seq>）がこの数そのものだから。
 * 進めるのをやめると、切れるたびにリング1000件を送り直させる。
 *
 * @param {unknown} list 速報のフレームに入っていた出来事
 */
function takeSeq(list) {
  if (!Array.isArray(list)) return;
  for (const ev of list) {
    // seq は単調増加。つなぎ直しの穴埋めで同じものが再送されるので、見た番号は捨てる
    if (!ev || !Number.isFinite(ev.seq) || ev.seq <= lastSeq) continue;
    lastSeq = ev.seq;
  }
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
    // 2つとも呼ぶ。`||` で繋ぐと短絡して、行が変わった回に枠が取り込まれない
    const rowsChanged = applyRows(data.rows);
    const rateChanged = takeRate(data.rate);
    if (rowsChanged || rateChanged) emit();
  });

  source.addEventListener('run', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    // 水位だけ取る。**配らない。** 1ターンで数百行来るので、ここで配ると
    // 詳細ペインが作り直されて、開いた <details> と入力中の caret が毎回消える
    takeSeq(data.events);
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

/**
 * 直近の枠の使用率。**行ではなくフレームの封筒から来る。**
 *
 * アカウント共通の値なので、どの実行から届いたかは意味を持たない。
 * サーバーが台帳から1つだけ取って `rate` に載せてくる。
 *
 * 出どころは `rate_limit_event` で、**この画面から起こした実行の stdout にしか流れない**
 * （会話ログにも `~/.claude` の下にも無い。キーの形で総当たりして確認・2.1.245）。
 * サーバー側が最後の1件を紙に落としているので、**一度でも起こしたことがあれば**
 * 立ち上げ直しても出る。1本も起こしたことが無ければ null。
 *
 * @returns {{fiveHour: ?number, sevenDay: ?number, resetsAt: ?number, at: number}|null}
 */
export function newestRateLimit() {
  return rate;
}

/**
 * 封筒から届いた枠を差し替える。
 *
 * @param {*} next フレームの `rate`
 * @returns {boolean} 中身が変わったか
 */
function takeRate(next) {
  const ok = next && typeof next.at === 'number' ? next : null;
  // `at` だけを見れば足りる。同じ観測なら数も同じで、違う観測なら必ず時刻が違う
  if ((rate?.at ?? null) === (ok?.at ?? null)) return false;
  rate = ok;
  return true;
}

/**
 * 何分より古い観測に「いつ測ったか」を添えるか。
 *
 * 走っているものが無ければ数は古びていくが、**古いこと自体は異常ではない。**
 * 5分は「さっき測った」と言い切れる幅で、これを超えたぶんだけ但し書きを出す。
 */
export const RATE_STALE_MS = 5 * 60_000;

/** この割合を超えたら目に入るようにする。色は `.chip.is-hot` の使い回しで、新しい色は作らない */
export const RATE_HOT = 0.9;

/**
 * 枠の使用率を、出す形まで決める。**DOM を触らない純関数。**
 *
 * 判断がここに要るのは3つ。
 *
 * - `resetsAt` を過ぎた5時間枠は**落とす。** 空いているのに古い数を今の数の顔で出さない
 *   （新しい数は次の `rate_limit_event` が来るまで分からないので、そこは黙る）
 * - 5分より古い観測には「いつ測ったか」を添える
 * - 0 は `0%` として出す。**読めなかった（不明）とは別物**
 *
 * @param {object|null|undefined} rl `newestRateLimit()` の戻り
 * @param {number} now いまの時刻（ms）
 * @returns {{fiveHour: ?string, sevenDay: ?string, age: ?string, hot: boolean,
 *            gone: boolean, at: number, resetsAt: ?number}|null} 出すものが無ければ null
 */
export function rateView(rl, now) {
  // resetsAt は**秒**の unix 時刻（実測）。ミリ秒として比べると必ず過去になる
  const resetsAt = typeof rl?.resetsAt === 'number' ? rl.resetsAt * 1000 : null;
  const gone = resetsAt !== null && now >= resetsAt;
  const five = gone ? null : rl?.fiveHour;
  const seven = rl?.sevenDay;
  const fiveHour = pct(five);
  const sevenDay = pct(seven);
  if (fiveHour === null && sevenDay === null) return null;

  const elapsed = now - rl.at;
  return {
    fiveHour,
    sevenDay,
    age: elapsed >= RATE_STALE_MS ? ageText(elapsed) : null,
    hot: [five, seven].some((v) => typeof v === 'number' && v >= RATE_HOT),
    gone,
    at: rl.at,
    resetsAt,
  };
}

/** 0〜1 の割合を百分率に。読めなければ null（**0 は 0% として出す**） */
function pct(v) {
  return typeof v === 'number' ? `${Math.round(v * 100)}%` : null;
}

/** 「いつ測ったか」。**分より細かくしない**（毎秒呼ばれるので、印が毎秒変わると止められない） */
function ageText(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

/** detail.js の detailKeyOf() に混ぜる印。 */
export function runStampFor(sessionId) {
  return stampOf(runFor(sessionId));
}

/**
 * 台帳が動いたことを受け取る。
 *
 * 呼ばれるのは stampOf の5つ（現れた・状態が変わった・終わった・許可を訊かれた
 * または答えた・設定を替えた）と、枠の使用率が動いたとき。
 * **速報1件ごとには呼ばない。** 画面が速報を1件も持たないので、配る中身が無い。
 *
 * @param {() => void} fn
 * @returns {() => void} 解除する関数
 */
export function subscribeRuns(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
