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
      const reason = await res.json().then((j) => j?.error).catch(() => null);
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

/**
 * @param {string|null} sessionId
 * @param {'live'|'query'|'archive'} [from] 選んだ経路。store.selectedFrom の説明を参照
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
