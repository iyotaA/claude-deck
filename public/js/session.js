/* 詳細の取得・保持・選択。
 *
 * 層5。詳細の描画（detail.js）を呼ぶので、あちらより下に置く。
 * detailErrorNow は rows.js 側に置いてある。描画側と取得側の両方が使うため、
 * どちらかに置くと2つが互いを import することになる。
 */
import { dom, store, syncQuery } from './store.js';
import { rowOf } from './rows.js';
import { renderDetailIfNeeded } from './detail.js';

/** sessionId から {mark, data}。mark が変わっていなければ再取得しない */
export const detailCache = new Map();
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

export async function loadDetail(sessionId, { silent = false } = {}) {
  if (!sessionId) {
    store.detail = null;
    renderDetailIfNeeded();
    return;
  }

  // 数値は別の窓口なので、詳細と並べて取りに行く。詳細の到着を待たない
  // （待つと、キャッシュが効いた詳細のときだけ数値が遅れて出ることになる）。
  // 失敗しても詳細の表示は続けるので、ここで拾って捨てる
  loadUsage(sessionId).catch(() => {});
  // 比較（中央値との差）はさらに別。直近24本を読むので数値より遅れて着く。
  // 待たせないために、数値と並べて撃って先に着いたほうから画面へ出す
  loadUsageBaseline(sessionId).catch(() => {});

  // 名前を cacheMark にしてあるのは、perf.js の mark()（描画時間の記録）を隠さないため。
  // 時系列側からも mark() を呼ぶので、隠すと気づきにくい事故になる
  const cacheMark = detailStampOf(sessionId);
  const cached = detailCache.get(sessionId);
  // 目印が不明（0）のときは一致と見なさない。0 同士を突き合わせると永久にキャッシュが効く
  if (cached && cacheMark !== 0 && cached.mark === cacheMark) {
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
      const reason = await res.json().then((j) => j?.reason ?? j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 選び直したあとに古い応答が届いても無視する
    if (token !== detailToken || store.selected !== sessionId) return;
    // 目印は一覧の logSize を優先し、無ければ取れた詳細の大きさで代える。
    // ここで不明（0）のまま入れると、次の push で必ず取り直しになる
    detailCache.set(sessionId, { mark: cacheMark || data.log?.size || 0, data });
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

/* ------------------------------------------------------------------ 数値 */

/** 数値のキャッシュ。詳細と同じく logSize を印にする */
const usageCache = new Map();
const USAGE_CACHE_MAX = 8;
let usageToken = 0;

/**
 * 同じセッションを続けて見ているあいだの、取り直しの最小間隔。
 *
 * loadDetail は SSE の push のたび（およそ2秒ごと）走る。数値はログを全文読んで
 * 集計するので、そこへ素で相乗りすると稼働中のセッションを開いているあいだ
 * ずっと重い処理が回る。集計値は15秒古くても見え方が変わらない。
 */
const USAGE_MIN_INTERVAL_MS = 15000;
let usageAt = { id: null, at: 0 };

/**
 * 窓口そのものが無いと分かったら立てる。
 *
 * 更新の前後で、画面だけ新しくサーバーが古いことがある。
 * そのとき詳細を開くたびに 404 を撃っても得るものが無いので、一度で諦める
 */
let usageUnavailable = false;

/**
 * そのセッションの数値を取る。
 *
 * 取れなかったときは黙って退く（パネルごと出ない）。数値はおまけで、
 * これが出ないことで詳細が読めなくなるわけではない。
 *
 * @param {string} sessionId
 */
export async function loadUsage(sessionId) {
  if (!sessionId || usageUnavailable) return;

  const cacheMark = detailStampOf(sessionId);
  const cached = usageCache.get(sessionId);
  // 詳細と同じく、目印が不明（0）のときは一致と見なさない
  if (cached && cacheMark !== 0 && cached.mark === cacheMark) {
    store.usage = cached.data;
    store.usageError = null;
    store.usageErrorFor = null;
    renderDetailIfNeeded();
    return;
  }

  // 別のセッションへ移ったときは間隔を空けない。
  // 選んだ直後に数字が出ないと、そのセッションには数値が無いのだと読まれる
  const now = Date.now();
  if (usageAt.id === sessionId && now - usageAt.at < USAGE_MIN_INTERVAL_MS) return;
  usageAt = { id: sessionId, at: now };

  const token = ++usageToken;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/usage`, { cache: 'no-store' });

    if (res.status === 404) {
      // 404 は2通りある。セッションが無い（サーバーが理由を JSON で返す）と、
      // 窓口が無い（静的配信まで落ちるので JSON ではない）。後者だけ諦める
      //
      // **`reason` と `error` の両方を見る。** サーバーの断りは `{ok:false, reason}` に
      // 揃えたが、更新の途中では「画面は新しく、サーバーは古い」状態が実在する。
      // 古い側は `{error}` を返すので、片方だけ見ると理由が読めず
      // 「窓口ごと無い」と誤判定して数値を永久に諦める。
      // **外してよいのは、古い版が手元から消えたと言い切れるようになってから。**
      const body = await res.json().catch(() => null);
      if (!body?.reason && !body?.error) usageUnavailable = true;
      if (token !== usageToken || store.selected !== sessionId) return;
      store.usage = null;
      store.usageError = null;
      store.usageErrorFor = null;
      renderDetailIfNeeded();
      return;
    }

    if (!res.ok) {
      const reason = await res.json().then((j) => j?.reason ?? j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (token !== usageToken || store.selected !== sessionId) return;
    usageCache.set(sessionId, { mark: cacheMark || data.logSize || 0, data });
    if (usageCache.size > USAGE_CACHE_MAX) {
      usageCache.delete(usageCache.keys().next().value);
    }
    store.usage = data;
    store.usageError = null;
    store.usageErrorFor = null;
  } catch (err) {
    if (token !== usageToken) return;
    store.usage = null;
    store.usageError = err.message;
    store.usageErrorFor = sessionId;
  }
  renderDetailIfNeeded();
}

/* -------------------------------------------------- いつもと比べてどうか */

/**
 * 比較の取り直し間隔。**数値そのもの（15秒）よりずっと長い。**
 *
 * 中央値は直近24本を全文読んで出すので、実測 400〜700ms 掛かる。
 * しかも「直近24本の真ん中」は数分では動かない。取り直す価値がほとんど無い。
 */
const BASELINE_MIN_INTERVAL_MS = 300000;
let baselineAt = { id: null, at: 0 };
let baselineToken = 0;

/** 数値と同じく、窓口ごと無いと分かったら一度で諦める */
let baselineUnavailable = false;

/**
 * そのセッションの「直近の中央値との差」を取る。
 *
 * **失敗しても何も言わない。** 差は添え物で、無くても数値は読める。
 * ここでエラーを出すと、数値パネルの主役（何が文脈を食っているか）から目が逸れる。
 *
 * @param {string} sessionId
 */
export async function loadUsageBaseline(sessionId) {
  if (!sessionId) return;

  // 別のセッションへ移ったら、前のセッションの差を残さない。
  // 残すと、まだ引けていないあいだ**他人の中央値との差**が出ることになる
  if (store.usageBaseline && store.usageBaseline.id !== sessionId) store.usageBaseline = null;
  if (baselineUnavailable) return;

  // 別のセッションへ移ったときは間隔を空けない（数値側と同じ考え方）
  const now = Date.now();
  if (baselineAt.id === sessionId && now - baselineAt.at < BASELINE_MIN_INTERVAL_MS) return;
  baselineAt = { id: sessionId, at: now };

  const token = ++baselineToken;
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/usage/baseline`, { cache: 'no-store' });

    if (res.status === 404) {
      // 数値側と同じ切り分け。JSON で理由が返るならセッションが無いだけ、
      // 返らないなら窓口ごと無い（サーバーが古い）
      const body = await res.json().catch(() => null);
      if (!body?.reason && !body?.error) baselineUnavailable = true;
      if (token !== baselineToken || store.selected !== sessionId) return;
      store.usageBaseline = null;
      renderDetailIfNeeded();
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    if (token !== baselineToken || store.selected !== sessionId) return;
    store.usageBaseline = data;
    renderDetailIfNeeded();
  } catch {
    // 黙って退く。次に開いたときにまた試す
  }
}

/**
 * @param {string|null} sessionId
 * @param {'live'|'query'|'archive'|'usage'} [from] 選んだ経路。store.selectedFrom の説明を参照。
 *   'live' 以外は、一覧から消えても選択を外さない（stream.js が見ている）
 */
export function select(sessionId, from = 'live') {
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
