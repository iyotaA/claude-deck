/* 行の導出。
 *
 * 一覧の行・書庫の行・詳細の応答という3つの出どころから、
 * 画面が「1つの行」として扱えるものを組む。どこから来たかで見え方が変わらないようにする。
 *
 * 層2。store.js だけを見る。
 * detailErrorNow をここに置いているのは、詳細の描画側と取得側の両方が使うため。
 * どちらかに置くと、2つが互いを import することになる。
 */
import { store } from './store.js';

/** そのセッションが実際に動いている時間を、末尾の追記からの経過で出す。 */
export function idleOf(row) {
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
export function rowOf(sessionId) {
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
 * `run`（台帳の行）だけは「新しいほう」ではなく**一覧の行しか持っていない**。
 * 合流させているのが `server.mjs` の `refresh()` で、詳細の窓口は台帳を知らないため。
 * 持っていない行では `key in row` が偽になるので、書庫から開いたぶんも壊れない。
 *
 * 上書きする項目を配列で名前付けするのは、プロパティの並び順に判断を埋めないため。
 */
export const LIVE_FIELDS = [
  'state', 'stateLabel', 'ball', 'idleMs', 'lastActivityAt',
  'waitingFor', 'stateReason', 'stateConfident', 'statusRaw', 'alive', 'pid', 'run',
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
export function headOf(sessionId) {
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

/** 一覧に出す行。「稼働中だけ」を押しているあいだは終わったものを落とす */
export function visibleRows() {
  return store.onlyLive ? store.rows.filter((r) => r.alive) : store.rows;
}

/** いま選んでいるセッションの取得エラー。前のセッションのものは無関係なので出さない */
export function detailErrorNow() {
  return store.detailErrorFor === store.selected ? store.detailError : null;
}
